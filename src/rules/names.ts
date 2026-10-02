import { isIPv6 } from 'node:net';
import { domainToASCII } from 'node:url';
import { formatCidr, overlaps, parseCidr, type Cidr } from '../cidr.ts';
import { normalizeSite } from '../dns/overrides.ts';
import { checkDestination, PRIVATE_V4 } from '../inlets/fence.ts';
import type { Match } from './types.ts';

/**
 * Одно имя или одна подсеть из строки списка — общее для всех форматов.
 * Форматы расходятся в одном: что значит голое `example.com`. В простом
 * тексте (itdoginfo, Keenetic, dnsmasq, наш `lists.ts`) — с поддоменами, у
 * Clash и `DOMAIN-SET` Shadowrocket — только оно само; поэтому — параметр.
 */

/** Разобранный кусок строки: запись, честный пропуск («не умеем») или ошибка. */
export type Token = { match: Match } | { skip: string } | { error: string };

const IPV4_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/;
/**
 * Одна метка — целая зона, и только «с поддоменами»: `DOMAIN-SUFFIX,ru,DIRECT`,
 * `.amazon` в `DOMAIN-SET`, `chrome` у v2fly (зона Google). Голое слово в
 * простом тексте — скорее мусор, там зона — с точкой: `.ru`.
 */
const LABEL = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Имя → ASCII в нижнем регистре: схема и путь прочь, кириллица — в punycode; не имя — null. */
export function toName(text: string, allowLabel = false): string | null {
  let n = text.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  if (/[^\x00-\x7f]/.test(n)) n = domainToASCII(n);
  if (!n) return null;
  if (!n.includes('.')) return allowLabel && LABEL.test(n) ? n : null;
  try {
    return normalizeSite(n);
  } catch {
    return null;
  }
}

/** `1.2.3.0/24` и голый `1.2.3.4` (= /32) → подсеть; IPv6 — пропуск (у нас его нет); не адрес — null. */
export function addressToken(text: string): Token | null {
  const t = text.trim();
  if (IPV4_LIKE.test(t)) {
    const c = parseCidr(t);
    return c ? { match: { kind: 'cidr', net: c.net, bits: c.bits } } : { error: 'не подсеть IPv4' };
  }
  if (t.includes(':') && isIPv6(t.split('/')[0] ?? '')) return { skip: 'IPv6' };
  return null;
}

/**
 * Имя с пометкой поддоменов. `full:` — только само, `domain:`, `+.`, `.`,
 * `*.` — с поддоменами; голое — по `bareExact`. У Clash `.x` — только
 * поддомены, а `*.x` — один уровень: Match так не умеет, и мы расширяем до
 * «само и поддомены» — для маршрута лишнее имя в туннеле безвреднее
 * недостающего.
 */
export function nameToken(text: string, bareExact: boolean): Token {
  const t = text.trim();
  const m = /^(full:|domain:|\+\.|\*\.|\.)/i.exec(t);
  const prefix = m?.[1]?.toLowerCase() ?? '';
  const rest = t.slice(prefix.length);
  if (rest.includes('*')) return { skip: 'шаблон со *' };
  const exact = prefix === 'full:' ? true : prefix === '' ? bareExact : false;
  const name = toName(rest, !exact && prefix !== '');
  if (!name) return { error: 'не имя сайта и не подсеть' };
  return { match: { kind: 'domain', name, exact } };
}

/** Подсеть или имя — как в простом тексте или в наборе Clash/Shadowrocket. */
export function entryToken(text: string, bareExact: boolean): Token {
  return addressToken(text) ?? nameToken(text, bareExact);
}

const FENCE: Cidr[] = PRIVATE_V4.map(([net, bits]) => parseCidr(`${net}/${bits}`) as Cidr);

/** Почему ограда не пустит запись, или null. Для «с поддоменами» проверяется поддомен: `lan` → `x.lan`. */
export function fenceReason(m: Match): string | null {
  if (m.kind === 'cidr') {
    const hit = FENCE.find((p) => overlaps(p, m));
    return hit ? `задевает ${formatCidr(hit)} — частные и служебные сети за оградой` : null;
  }
  return checkDestination(m.exact ? m.name : `x.${m.name}`, 443).ok ? null : 'местное имя — за оградой';
}

/** Ключ для повторов: точное и «с поддоменами» одного имени — разные записи. */
export function matchKey(m: Match): string {
  return m.kind === 'cidr' ? `c:${m.net}/${m.bits}` : `${m.exact ? '=' : '.'}${m.name}`;
}

export function describeMatch(m: Match): string {
  return m.kind === 'cidr' ? formatCidr(m) : m.exact ? `full:${m.name}` : m.name;
}
