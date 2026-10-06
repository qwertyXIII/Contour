import { inSet } from '../dns/lists.ts';
import { isPrivateV4 } from '../inlets/fence.ts';
import type { Policy, PhonePlan } from './plan.ts';
import type { ShareStore } from './store.ts';

/**
 * Правила раздачи для Shadowrocket: заблокированное — через Contour, остальное —
 * напрямую из той сети, где телефон. Спрашивать сервер по каждому соединению
 * клиент не умеет, поэтому решение уезжает на телефон списком, который сам
 * обновляется.
 *
 * Те же правила, что у прокси, DNS и шлюза, — из движка (`rules/`, план —
 * `plan.ts`): свой и общий список, выученное «через VPN», ручные решения,
 * подсети сервисов, что ходят по адресам (голос Discord, Telegram), свои списки.
 * Выученное — история посещений дома, поэтому правила отдаются только по
 * токену устройства.
 *
 * Формат — по справке Shadowrocket (github.com/LOWERTOP/Shadowrocket):
 * - `DOMAIN-SET` — файл без типов правил, `.example.com` — сам сайт и поддомены;
 * - правила идут сверху вниз, доменные — раньше адресных: исключения (имя не
 *   как у родителя) поэтому стоят первыми;
 * - `IP-CIDR …,no-resolve` — только соединениям по адресу: иначе телефон
 *   спрашивал бы DNS о каждом сайте, чтобы сверить его адрес с подсетями;
 * - `update-url` — откуда конфиг обновляется сам.
 */

/**
 * Отказ на самом телефоне. Пробы Meta `…-netseer-ipaddr-assoc.xy.fbcdn.net`:
 * Instagram шлёт их раз в секунду, адресов IPv4 у них нет — ни один выход их не
 * откроет, а каждая попытка — строка в журнале края и Contour (живьём 2026-10-02:
 * 177 пар за две минуты). Instagram от отказа не страдает: он его и так получал,
 * только по таймауту.
 */
const REJECT_KEYWORDS = ['netseer-ipaddr-assoc'];

/** Без поддоменов того, что уже в списке: `.example.com` в наборе и так берёт их. */
export function collapse(names: Iterable<string>): string[] {
  const all = new Set(names);
  return [...all].filter((n) => {
    const dot = n.indexOf('.');
    return dot < 0 || !inSet(n.slice(dot + 1), all);
  }).sort();
}

export function domainSetText(names: string[], what = 'сайты через VPN'): string {
  return `# Contour: ${what}, ${names.length}\n${names.map((n) => `.${n}`).join('\n')}\n`;
}

/** Узел Shadowrocket для обычного выхода — имя из ссылки сервера (`links.ts`); правила зовут его по имени. */
export const SHARE_NODE = 'Contour';
export const countryNode = (code: string): string => `${SHARE_NODE}-${code}`;

const REGIONS = new Intl.DisplayNames(['ru'], { type: 'region' });
/** Страна по-русски: «Россия», «Германия»; запятая и «=» — разделители конфига, их нет в имени. */
export const countryTitle = (code: string): string => (REGIONS.of(code) ?? code).replace(/[,=]/g, ' ');
/** Группа на главной Shadowrocket — названием страны: «там — напрямую, уехал — через выход в стране». */
export const countryGroup = countryTitle;

export type ConfInput = {
  /** `https://contour.example.ru/list/<токен>` — без «/» в конце. */
  base: string;
  device: string;
  /** Правила телефона из движка (`plan.ts`). */
  plan: PhonePlan;
  /** Страны, открытые телефону: своя группа на каждую. */
  countries: string[];
};

/** Имя политики в конфиге: узел Contour, DIRECT, REJECT или группа страны. */
/**
 * Частные подсети правил, которым нужен Contour (корпоративная сеть «только через
 * выход»), — маршрутами в туннель. Shadowrocket по умолчанию выпускает все частные
 * сети мимо туннеля (`tun-excluded-routes`: 10/8, 172.16/12, 192.168/16…), и до
 * правила `IP-CIDR` такой адрес не доходит — уходит к роутеру той сети, где
 * устройство (живьём 2026-10-06: мак вне дома, `172.16.42.5` — через `en0`).
 * Исключения не трогаем — своя локальная сеть и дальше мимо туннеля; узкий
 * `tun-included-routes` сильнее широкого исключения (справка Shadowrocket).
 */
function includedRoutes(plan: PhonePlan): string[] {
  const nets = plan.nets.filter((n) => n.policy.kind !== 'direct' && isPrivateV4(n.cidr.split('/')[0] as string)).map((n) => n.cidr);
  return nets.length > 0 ? [`tun-included-routes = ${nets.join(', ')}`] : [];
}

function policyName(p: Policy): string {
  if (p.kind === 'contour') return SHARE_NODE;
  if (p.kind === 'country') return countryGroup(p.code);
  return p.kind === 'reject' ? 'REJECT' : 'DIRECT';
}

/**
 * Конфиг Shadowrocket. Узлы правила зовут по имени, а не `PROXY` («выбранный на
 * главной»): выбери на главной «Contour-RU» — заблокированное всё равно пойдёт
 * через «Contour», а не через Россию.
 *
 * Страна — группа `select` с двумя путями: «напрямую» (ты в этой стране — её
 * сайты и так видят местный адрес) и «Contour-XX» (уехал — через выход в
 * стране). Так решил владелец 2026-10-02: «уехал за границу — переключил на
 * Россию и всё». В группу ведут список страны (готовый, свои сайты, правила
 * «через страну») и `GEOIP` — адрес сайта в этой стране: банков в общих
 * списках нет, а живут они дома. Пустой список не зовём.
 *
 * Порядок — как у движка (`plan.ts`): исключения отдельными строками, потом
 * наборы, потом подсети, потом страны.
 */
export function shadowrocketConf(input: ConfInput): string {
  const { plan, base } = input;
  const set = (file: string, names: string[], policy: string): string[] => (names.length > 0 ? [`DOMAIN-SET,${base}/${file},${policy}`] : []);
  return [
    `# Contour — правила для «${input.device}»: заблокированное через Contour, остальное напрямую.`,
    '# Обновляются сами (update-url ниже); правка руками здесь пропадёт при обновлении.',
    '[General]',
    'dns-server = system',
    'fallback-dns-server = system',
    'ipv6 = false',
    // QUIC через туннель хуже TCP (UDP внутри OpenVPN по TCP) — пусть приложения сразу идут по TCP.
    'block-quic = all-proxy',
    'udp-policy-not-supported-behaviour = REJECT',
    // Не разрешилось имя «прямого» сайта — не уводить его через Contour: местные
    // сервисы за чужим выходом не работают (Госуслуги, Альфа — живьём 2026-10-02).
    'dns-direct-fallback-proxy = false',
    ...includedRoutes(plan),
    `update-url = ${base}/contour.conf`,
    '',
    ...(input.countries.length > 0 ? ['[Proxy Group]', ...input.countries.map((c) => `${countryGroup(c)} = select,DIRECT,${countryNode(c)}`), ''] : []),
    '[Rule]',
    ...REJECT_KEYWORDS.map((k) => `DOMAIN-KEYWORD,${k},REJECT`),
    ...plan.exceptions.map((e) => `${e.exact ? 'DOMAIN' : 'DOMAIN-SUFFIX'},${e.name},${policyName(e.policy)}`),
    ...set('reject.list', plan.reject, 'REJECT'),
    `DOMAIN-SET,${base}/domains.list,${SHARE_NODE}`,
    ...set('direct.list', plan.direct, 'DIRECT'),
    ...plan.nets.map((n) => `IP-CIDR,${n.cidr},${policyName(n.policy)},no-resolve`),
    ...input.countries.flatMap((c) => [...set(`country-${c.toLowerCase()}.list`, plan.country[c] ?? [], countryGroup(c)), `GEOIP,${c},${countryGroup(c)}`]),
    'FINAL,DIRECT',
    '',
  ].join('\n');
}

export type RulesOptions = {
  /** Свои сайты стран (панель) — из хранилища раздачи. */
  store: Pick<ShareStore, 'settings'>;
  /** Готовый список страны — у книги правил (`RuleBook.countryList`): качается один раз на весь Contour. */
  countryList: (code: string) => string[];
};

/**
 * Числа стран для панели: сколько в готовом списке (у книги правил) и какие
 * свои сайты из панели. Правила телефона — из движка (`plan.ts`).
 */
export class ShareRules {
  private readonly store: RulesOptions['store'];
  private readonly countryList: RulesOptions['countryList'];

  constructor(opts: RulesOptions) {
    this.store = opts.store;
    this.countryList = opts.countryList;
  }

  /** Сайты «только с адресом этой страны»: готовый список и свои из панели. */
  countryNames(code: string): { names: string[]; common: number; own: string[] } {
    const own = this.store.settings().countrySites[code] ?? [];
    const common = this.countryList(code);
    return { names: collapse([...common, ...own]), common: common.length, own };
  }
}
