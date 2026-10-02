import { readFileSync } from 'node:fs';
import path from 'node:path';
import { formatCidr, parseCidr, parseCidrList, type Cidr } from '../cidr.ts';
import { inSet } from '../dns/lists.ts';
import type { OverrideMap } from '../dns/overrides.ts';
import { pickSubnets, SUBNETS_FILE } from '../dns/subnets.ts';
import { COUNTRY_LISTS } from '../config-lists.ts';
import { parseList } from '../dns/lists.ts';
import { RemoteList } from '../dns/remote-list.ts';
import type { Logger } from '../log.ts';
import type { Sites } from '../panel/sites.ts';
import type { ShareStore } from './store.ts';

/**
 * Правила раздачи для Shadowrocket: заблокированное — через Contour, остальное —
 * напрямую из той сети, где телефон. Спрашивать сервер по каждому соединению
 * клиент не умеет, поэтому решение уезжает на телефон списком, который сам
 * обновляется.
 *
 * Те же данные, что у DNS дома: свой список, общий, выученное «через VPN»,
 * ручные решения из панели (`Sites`), плюс подсети сервисов, что ходят по
 * адресам (голос Discord, Telegram), — как у шлюза. Выученное — история
 * посещений дома, поэтому правила отдаются только по токену устройства.
 *
 * Формат — по справке Shadowrocket (github.com/LOWERTOP/Shadowrocket):
 * - `DOMAIN-SET` — файл без типов правил, `.example.com` — сам сайт и поддомены;
 * - правила идут сверху вниз, доменные — раньше адресных; ручное «напрямую»
 *   поэтому стоит первым и перебивает список;
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

/** Сайты через Contour и ручные «напрямую»: без поддоменов того, что уже в списке, и без того, что владелец увёл напрямую. */
export function shareDomains(input: { own: string[]; common: string[]; learned: string[]; overrides: OverrideMap }): { tunnel: string[]; direct: string[] } {
  const direct = Object.entries(input.overrides).filter(([, v]) => v === 'direct').map(([k]) => k).sort();
  const directSet = new Set(direct);
  const forced = Object.entries(input.overrides).filter(([, v]) => v === 'tunnel').map(([k]) => k);
  const all = [...input.own, ...input.common, ...input.learned, ...forced].filter((n) => !inSet(n, directSet));
  return { tunnel: collapse(all), direct };
}

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
  direct: string[];
  nets: string[];
  /** Страны, открытые телефону: своя группа на каждую; `sites` — сколько в её списке (пустой список не зовём). */
  countries: Array<{ code: string; sites: number }>;
};

/**
 * Конфиг Shadowrocket. Узлы правила зовут по имени, а не `PROXY` («выбранный на
 * главной»): выбери на главной «Contour-RU» — заблокированное всё равно пойдёт
 * через «Contour», а не через Россию.
 *
 * Страна — группа `select` с двумя путями: «напрямую» (ты в этой стране — её
 * сайты и так видят местный адрес) и «Contour-XX» (уехал — через выход в
 * стране). Так решил владелец 2026-10-02: «уехал за границу — переключил на
 * Россию и всё». В группу ведут список страны (готовый и свои сайты) и `GEOIP` —
 * адрес сайта в этой стране: банков в общих списках нет, а живут они дома.
 */
export function shadowrocketConf(input: ConfInput): string {
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
    // Не разрешилось имя «прямого» сайта — не уводить его через дом: российские
    // сервисы за заграничным выходом не работают (Госуслуги, Альфа — живьём 2026-10-02).
    'dns-direct-fallback-proxy = false',
    `update-url = ${input.base}/contour.conf`,
    '',
    ...(input.countries.length > 0 ? ['[Proxy Group]', ...input.countries.map((c) => `${countryGroup(c.code)} = select,DIRECT,${countryNode(c.code)}`), ''] : []),
    '[Rule]',
    ...REJECT_KEYWORDS.map((k) => `DOMAIN-KEYWORD,${k},REJECT`),
    ...input.direct.map((n) => `DOMAIN-SUFFIX,${n},DIRECT`),
    `DOMAIN-SET,${input.base}/domains.list,${SHARE_NODE}`,
    ...input.nets.map((c) => `IP-CIDR,${c},${SHARE_NODE},no-resolve`),
    ...input.countries.flatMap((c) => [
      ...(c.sites > 0 ? [`DOMAIN-SET,${input.base}/country-${c.code.toLowerCase()}.list,${countryGroup(c.code)}`] : []),
      `GEOIP,${c.code},${countryGroup(c.code)}`,
    ]),
    'FINAL,DIRECT',
    '',
  ].join('\n');
}

export type RulesOptions = {
  sites: Sites;
  dnsDir: string;
  skip: string[];
  /** Свои сайты стран (панель) — из хранилища раздачи. */
  store: Pick<ShareStore, 'settings'>;
  /** Где держать копии списков стран (папка раздачи). */
  dir: string;
  log: Logger;
};

/**
 * Данные правил: папка DNS (`Sites`), копия списков подсетей, списки стран по
 * ссылкам (`COUNTRY_LISTS`: Россия — itdoginfo «Russia outside») и свои сайты
 * стран из панели. Список страны качается, когда страна впервые понадобилась
 * (панель, телефон): страны выходов меняются на ходу, а сервер в Нидерландах
 * без российского выхода российский список не качает вовсе.
 */
export class ShareRules {
  private readonly sites: Sites;
  private readonly dnsDir: string;
  private readonly skip: Cidr[];
  private readonly store: RulesOptions['store'];
  private readonly lists = new Map<string, { remote: RemoteList<string>; held: { names: string[] } }>();
  private readonly dir: string;
  private readonly log: Logger;
  private started = false;

  constructor(opts: RulesOptions) {
    this.sites = opts.sites;
    this.dnsDir = opts.dnsDir;
    this.skip = opts.skip.map((s) => parseCidr(s)).filter((c): c is Cidr => c !== null);
    this.store = opts.store;
    this.dir = opts.dir;
    this.log = opts.log;
  }

  start(): void {
    this.started = true;
    for (const l of this.lists.values()) l.remote.start();
  }

  stop(): void {
    this.started = false;
    for (const l of this.lists.values()) l.remote.stop();
  }

  /** Сайты «только с адресом этой страны»: готовый список и свои из панели. */
  countryNames(code: string): { names: string[]; common: number; own: string[] } {
    const own = this.store.settings().countrySites[code] ?? [];
    const common = this.list(code)?.names ?? [];
    return { names: collapse([...common, ...own]), common: common.length, own };
  }

  /** Готовый список страны: первый спрос читает копию с диска и ставит скачивание. */
  private list(code: string): { names: string[] } | null {
    const urls = COUNTRY_LISTS[code];
    if (!urls || urls.length === 0) return null;
    let l = this.lists.get(code);
    if (!l) {
      const held = { names: [] as string[] };
      const remote = new RemoteList<string>({
        urls,
        cacheFile: path.join(this.dir, `country-${code.toLowerCase()}.lst`),
        parse: parseList,
        key: (n) => n,
        format: (n) => n,
        onUpdate: (names, from) => {
          held.names = names;
          if (from === 'net') this.log.info(`список сайтов страны ${code}: ${names.length}`);
        },
        label: `список сайтов ${code}`,
        log: this.log,
      });
      l = { remote, held };
      this.lists.set(code, l);
      if (this.started) remote.start();
    }
    return l.held;
  }

  domains(): { tunnel: string[]; direct: string[] } {
    const learned = this.sites.learned().filter((l) => l.via === 'tunnel').map((l) => l.name);
    return shareDomains({ own: this.sites.ownNames(), common: this.sites.commonNames(), learned, overrides: this.sites.overrides() });
  }

  /** Подсети — те же, что у шлюза: без частных, без Cloudflare. DNS ещё не скачал — пусто. */
  nets(): string[] {
    try {
      const list = parseCidrList(readFileSync(path.join(this.dnsDir, SUBNETS_FILE), 'utf8'));
      return pickSubnets(list, this.skip).nets.map(formatCidr);
    } catch {
      return [];
    }
  }
}
