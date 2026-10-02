import { getDomain } from 'tldts';
import { formatCidr, overlaps, parseCidr, type Cidr } from '../cidr.ts';
import { PRIVATE_V4 } from '../inlets/fence.ts';
import type { Config } from '../config.ts';
import { serviceNets } from '../dns/subnets.ts';
import type { Logger } from '../log.ts';
import { outletCountries, type Outlet } from '../outlets/outlet.ts';
import type { Sites } from '../panel/sites.ts';
import { RuleBook } from './book.ts';
import { rulesDir } from './compiled.ts';
import { routeFor, type Router } from './need.ts';

/**
 * Правила процесса Contour целиком: книга (источники → набор, файл для DNS) и
 * то, что из неё получают входы: `route` — требование к выходу по имени или
 * адресу.
 */

/** `allowNets` — частные подсети правил «только через эти выходы»: исключения ограды для края и namespace. */
export type Rules = { book: RuleBook; route: Router; allowNets(): string[]; stop(): void };

/**
 * Сервис — ключ прилипания к стране: основной домен по списку публичных
 * суффиксов (`bbc.co.uk`, а не `co.uk`; частные суффиксы — тоже: сайты на
 * `github.io` — разные сервисы). Группы сервисов (у TikTok десятки разных
 * доменов) — `rules/services.ts`, когда он есть; это — запасной путь.
 */
export function domainService(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) ?? host.toLowerCase();
}

const PRIVATE = PRIVATE_V4.map(([net, bits]) => parseCidr(`${net}/${bits}`) as Cidr);
const isPrivateNet = (c: Cidr): boolean => PRIVATE.some((p) => overlaps(p, c));

export function startRules(config: Config, deps: { sites: Sites; outlets: Outlet[]; countrySites: () => Record<string, string[]>; log: Logger }): Rules {
  const skip = config.lan.subnetSkip.map((s) => parseCidr(s)).filter((c): c is Cidr => c !== null);
  const book = new RuleBook({
    sites: deps.sites,
    subnets: () => serviceNets(config.lan.dataDir, skip).map(formatCidr),
    countries: () => outletCountries(deps.outlets),
    directCountry: () => deps.outlets.find((o) => o.direct)?.country ?? null,
    countrySites: deps.countrySites,
    dir: rulesDir(config),
    log: deps.log.child({ src: 'rules' }),
  });
  book.start();
  deps.sites.onChange(() => book.rebuild());
  return {
    book,
    route: (host, asked) => routeFor(book.rules(), host, asked),
    allowNets: () => [...new Set(book.rules().onlyNets().filter((n) => isPrivateNet(n)).map((n) => formatCidr(n)))].sort(),
    stop: () => book.stop(),
  };
}
