import { getDomain } from 'tldts';
import { formatCidr, parseCidr, type Cidr } from '../cidr.ts';
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

export type Rules = { book: RuleBook; route: Router; stop(): void };

/**
 * Сервис — ключ прилипания к стране: основной домен по списку публичных
 * суффиксов (`bbc.co.uk`, а не `co.uk`; частные суффиксы — тоже: сайты на
 * `github.io` — разные сервисы). Группы сервисов (у TikTok десятки разных
 * доменов) — `rules/services.ts`, когда он есть; это — запасной путь.
 */
export function domainService(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) ?? host.toLowerCase();
}

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
  return { book, route: (host, asked) => routeFor(book.rules(), host, asked), stop: () => book.stop() };
}
