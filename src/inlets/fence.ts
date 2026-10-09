import { isIPv4, isIPv6 } from 'node:net';

/**
 * Ограда: куда через выход ходить нельзя.
 *
 * Имена разрешаются на дальнем конце туннеля, поэтому здесь проверяется то,
 * что видно до соединения: голый адрес и имя, которое по форме местное.
 * Частные адреса дальнего конца (сеть VPN-сервера) — не наша машина и не
 * наша забота; наша — чтобы через Contour нельзя было достать `127.0.0.1`,
 * `192.168.0.x` и прочее своё. Потребители проверяют адрес и сами (Alter —
 * обязательно), ограда не полагается на то, что все проверяют.
 */

export type FenceVerdict = { ok: true } | { ok: false; reason: string };

/** [сеть, биты] — что не выпускаем по IPv4. */
/** Частные и служебные сети IPv4 — их не пускаем ни через выход, ни в наборы шлюза. */
export const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home', '.home.arpa', '.corp', '.intranet'];

/** Имя местной сети: без точки или с местным окончанием (`.local`, `.home`…). */
export function isLocalName(name: string): boolean {
  const bare = name.toLowerCase().replace(/\.$/, '');
  return !bare.includes('.') || LOCAL_SUFFIXES.some((s) => bare.endsWith(s));
}

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

export function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return PRIVATE_V4.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(net) & mask);
  });
}

export function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1] as string);
  if (lower === '::' || lower === '::1') return true;
  // fc00::/7, fe80::/10, ff00::/8 — уникально-локальные, link-local, multicast.
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
}

export function checkDestination(host: string, port: number): FenceVerdict {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, reason: `порт ${port} вне диапазона` };
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === '') return { ok: false, reason: 'пустой адрес' };

  if (isIPv4(bare)) return isPrivateV4(bare) ? { ok: false, reason: `${bare} — частный адрес` } : { ok: true };
  if (isIPv6(bare)) return isPrivateV6(bare) ? { ok: false, reason: `${bare} — локальный адрес` } : { ok: true };

  if (bare === 'localhost' || !bare.includes('.')) return { ok: false, reason: `«${bare}» — местное имя` };
  if (LOCAL_SUFFIXES.some((s) => bare.endsWith(s))) return { ok: false, reason: `«${bare}» — имя местной сети` };
  if (!/^[a-z0-9.-]+$/.test(bare) && !/^xn--/.test(bare) && !/^[\p{L}\p{N}.-]+$/u.test(bare)) {
    return { ok: false, reason: `«${bare.slice(0, 40)}» — не похоже на имя` };
  }
  return { ok: true };
}
