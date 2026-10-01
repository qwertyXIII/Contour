import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parse } from 'yaml';

/**
 * Настройки Contour — один YAML, читается при старте.
 *
 * Проверяется руками, а не схемой: полей немного, а ошибка должна называть
 * поле по-русски и говорить, что с ним не так. Неизвестное поле — ошибка,
 * а не молчание: опечатка в имени иначе выглядит как «настройка не работает».
 */

export type OutletProtocol = 'amneziawg' | 'wireguard';

export type OutletConfig = {
  name: string;
  /** `netns` — ядерный туннель в своём namespace (AWG, WG; OpenVPN потом); `mihomo` — то, чего ядро не знает. */
  kind: 'mihomo' | 'netns';
  /** Номер моста для `netns`: мост 10.201.N.0/30, SOCKS внутри на 10.201.N.2:1080. */
  bridge: number | null;
  protocol: OutletProtocol;
  /** Конфиг wg-quick / awg, либо файл со ссылкой `vpn://` из Amnezia. */
  conf: string;
  /** Необязательный `.env` c AWG_ADDRESS / AWG_DNS — как у aiproxy. */
  env: string | null;
  /** Резолверы на дальнем конце туннеля. Пусто — из профиля плюс публичные. */
  dns: string[];
  /** MTU туннеля. null — из профиля, а без него безопасное умолчание (см. mihomo-config). */
  mtu: number | null;
  /** Меньше — раньше в очереди. */
  priority: number;
  enabled: boolean;
};

export type Config = {
  http: { listen: string; port: number };
  tokens: string;
  outlets: OutletConfig[];
  mihomo: { bin: string; dir: string; socksBase: number; controller: string };
  health: {
    intervalSec: number;
    connectTimeoutSec: number;
    probeHost: string;
    probePath: string;
    ipHost: string;
    ipIntervalSec: number;
  };
  sticky: { hours: number };
  /** Вход для устройств домашней сети: «умный DNS» + SNI на своём адресе. */
  lan: {
    enabled: boolean;
    /** Второй адрес сервера — на нём DNS :53 и SNI :443 / :80. */
    address: string;
    /** Откуда пускаем: CIDR домашней сети. */
    allow: string;
    /** Обычный DNS для всего, что не из списка. */
    upstream: string[];
    /** Сайты (с поддоменами), которые идут через выходы. */
    domains: string[];
  };
};

/**
 * YouTube целиком: страницы, API приложения для ТВ, видео (googlevideo),
 * картинки. `googleapis.com` целиком не берём — через него ходит пол-Google,
 * а замедлен именно YouTube.
 */
export const LAN_DOMAINS = [
  'youtube.com', 'youtu.be', 'yt.be', 'youtube-nocookie.com', 'youtubekids.com',
  'googlevideo.com', 'ytimg.com', 'ggpht.com',
  'youtubei.googleapis.com', 'youtube.googleapis.com', 'youtubeembeddedplayer.googleapis.com', 'jnn-pa.googleapis.com',
];

export const DEFAULTS: Config = {
  http: { listen: '127.0.0.1', port: 3128 },
  tokens: '/etc/contour/tokens',
  outlets: [],
  mihomo: {
    bin: '/opt/contour/bin/mihomo',
    dir: '/var/lib/contour/mihomo',
    socksBase: 10800,
    controller: '127.0.0.1:19090',
  },
  health: {
    intervalSec: 10,
    connectTimeoutSec: 8,
    probeHost: 'cp.cloudflare.com',
    probePath: '/generate_204',
    ipHost: 'api.ipify.org',
    ipIntervalSec: 300,
  },
  sticky: { hours: 24 },
  lan: {
    enabled: false,
    address: '192.168.0.50',
    allow: '192.168.0.0/24',
    upstream: ['192.168.0.1', '1.1.1.1'],
    domains: LAN_DOMAINS,
  },
};

export class ConfigError extends Error {}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function section(raw: Raw, key: string): Raw {
  const value = raw[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError(`«${key}» должен быть разделом, а не ${typeof value}`);
  return value;
}

function onlyKnown(raw: Raw, where: string, known: string[]): void {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) throw new ConfigError(`${where}: неизвестное поле «${key}»`);
  }
}

function str(raw: Raw, key: string, fallback: string, where: string): string {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`${where}.${key}: нужна непустая строка`);
  return value.trim();
}

function num(raw: Raw, key: string, fallback: number, where: string, min: number, max: number): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${where}.${key}: нужно число от ${min} до ${max}`);
  }
  return value;
}

function bool(raw: Raw, key: string, fallback: boolean, where: string): boolean {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ConfigError(`${where}.${key}: нужно true или false`);
  return value;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function ipv4(raw: Raw, key: string, fallback: string): string {
  const value = str(raw, key, fallback, 'lan');
  if (isIP(value) !== 4) throw new ConfigError(`lan.${key}: нужен IPv4-адрес`);
  return value;
}

function cidr(raw: Raw, key: string, fallback: string): string {
  const value = str(raw, key, fallback, 'lan');
  const [net, bits] = value.split('/');
  if (isIP(net ?? '') !== 4 || !(Number(bits) >= 8 && Number(bits) <= 32)) throw new ConfigError(`lan.${key}: нужна сеть вида 192.168.0.0/24`);
  return value;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function domainList(value: unknown, where: string, fallback: string[]): string[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) throw new ConfigError(`${where}: список сайтов, например [youtube.com, googlevideo.com]`);
  return value.map((v) => {
    const d = typeof v === 'string' ? v.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '') : '';
    if (!DOMAIN.test(d)) throw new ConfigError(`${where}: «${String(v)}» — не имя сайта`);
    return d;
  });
}

function dnsList(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && isIP(v.trim()) !== 0)) {
    throw new ConfigError(`${where}.dns: список адресов резолверов, например [1.1.1.1, 8.8.8.8]`);
  }
  return value.map((v: string) => v.trim());
}

function outlet(raw: unknown, index: number): OutletConfig {
  const where = `outlets[${index}]`;
  if (!isRecord(raw)) throw new ConfigError(`${where}: нужен раздел с полями name, protocol, conf`);
  onlyKnown(raw, where, ['name', 'kind', 'bridge', 'protocol', 'conf', 'env', 'dns', 'mtu', 'priority', 'enabled']);
  const name = str(raw, 'name', '', where);
  if (!NAME.test(name)) {
    throw new ConfigError(`${where}.name: латиница, цифры, «-» и «_», до 32 знаков — имя идёт в логин потребителя`);
  }
  const kind = str(raw, 'kind', 'netns', where);
  if (kind !== 'mihomo' && kind !== 'netns') throw new ConfigError(`${where}.kind: «netns» или «mihomo»`);
  const bridge = kind === 'netns' ? num(raw, 'bridge', 0, where, 1, 250) : null;
  if (kind === 'netns' && raw.bridge === undefined) throw new ConfigError(`${where}.bridge: у выхода netns нужен номер моста от 1 до 250`);
  const protocol = str(raw, 'protocol', '', where);
  if (protocol !== 'amneziawg' && protocol !== 'wireguard') {
    throw new ConfigError(`${where}.protocol: «amneziawg» или «wireguard»`);
  }
  return {
    name,
    kind,
    bridge,
    protocol,
    conf: str(raw, 'conf', '', where),
    env: raw.env === undefined || raw.env === null ? null : str(raw, 'env', '', where),
    dns: dnsList(raw.dns, where),
    mtu: raw.mtu === undefined || raw.mtu === null ? null : num(raw, 'mtu', 0, where, 576, 1500),
    priority: num(raw, 'priority', 100, where, 0, 10_000),
    enabled: bool(raw, 'enabled', true, where),
  };
}

export function parseConfig(text: string): Config {
  const raw: unknown = parse(text) ?? {};
  if (!isRecord(raw)) throw new ConfigError('в корне должен быть раздел, а не список или строка');
  onlyKnown(raw, 'корень', ['http', 'tokens', 'outlets', 'mihomo', 'health', 'sticky', 'lan']);

  const http = section(raw, 'http');
  onlyKnown(http, 'http', ['listen', 'port']);
  const mihomo = section(raw, 'mihomo');
  onlyKnown(mihomo, 'mihomo', ['bin', 'dir', 'socksBase', 'controller']);
  const health = section(raw, 'health');
  onlyKnown(health, 'health', ['intervalSec', 'connectTimeoutSec', 'probeHost', 'probePath', 'ipHost', 'ipIntervalSec']);
  const sticky = section(raw, 'sticky');
  onlyKnown(sticky, 'sticky', ['hours']);
  const lan = section(raw, 'lan');
  onlyKnown(lan, 'lan', ['enabled', 'address', 'allow', 'upstream', 'domains', 'extraDomains']);

  const outletsRaw = raw.outlets ?? [];
  if (!Array.isArray(outletsRaw)) throw new ConfigError('outlets: нужен список выходов');
  const outlets = outletsRaw.map(outlet);
  const names = new Set<string>();
  const bridges = new Set<number>();
  for (const o of outlets) {
    if (names.has(o.name)) throw new ConfigError(`outlets: имя «${o.name}» встречается дважды`);
    names.add(o.name);
    if (o.bridge !== null) {
      if (bridges.has(o.bridge)) throw new ConfigError(`outlets: мост ${o.bridge} встречается дважды`);
      bridges.add(o.bridge);
    }
  }

  const d = DEFAULTS;
  return {
    http: {
      listen: str(http, 'listen', d.http.listen, 'http'),
      port: num(http, 'port', d.http.port, 'http', 1, 65_535),
    },
    tokens: str(raw, 'tokens', d.tokens, 'корень'),
    outlets,
    mihomo: {
      bin: str(mihomo, 'bin', d.mihomo.bin, 'mihomo'),
      dir: str(mihomo, 'dir', d.mihomo.dir, 'mihomo'),
      socksBase: num(mihomo, 'socksBase', d.mihomo.socksBase, 'mihomo', 1024, 65_000),
      controller: str(mihomo, 'controller', d.mihomo.controller, 'mihomo'),
    },
    health: {
      intervalSec: num(health, 'intervalSec', d.health.intervalSec, 'health', 2, 3600),
      connectTimeoutSec: num(health, 'connectTimeoutSec', d.health.connectTimeoutSec, 'health', 1, 120),
      probeHost: str(health, 'probeHost', d.health.probeHost, 'health'),
      probePath: str(health, 'probePath', d.health.probePath, 'health'),
      ipHost: str(health, 'ipHost', d.health.ipHost, 'health'),
      ipIntervalSec: num(health, 'ipIntervalSec', d.health.ipIntervalSec, 'health', 10, 86_400),
    },
    sticky: { hours: num(sticky, 'hours', d.sticky.hours, 'sticky', 0, 24 * 30) },
    lan: {
      enabled: bool(lan, 'enabled', d.lan.enabled, 'lan'),
      address: ipv4(lan, 'address', d.lan.address),
      allow: cidr(lan, 'allow', d.lan.allow),
      upstream: lan.upstream === undefined ? d.lan.upstream : dnsList(lan.upstream, 'lan.upstream'),
      domains: [...new Set([...domainList(lan.domains, 'lan.domains', d.lan.domains), ...domainList(lan.extraDomains, 'lan.extraDomains', [])])],
    },
  };
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`не прочитать настройки ${path}: ${(error as Error).message}`);
  }
  return parseConfig(text);
}
