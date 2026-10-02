import { formatCidr, overlaps, parseCidr, type Cidr } from '../cidr.ts';
import { PRIVATE_V4 } from '../inlets/fence.ts';
import type { Config } from '../config.ts';
import { serviceNets } from '../dns/subnets.ts';
import { errorText, type Logger } from '../log.ts';
import { rootCall } from '../root/protocol.ts';
import { outletCountries, type Outlet } from '../outlets/outlet.ts';
import type { Sites } from '../panel/sites.ts';
import path from 'node:path';
import { RuleBook } from './book.ts';
import { gatewayClasses } from './gateway.ts';
import { RuleLists } from './lists.ts';
import { parseRuleList } from './parse.ts';
import { Services } from './services.ts';
import { rulesDir } from './compiled.ts';
import { routeFor, type Router } from './need.ts';

/**
 * Правила процесса Contour целиком: книга (источники → набор, файл для DNS) и
 * то, что из неё получают входы: `route` — требование к выходу по имени или
 * адресу.
 */

/**
 * `allowNets` — частные подсети правил «только через эти выходы»: исключения
 * ограды для края и namespace. `services` — сервис по имени (группа v2fly или
 * основной домен): ключ прилипания, самообучения и замеров.
 */
export type Rules = {
  book: RuleBook; lists: RuleLists; services: Services; route: Router; allowNets(): string[];
  /** Частный адрес можно открыть через этот выход: подсеть правила «только через», и выход — из него. */
  allowsPrivate(ip: string, outlet: string): boolean;
  stop(): void;
};

const RESEND_MS = 60_000;
const PRIVATE = PRIVATE_V4.map(([net, bits]) => parseCidr(`${net}/${bits}`) as Cidr);
const isPrivateNet = (c: Cidr): boolean => PRIVATE.some((p) => overlaps(p, c));

/**
 * Классы маршрута шлюза — помощнику, когда правила или страны выходов
 * сменились (книга шлёт сигнал только при настоящей смене). Помощник старый
 * («неизвестная команда») — одна строка в журнале: шлюз работает как раньше.
 */
function declareGateway(book: RuleBook, outlets: Outlet[], log: Logger): void {
  let sent = '';
  let warned = false;
  const send = (): void => {
    const { classes, dropped } = gatewayClasses(book.rules(), outlets);
    const text = JSON.stringify(classes);
    if (text === sent) return;
    rootCall({ cmd: 'gateway.classes', classes }, 10_000).then(() => {
      sent = text;
      warned = false;
      log.info(`шлюз: классов маршрута ${classes.length}${classes.length > 0 ? ` — ${classes.map((c) => `${c.name}: ${c.outlets.join(' → ') || 'никуда'}`).join('; ')}` : ''}${dropped > 0 ? `; не влезло ${dropped}` : ''}`);
    }, (error: unknown) => {
      if (!warned) log.warn(`шлюз: классы маршрута не приняты — ${errorText(error)}`);
      warned = true;
    });
  };
  book.onChange(send);
  send();
  // Помощника обновили позже Contour (install.sh) — набор уйдёт и без смены правил.
  setInterval(send, RESEND_MS).unref();
}

/**
 * Исключения ограды SOCKS выходов в namespace (`root/fence-allow.ts`): выход →
 * частные подсети правил «только через него». Шлём весь набор, только когда он
 * сменился: помощник пересобирает SOCKS выхода, а это на секунду рвёт его
 * соединения. Выходы mihomo — без namespace, им исключение не нужно.
 */
function declareFence(book: RuleBook, netns: ReadonlySet<string>, log: Logger): void {
  let sent = '';
  let warned = false;
  const send = (): void => {
    const outlets: Record<string, string[]> = {};
    for (const n of book.rules().onlyNets()) {
      if (!isPrivateNet(n)) continue;
      for (const o of n.outlets) if (netns.has(o)) (outlets[o] ??= []).push(formatCidr(n));
    }
    const text = JSON.stringify(outlets);
    if (text === sent) return;
    rootCall<{ changed: string[]; failed: string[] }>({ cmd: 'outlet.fence', outlets }, 60_000).then((r) => {
      sent = text;
      warned = false;
      if (r.changed.length > 0) log.info(`ограда выходов: исключения ${Object.entries(outlets).map(([o, nets]) => `${o} — ${nets.join(', ')}`).join('; ') || 'сняты'}; SOCKS пересобран: ${r.changed.join(', ')}${r.failed.length > 0 ? `; не вышло: ${r.failed.join(', ')}` : ''}`);
    }, (error: unknown) => {
      if (!warned) log.warn(`ограда выходов: исключения не приняты — ${errorText(error)}`);
      warned = true;
    });
  };
  book.onChange(send);
  send();
  // Помощника обновили позже Contour (install.sh) — набор уйдёт и без смены правил.
  setInterval(send, RESEND_MS).unref();
}

export function startRules(config: Config, deps: { sites: Sites; outlets: Outlet[]; countrySites: () => Record<string, string[]>; log: Logger }): Rules {
  const skip = config.lan.subnetSkip.map((s) => parseCidr(s)).filter((c): c is Cidr => c !== null);
  const log = deps.log.child({ src: 'rules' });
  const lists = new RuleLists({ dir: rulesDir(config), parse: parseRuleList, log });
  const book = new RuleBook({
    sites: deps.sites,
    subnets: () => serviceNets(config.lan.dataDir, skip).map(formatCidr),
    countries: () => outletCountries(deps.outlets),
    directCountry: () => deps.outlets.find((o) => o.direct)?.country ?? null,
    countrySites: deps.countrySites,
    extra: () => lists.sources(),
    dir: rulesDir(config),
    log,
  });
  book.start();
  lists.start();
  deps.sites.onChange(() => book.rebuild());
  lists.onChange(() => book.rebuild());
  const services = new Services({ cacheDir: path.join(rulesDir(config), 'services'), log });
  services.start();
  if (config.lan.enabled) declareGateway(book, deps.outlets, log);
  declareFence(book, new Set(config.outlets.filter((o) => o.kind === 'netns' && o.enabled).map((o) => o.name)), log);
  return {
    book,
    lists,
    services,
    route: (host, asked) => routeFor(book.rules(), host, asked),
    allowsPrivate: (ip, outlet) => {
      const d = book.rules().decide(ip);
      return d?.match.kind === 'cidr' && d.action.target.kind === 'only' && d.action.target.outlets.includes(outlet);
    },
    allowNets: () => [...new Set(book.rules().onlyNets().filter((n) => isPrivateNet(n)).map((n) => formatCidr(n)))].sort(),
    stop: () => { book.stop(); lists.stop(); services.stop(); },
  };
}
