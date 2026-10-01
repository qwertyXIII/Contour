/**
 * Подсети IPv4 — для шлюза: списки сервисов, которые ходят по адресам, а не по
 * именам (голос Discord, звонки Telegram и WhatsApp).
 */

export type Cidr = { net: number; bits: number };

const IP = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function toInt(ip: string): number | null {
  const m = IP.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts.reduce((acc, p) => ((acc << 8) + p) >>> 0, 0);
}

const mask = (bits: number): number => (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0);

/** «91.108.4.0/22» или адрес (= /32) → подсеть с обнулённой хост-частью; мусор — null. */
export function parseCidr(text: string): Cidr | null {
  const [ip, b] = text.trim().split('/');
  const n = toInt(ip ?? '');
  const bits = b === undefined ? 32 : Number(b);
  if (n === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return { net: (n & mask(bits)) >>> 0, bits };
}

export function formatCidr(c: Cidr): string {
  const n = c.net;
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}/${c.bits}`;
}

/** Пересекаются ли две подсети (одна внутри другой — тоже). */
export function overlaps(a: Cidr, b: Cidr): boolean {
  const bits = Math.min(a.bits, b.bits);
  return ((a.net ^ b.net) & mask(bits)) === 0;
}

/** Строки списка → подсети: комментарии, IPv6 и мусор — мимо. */
export function parseCidrList(text: string): Cidr[] {
  const out: Cidr[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/#.*/, '').trim();
    if (!t || t.includes(':')) continue;
    const c = parseCidr(t);
    if (c) out.push(c);
  }
  return out;
}
