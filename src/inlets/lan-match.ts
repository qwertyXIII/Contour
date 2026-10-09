import { isIPv4 } from 'node:net';
import type { LanClient } from '../config.ts';

/**
 * Кому и что разрешено на входе для домашней сети.
 *
 * Имя совпадает со списком, если это сам сайт или его поддомен:
 * `rr3---sn-abc.googlevideo.com` → `googlevideo.com`. Ровно по суффиксу с
 * точкой, чтобы `notyoutube.com` не стал `youtube.com`.
 */

export function matchesDomain(name: string, domains: readonly string[]): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  return domains.some((d) => n === d || n.endsWith(`.${d}`));
}

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

/** Адрес из сети `a.b.c.d/n`; v4-mapped (`::ffff:1.2.3.4`) тоже понимается. */
export function inCidr(address: string, cidr: string): boolean {
  const ip = address.replace(/^::ffff:/, '');
  if (!isIPv4(ip)) return false;
  const [net, bitsRaw] = cidr.split('/') as [string, string];
  const bits = Number(bitsRaw);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(net) & mask);
}

/** Клиент входа (`lan.clients`) по адресу; не клиент — null. */
export function lanClient(address: string, clients: readonly LanClient[]): LanClient | null {
  return clients.find((c) => inCidr(address, c.net)) ?? null;
}

/** Пускать ли на вход и в DNS: домашняя сеть или клиент входа. */
export function admitted(address: string, lan: { allow: string; clients: readonly LanClient[] }): boolean {
  return inCidr(address, lan.allow) || lanClient(address, lan.clients) !== null;
}
