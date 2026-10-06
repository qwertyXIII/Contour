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
import { sectionText } from './contour-format.ts';
import { gatewayClasses } from './gateway.ts';
import { InternalHints, withHintNet, type InternalHint } from './hints.ts';
import { RuleLists, type RuleList } from './lists.ts';
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
  /** DNS выхода для имени: правило «только через него» и DNS у выхода есть — адреса, иначе пусто. */
  internalDns(outlet: string, host: string): string[];
  /** Имя разрешилось в закрытые адреса — подсказка панели, если это внутренний адрес от DNS выхода. */
  blocked(outlet: string, host: string, ips: string[]): void;
  /** Подсказки «добавь подсеть»; уже покрытые правилами — не показываются. */
  hints(): InternalHint[];
  /** Дописать подсеть подсказки в её список; список не ручной или не своего формата — ошибка словами. */
  applyHint(name: string): RuleList;
  stop(): void;
};

const RESEND_MS = 60_000;
const ipv4 = (ip: string): number => ip.split('.').reduce((a, p) => ((a << 8) + Number(p)) >>> 0, 0);

/** Выходы, названные хоть в одном правиле «только через». */
function onlyOutlets(book: RuleBook): Set<string> {
  const out = new Set<string>();
  for (const { entry } of book.rules().entries()) if (entry.action.target.kind === 'only') for (const o of entry.action.target.outlets) out.add(o);
  return out;
}
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
function declareFence(book: RuleBook, netns: ReadonlySet<string>, outletDns: (name: string) => string[], log: Logger): void {
  let sent = '';
  let warned = false;
  const send = (): void => {
    const outlets: Record<string, string[]> = {};
    for (const n of book.rules().onlyNets()) {
      if (!isPrivateNet(n)) continue;
      for (const o of n.outlets) if (netns.has(o)) (outlets[o] ??= []).push(formatCidr(n));
    }
    // DNS выхода — тоже, если он частный и у выхода есть правила «только через»: им Contour спрашивает их имена.
    for (const o of onlyOutlets(book)) {
      if (!netns.has(o)) continue;
      for (const ip of outletDns(o)) if (isPrivateNet({ net: ipv4(ip), bits: 32 }) && !(outlets[o] ?? []).includes(`${ip}/32`)) (outlets[o] ??= []).push(`${ip}/32`);
    }
    for (const o of Object.keys(outlets)) outlets[o] = [...new Set(outlets[o])].sort();
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

/** Подсеть подсказки — в список, чьё правило взяло имя: разделом того же назначения. */
function applyHint(lists: RuleLists, book: RuleBook, hints: InternalHints, name: string): RuleList {
  const h = hints.get(name);
  if (!h) throw new Error('подсказки уже нет — попробуй открыть сайт ещё раз');
  const action = book.rules().decide(h.name)?.action;
  const list = lists.all().find((l) => l.enabled && l.title === h.list);
  if (!action || !list) throw new Error(`правило «${h.name}» не из своего списка (${h.list}) — добавь ${h.net} в свой список «только через ${h.outlet}»`);
  if (list.kind === 'url') throw new Error(`«${list.title}» — список по ссылке, его меняют на сайте; добавь ${h.net} в свой список`);
  const format = list.stats?.format ?? list.format;
  if (format !== 'contour') throw new Error(`«${list.title}» — не свой формат с разделами; добавь ${h.net} туда сам`);
  const updated = lists.update(list.id, { text: withHintNet(lists.text(list.id), h, sectionText(action)) });
  hints.forget(name);
  return updated;
}

export function startRules(config: Config, deps: { sites: Sites; outlets: Outlet[]; countrySites: () => Record<string, string[]>; outletDns?: (name: string) => string[]; log: Logger }): Rules {
  const outletDns = deps.outletDns ?? (() => []);
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
  declareFence(book, new Set(config.outlets.filter((o) => o.kind === 'netns' && o.enabled).map((o) => o.name)), outletDns, log);
  const allowsPrivate = (ip: string, outlet: string): boolean => {
    const d = book.rules().decide(ip);
    return d?.match.kind === 'cidr' && d.action.target.kind === 'only' && d.action.target.outlets.includes(outlet);
  };
  const internalDns = (outlet: string, host: string): string[] => {
    const servers = outletDns(outlet);
    if (servers.length === 0) return [];
    const t = book.rules().decide(host)?.action.target;
    return t?.kind === 'only' && t.outlets.includes(outlet) ? servers : [];
  };
  const hints = new InternalHints();
  return {
    book,
    lists,
    services,
    route: (host, asked) => routeFor(book.rules(), host, asked),
    allowsPrivate,
    internalDns,
    blocked: (outlet, host, ips) => {
      const d = book.rules().decide(host);
      const ip = ips.find((a) => isPrivateNet({ net: ipv4(a), bits: 32 }));
      if (!d || !ip || internalDns(outlet, host).length === 0) return;
      if (!hints.get(host)) log.warn(`«${host}» через «${outlet}» — внутренний адрес ${ip} (DNS выхода), его подсети нет в правилах; подсказка — в панели`);
      hints.note({ name: host, ip, outlet, list: d.source });
    },
    hints: () => hints.list((h) => allowsPrivate(h.ip, h.outlet)),
    applyHint: (name) => applyHint(lists, book, hints, name),
    allowNets: () => [...new Set(book.rules().onlyNets().filter((n) => isPrivateNet(n)).map((n) => formatCidr(n)))].sort(),
    stop: () => { book.stop(); lists.stop(); services.stop(); },
  };
}
