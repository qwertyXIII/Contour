import type { ExitNeed } from '../select/chooser.ts';
import type { RuleSet } from './engine.ts';

/**
 * Решение правил — требование к выходу для входов, что ведут соединение сами
 * (HTTP-прокси, SNI): «куда» на языке выбора выхода.
 *
 * Страна из заголовка телефона (`Contour-Exit`, сервер «Contour-XX») сильнее
 * правила: человек сам выбрал «выйти в этой стране», и сайты из группы страны
 * приходят именно так. «Запретить» и «только эти выходы» сильнее и её: иначе
 * телефон обходил бы запрет своим вторым сервером, а корпоративная сеть ушла бы
 * в чужую страну.
 */

/**
 * `fenceException` — адрес — из подсети правила «только через эти выходы»: это
 * единственное, что ограда частных адресов пропускает (корпоративная сеть
 * владельца — только корпоративными туннелями, решение 2026-10-02), и только с
 * требованием «только эти выходы».
 */
export type Routed =
  | { need: ExitNeed; reject: false; why: string; fenceException: boolean }
  | { need: null; reject: true; why: string; fenceException: false };
export type Router = (host: string, asked?: ExitNeed) => Routed;

export function routeFor(rules: RuleSet, host: string, asked: ExitNeed = {}): Routed {
  const d = rules.decide(host);
  const why = d ? d.source : 'по умолчанию';
  const t = d?.action.target;
  if (t?.kind === 'reject') return { need: null, reject: true, why, fenceException: false };
  const fastest = d?.action.fastest ? { fastest: true } : {};
  if (t?.kind === 'only') return { need: { only: t.outlets, ...fastest }, reject: false, why, fenceException: d?.match.kind === 'cidr' };
  if (asked.country) return { need: { ...asked, ...fastest }, reject: false, why: `просьба страны ${asked.country}`, fenceException: false };
  const routed = (need: ExitNeed): Routed => ({ need: { ...need, ...fastest }, reject: false, why, fenceException: false });
  if (t?.kind === 'direct') return routed({ direct: true });
  if (t?.kind === 'country') return routed({ country: t.country });
  if (t?.kind === 'avoid') return routed({ avoid: t.countries });
  return routed({});
}

/** Без правил — как до движка: просьба страны из заголовка, остальное — туннели. */
export const noRules: Router = (_host, asked = {}) => ({ need: asked, reject: false, why: 'по умолчанию', fenceException: false });
