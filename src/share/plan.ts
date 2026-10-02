import { formatCidr } from '../cidr.ts';
import type { Decision, RuleSet } from '../rules/engine.ts';
import type { Action, Entry } from '../rules/types.ts';
import { collapse } from './rules.ts';

/**
 * Правила телефона из движка: что Shadowrocket ведёт через Contour, напрямую,
 * в группу страны или отказывает.
 *
 * Телефон решает «первое совпавшее правило сверху», движок — «слой, потом
 * точность». Чтобы ответы совпали: каждое имя берётся с тем действием, которое
 * ему даёт движок (затенённые правила выпадают), а имена, чьё действие не как
 * у ближайшего родителя (`a.example.com` напрямую внутри `.example.com` через
 * VPN), уходят отдельными строками наверх, самые длинные — первыми. Остальное
 * — наборами по действию. Подсети — строками от длинного префикса к короткому.
 *
 * Тонкости «куда» (страна, «не через», «только эти выходы», «самый быстрый»)
 * телефону не нужны: всё это — «через Contour», а там прокси решит по тем же
 * правилам. «Через страну», не открытую телефону, — напрямую, как раньше.
 */

/** Куда ведёт телефон: узел Contour, напрямую, отказ или группа страны. */
export type Policy = { kind: 'contour' } | { kind: 'direct' } | { kind: 'reject' } | { kind: 'country'; code: string };
export type PhonePlan = {
  exceptions: Array<{ name: string; exact: boolean; policy: Policy }>;
  tunnel: string[];
  direct: string[];
  reject: string[];
  country: Record<string, string[]>;
  nets: Array<{ cidr: string; policy: Policy }>;
};

/** Имя, которого не бывает: им проверяем, что движок даёт поддоменам суффикса. */
const PROBE = 'zz-contour-sub';
const key = (p: Policy): string => (p.kind === 'country' ? `country:${p.code}` : p.kind);

function policyOf(action: Action | undefined, countries: readonly string[]): Policy {
  const t = action?.target;
  if (!t || t.kind === 'direct') return { kind: 'direct' };
  if (t.kind === 'reject') return { kind: 'reject' };
  if (t.kind === 'country') return countries.includes(t.country) ? { kind: 'country', code: t.country } : { kind: 'direct' };
  return { kind: 'contour' };
}

const same = (d: Decision | null, source: string, e: Entry): boolean =>
  Boolean(d && d.source === source && d.match.kind === 'domain' && e.match.kind === 'domain' && d.match.name === e.match.name && d.match.exact === e.match.exact);

export function phonePlan(rules: RuleSet, countries: readonly string[]): PhonePlan {
  const winners = new Map<string, { name: string; exact: boolean; policy: Policy }>();
  const nets: PhonePlan['nets'] = [];
  for (const { source, entry } of rules.entries()) {
    if (entry.match.kind === 'cidr') {
      if (rules.decideIp(entry.match.net)?.source === source) nets.push({ cidr: formatCidr(entry.match), policy: policyOf(entry.action, countries) });
      continue;
    }
    const { name, exact } = entry.match;
    const d = rules.decideName(exact ? name : `${PROBE}.${name}`);
    if (same(d, source, entry)) winners.set(`${exact ? '=' : '.'}${name}`, { name, exact, policy: policyOf(entry.action, countries) });
  }
  // Ближайший родитель — суффикс-правило над именем; у точного — и суффикс на само имя.
  const parent = (name: string, exact: boolean): Policy | null => {
    const own = exact ? winners.get(`.${name}`) : undefined;
    if (own) return own.policy;
    for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
      const p = winners.get(`.${name.slice(dot + 1)}`);
      if (p) return p.policy;
    }
    return null;
  };
  const plan: PhonePlan = { exceptions: [], tunnel: [], direct: [], reject: [], country: {}, nets: [] };
  for (const w of winners.values()) {
    const up = parent(w.name, w.exact);
    // Точное — всегда строкой: в наборе `.имя` взяло бы и поддомены. Суффикс — строкой, если спорит с родителем.
    if (w.exact || (up && key(up) !== key(w.policy))) { plan.exceptions.push(w); continue; }
    if (w.policy.kind === 'contour') plan.tunnel.push(w.name);
    else if (w.policy.kind === 'direct') plan.direct.push(w.name);
    else if (w.policy.kind === 'reject') plan.reject.push(w.name);
    else (plan.country[w.policy.code] ??= []).push(w.name);
  }
  plan.exceptions.sort((a, b) => b.name.split('.').length - a.name.split('.').length || Number(b.exact) - Number(a.exact) || a.name.localeCompare(b.name));
  plan.tunnel = collapse(plan.tunnel);
  plan.direct = collapse(plan.direct);
  plan.reject = collapse(plan.reject);
  for (const code of Object.keys(plan.country)) plan.country[code] = collapse(plan.country[code] as string[]);
  plan.nets = nets.sort((a, b) => Number(b.cidr.split('/')[1]) - Number(a.cidr.split('/')[1]));
  return plan;
}
