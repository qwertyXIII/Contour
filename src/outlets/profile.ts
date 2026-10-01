import { readFileSync } from 'node:fs';
import { isIP, isIPv4 } from 'node:net';
import { inflateSync } from 'node:zlib';

/**
 * Профиль WireGuard / AmneziaWG — из конфига `wg-quick` / `awg`, либо из
 * ссылки `vpn://` приложения Amnezia.
 *
 * Понимает оба формата конфига: полный (с `Address`, `DNS`, `MTU`) и ядерный
 * (только то, что ест `awg setconf`), как у aiproxy, где адрес и резолвер
 * вынесены в `awg0.env`. Параметры маскировки Amnezia (`Jc`, `S1`, `H1`…)
 * читаются из `[Interface]`, где их и пишет Amnezia.
 *
 * Ключи не логируются и не печатаются нигде — только то, что безопасно показать.
 */

export type WgPeer = {
  publicKey: string;
  presharedKey: string | null;
  host: string;
  port: number;
  allowedIps: string[];
  keepalive: number | null;
};

export type WgProfile = {
  privateKey: string;
  /** С маской, как в конфиге: `10.8.1.2/32`. */
  addresses: string[];
  /** Только адреса — домены поиска из `DNS =` отбрасываются. */
  dns: string[];
  mtu: number | null;
  peer: WgPeer;
  /** Параметры AmneziaWG в нижнем регистре: `jc`, `jmin`, …, `h4`, `i1`… Пусто — обычный WireGuard. */
  amnezia: Record<string, string>;
};

export class ProfileError extends Error {}

const AMNEZIA_KEYS = new Set(['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4', 'h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5']);

type Section = Map<string, string>;

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** `host:port`, в том числе `[::1]:51820`. */
function splitEndpoint(value: string): { host: string; port: number } {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(value.trim());
  const port = m ? Number(m[2]) : NaN;
  if (!m || !(port >= 1 && port <= 65_535)) throw new ProfileError(`Endpoint «${value}» — нужен host:port`);
  return { host: m[1] as string, port };
}

function parseSections(text: string): { iface: Section; peers: Section[] } {
  const iface: Section = new Map();
  const peers: Section[] = [];
  let current: Section | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      const name = (header[1] as string).toLowerCase();
      if (name === 'interface') current = iface;
      else if (name === 'peer') { current = new Map(); peers.push(current); }
      else throw new ProfileError(`неизвестная секция [${header[1]}]`);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || !current) throw new ProfileError(`непонятная строка «${line.slice(0, 40)}»`);
    current.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  return { iface, peers };
}

export function parseWgConf(text: string): WgProfile {
  const { iface, peers } = parseSections(text);
  const privateKey = iface.get('privatekey');
  if (!privateKey) throw new ProfileError('в [Interface] нет PrivateKey');
  if (peers.length === 0) throw new ProfileError('нет секции [Peer]');
  // Несколько пиров — берём того, через кого идёт весь трафик; иначе первого.
  const peerSection = peers.find((p) => splitList(p.get('allowedips')).includes('0.0.0.0/0')) ?? (peers[0] as Section);

  const publicKey = peerSection.get('publickey');
  if (!publicKey) throw new ProfileError('в [Peer] нет PublicKey');
  const endpoint = peerSection.get('endpoint');
  if (!endpoint) throw new ProfileError('в [Peer] нет Endpoint');
  const allowedIps = splitList(peerSection.get('allowedips'));
  if (allowedIps.length === 0) throw new ProfileError('в [Peer] нет AllowedIPs');

  const amnezia: Record<string, string> = {};
  for (const [key, value] of iface) {
    if (AMNEZIA_KEYS.has(key)) amnezia[key] = value;
  }

  const mtuRaw = iface.get('mtu');
  const keepaliveRaw = peerSection.get('persistentkeepalive');
  return {
    privateKey,
    addresses: splitList(iface.get('address')),
    dns: splitList(iface.get('dns')).filter((d) => isIP(d) !== 0),
    mtu: mtuRaw ? Number(mtuRaw) || null : null,
    peer: {
      publicKey,
      presharedKey: peerSection.get('presharedkey') ?? null,
      ...splitEndpoint(endpoint),
      allowedIps,
      keepalive: keepaliveRaw ? Number(keepaliveRaw) || null : null,
    },
    amnezia,
  };
}

/**
 * Ссылка `vpn://` из Amnezia: base64url, первые четыре байта — длина, дальше
 * zlib с JSON. Внутри — контейнеры; у `awg` / `wireguard` поле `last_config`
 * с текстом конфига (иногда завёрнутым ещё в один JSON).
 */
export function decodeVpnLink(raw: string): { conf: string; dns: string | null; description: string | null } {
  const body = raw.trim().replace(/^vpn:\/\//, '').replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(body, 'base64');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(inflateSync(buf.subarray(4)).toString()) as Record<string, unknown>;
  } catch {
    try {
      parsed = JSON.parse(inflateSync(buf).toString()) as Record<string, unknown>;
    } catch {
      throw new ProfileError('ссылка vpn:// не разбирается — не Amnezia или повреждена');
    }
  }
  const containers = Array.isArray(parsed.containers) ? parsed.containers as Record<string, unknown>[] : [];
  const container = containers.map((c) => c.awg ?? c.wireguard).find(Boolean) as Record<string, unknown> | undefined;
  if (!container) throw new ProfileError('в ссылке vpn:// нет контейнера awg или wireguard');
  const last = container.last_config;
  if (typeof last !== 'string') throw new ProfileError('в контейнере нет last_config');
  let conf = last;
  try {
    const inner = JSON.parse(last) as { config?: unknown };
    if (typeof inner.config === 'string') conf = inner.config;
  } catch {
    // last_config — уже текст конфига
  }
  return {
    conf,
    dns: typeof parsed.dns1 === 'string' ? parsed.dns1 : null,
    description: typeof parsed.description === 'string' ? parsed.description : null,
  };
}

/** `KEY=value` построчно — формат `awg0.env` у aiproxy. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Читает профиль с диска: конфиг или файл со ссылкой `vpn://`, плюс необязательный `.env`. */
export function readWgProfile(confPath: string, envPath: string | null): WgProfile {
  let text: string;
  try {
    text = readFileSync(confPath, 'utf8');
  } catch (error) {
    throw new ProfileError(`не прочитать ${confPath}: ${(error as Error).message}`);
  }

  let linkDns: string | null = null;
  if (text.trim().startsWith('vpn://')) {
    const link = decodeVpnLink(text);
    text = link.conf;
    linkDns = link.dns;
  }
  const profile = parseWgConf(text);

  if (envPath) {
    let env: Record<string, string> = {};
    try {
      env = parseEnv(readFileSync(envPath, 'utf8'));
    } catch (error) {
      throw new ProfileError(`не прочитать ${envPath}: ${(error as Error).message}`);
    }
    if (profile.addresses.length === 0 && env.AWG_ADDRESS) profile.addresses = splitList(env.AWG_ADDRESS);
    if (profile.dns.length === 0 && env.AWG_DNS) profile.dns = splitList(env.AWG_DNS).filter((d) => isIP(d) !== 0);
  }
  if (profile.dns.length === 0 && linkDns && isIP(linkDns)) profile.dns = [linkDns];

  // Адрес без маски ломает не нас, а привычку: нормализуем, как wg-quick.
  profile.addresses = profile.addresses.map((a) => (a.includes('/') ? a : `${a}/${isIPv4(a) ? 32 : 128}`));
  if (!profile.addresses.some((a) => isIPv4(a.split('/')[0] as string))) {
    throw new ProfileError('в профиле нет IPv4-адреса интерфейса (Address в конфиге или AWG_ADDRESS в .env)');
  }
  if (!profile.peer.allowedIps.includes('0.0.0.0/0')) {
    throw new ProfileError(`AllowedIPs = ${profile.peer.allowedIps.join(', ')} — это split-tunnel, через него выход наружу не пойдёт`);
  }
  return profile;
}

/** Что можно показать о профиле: без ключей. */
export function describeProfile(p: WgProfile): string {
  const amnezia = Object.keys(p.amnezia).length > 0 ? 'AmneziaWG' : 'WireGuard';
  return `${amnezia}, ${p.peer.host}:${p.peer.port}, адрес ${p.addresses.join(', ')}, DNS ${p.dns.join(', ') || 'нет'}`;
}
