import { formatCidr, overlaps, parseCidr, type Cidr } from '../cidr.ts';
import { PRIVATE_V4 } from '../inlets/fence.ts';
import type { Config } from '../config.ts';
import { serviceNets } from '../dns/subnets.ts';
import type { Logger } from '../log.ts';
import { outletCountries, type Outlet } from '../outlets/outlet.ts';
import type { Sites } from '../panel/sites.ts';
import path from 'node:path';
import { RuleBook } from './book.ts';
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
export type Rules = { book: RuleBook; lists: RuleLists; services: Services; route: Router; allowNets(): string[]; stop(): void };

const PRIVATE = PRIVATE_V4.map(([net, bits]) => parseCidr(`${net}/${bits}`) as Cidr);
const isPrivateNet = (c: Cidr): boolean => PRIVATE.some((p) => overlaps(p, c));

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
  return {
    book,
    lists,
    services,
    route: (host, asked) => routeFor(book.rules(), host, asked),
    allowNets: () => [...new Set(book.rules().onlyNets().filter((n) => isPrivateNet(n)).map((n) => formatCidr(n)))].sort(),
    stop: () => { book.stop(); lists.stop(); services.stop(); },
  };
}
