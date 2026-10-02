import { formatCidr } from '../cidr.ts';
import { isPrivateV4 } from '../inlets/fence.ts';
import type { GatewayClass, GatewayRoute } from '../gateway.ts';
import { GW_MAX_CLASSES, ROUTE_DIRECT, ROUTE_TUNNEL } from '../gateway.ts';
import type { Outlet } from '../outlets/outlet.ts';
import type { RuleSet } from './engine.ts';
import type { Action } from './types.ts';

/**
 * Правила для шлюза: «куда» → класс маршрута помощника (`root/gateway-classes.ts`).
 * Имя класса выводится из действия одинаково в обоих процессах: Contour
 * объявляет классы (он знает выходы, страны и приоритеты), DNS кладёт адреса
 * имени в класс по тому же имени.
 *
 * - «напрямую» — `direct`, «через туннель» — `tunnel` (как до движка);
 * - «через страну X» — `country-x`: выходы этой страны по приоритету, прямой
 *   тоже, если он этой страны (тогда путь — через роутер);
 * - «не через …» — `avoid-…`: туннели остальных стран;
 * - «только через …» — `only-…`: названные туннели, никогда прямой; подсети
 *   таких правил — в классе (единственное исключение из ограды частных адресов);
 * - «запретить» — `reject`: класс без выходов, всегда `unreachable`.
 */

export function routeOf(action: Action): GatewayRoute {
  const t = action.target;
  if (t.kind === 'direct') return ROUTE_DIRECT;
  if (t.kind === 'tunnel') return ROUTE_TUNNEL;
  if (t.kind === 'reject') return 'reject';
  if (t.kind === 'country') return `country-${t.country.toLowerCase()}`;
  if (t.kind === 'avoid') return `avoid-${[...t.countries].sort().join('-').toLowerCase()}`;
  return `only-${[...t.outlets].sort().join('-')}`;
}

/** Страна класса — чтобы DNS спрашивал имя через выход этой страны (CDN рядом с выходом). */
export function routeCountry(route: GatewayRoute): string | undefined {
  const m = /^country-([a-z]{2})$/.exec(route);
  return m ? (m[1] as string).toUpperCase() : undefined;
}

const byPriority = (a: Outlet, b: Outlet): number => a.priority - b.priority || a.name.localeCompare(b.name);

/** Классы, которых требуют правила, — с выходами по приоритету; больше `GW_MAX_CLASSES` — первые. */
export function gatewayClasses(rules: RuleSet, outlets: Outlet[]): { classes: GatewayClass[]; dropped: number } {
  const wanted = new Map<string, { action: Action; nets: Set<string> }>();
  for (const { entry } of rules.entries()) {
    const route = routeOf(entry.action);
    if (route === ROUTE_DIRECT || route === ROUTE_TUNNEL) continue;
    const w = wanted.get(route) ?? { action: entry.action, nets: new Set<string>() };
    // Подсеть — в класс; частная — только у «только через» (помощник проверит и сам).
    if (entry.match.kind === 'cidr') {
      const cidr = formatCidr(entry.match);
      if (entry.action.target.kind === 'only' || !isPrivateV4(cidr.split('/')[0] as string)) w.nets.add(cidr);
    }
    wanted.set(route, w);
  }
  const tunnels = outlets.filter((o) => !o.direct).sort(byPriority);
  const classes = [...wanted].map(([name, w]): GatewayClass => {
    const t = w.action.target;
    const nets = [...w.nets].sort();
    const base = { name, ...(nets.length > 0 ? { nets } : {}) };
    if (t.kind === 'country') return { ...base, country: t.country, outlets: [...outlets].filter((o) => o.country === t.country).sort(byPriority).map((o) => o.name) };
    if (t.kind === 'avoid') return { ...base, outlets: tunnels.filter((o) => !o.country || !t.countries.includes(o.country)).map((o) => o.name) };
    if (t.kind === 'only') return { ...base, only: true, outlets: tunnels.filter((o) => t.outlets.includes(o.name)).map((o) => o.name) };
    return { name, outlets: [] };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { classes: classes.slice(0, GW_MAX_CLASSES), dropped: Math.max(0, classes.length - GW_MAX_CLASSES) };
}
