import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config, OutletConfig } from '../config.ts';
import { describeLink, parseLink, type MihomoProxy } from './links.ts';
import { describeProfile, readWgProfile, type WgProfile } from './profile.ts';

/**
 * Выход — один туннель, в который можно соединиться через локальный SOCKS.
 *
 * Для входов и выбора выхода (`select/`) выход — только адрес SOCKS и
 * состояние; кто его поднял (mihomo сегодня, namespace с OpenVPN завтра) —
 * дело `outlets/`. Пароль на SOCKS — потому что на машине живут чужие
 * приложения, и `127.0.0.1:10800` без пароля был бы бесплатным туннелем для
 * любого из них в обход токенов.
 */

export type OutletState = 'unknown' | 'alive' | 'dead';

export type Outlet = {
  name: string;
  priority: number;
  socks: { host: string; port: number; user: string; pass: string };
  state: OutletState;
  latencyMs: number | null;
  /** Проверок подряд без успеха. */
  failures: number;
  lastError: string | null;
  externalIp: string | null;
  checkedAt: number | null;
};

/** Выход mihomo: что нужно, чтобы вписать его в конфиг ядра. Ровно одно из трёх. */
export type MihomoOutlet = {
  outlet: Outlet;
  config: OutletConfig;
  profile?: WgProfile;
  link?: MihomoProxy;
  subscription?: string;
};

export function newOutlet(config: OutletConfig, socksPort: number, socks?: Outlet['socks']): Outlet {
  return {
    name: config.name,
    priority: config.priority,
    socks: socks ?? { host: '127.0.0.1', port: socksPort, user: config.name, pass: randomBytes(18).toString('hex') },
    state: 'unknown',
    latencyMs: null,
    failures: 0,
    lastError: null,
    externalIp: null,
    checkedAt: null,
  };
}

/**
 * Читает профили включённых выходов и раздаёт им порты SOCKS.
 * Плохой профиль — ошибка старта, а не молча пропущенный выход: иначе
 * «туннель не работает» обнаружится по 502, а не по строке в логе при запуске.
 */
export type Prepared = {
  /** Все включённые выходы — для выбора и проверки. */
  outlets: Outlet[];
  /** Те, что поднимает mihomo, — для его конфига. */
  mihomo: MihomoOutlet[];
  /** Строка о каждом для лога запуска, без ключей. */
  lines: string[];
};

/** Порт SOCKS внутри namespace выхода — один на всех, адреса у мостов разные. */
export const NETNS_SOCKS_PORT = 1080;

/** Мост выхода netns: `.1` — хост, `.2` — внутри. Тот же расчёт в deploy/contour-netns.sh. */
export function bridgeAddress(bridge: number): string {
  return `10.201.${bridge}.2`;
}

/**
 * Пароль SOCKS выхода netns — файл `<имя>.socks` рядом с ключом. Его создаёт
 * root-часть (contour-netns.sh), когда поднимает выход; Contour только читает.
 */
function netnsPassword(oc: OutletConfig): string {
  const file = path.join(path.dirname(oc.conf), `${oc.name}.socks`);
  let pass: string;
  try {
    pass = readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new Error(`нет пароля SOCKS ${file} — выход ещё не поднимали (systemctl start contour-netns@${oc.name}): ${(error as Error).message}`);
  }
  if (pass.length < 16) throw new Error(`пароль SOCKS в ${file} короче 16 знаков`);
  return pass;
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new Error(`не прочитать ${file}: ${(error as Error).message}`);
  }
}

/** Сервер из .ovpn — для строки в логе; ключи и сертификаты не трогаем. */
function describeOvpn(file: string): string {
  const m = /^\s*remote\s+(\S+)(?:\s+(\d+))?/m.exec(readText(file));
  return m ? `OpenVPN, ${m[1]}:${m[2] ?? 1194}` : 'OpenVPN';
}

function prepareNetns(oc: OutletConfig, prepared: Prepared): void {
  const what = oc.protocol === 'openvpn' ? describeOvpn(oc.conf) : describeProfile(readWgProfile(oc.conf, oc.env));
  const pass = netnsPassword(oc);
  const host = bridgeAddress(oc.bridge as number);
  prepared.outlets.push(newOutlet(oc, NETNS_SOCKS_PORT, { host, port: NETNS_SOCKS_PORT, user: oc.name, pass }));
  prepared.lines.push(`выход «${oc.name}» (ядро, namespace): ${what} → SOCKS ${host}:${NETNS_SOCKS_PORT}`);
}

function prepareMihomo(oc: OutletConfig, port: number, prepared: Prepared): void {
  const item: MihomoOutlet = { outlet: newOutlet(oc, port), config: oc };
  let what: string;
  if (oc.protocol === 'link') {
    item.link = parseLink(readText(oc.conf));
    what = describeLink(item.link);
  } else if (oc.protocol === 'subscription') {
    item.subscription = readText(oc.conf);
    if (!/^https?:\/\/\S+$/.test(item.subscription)) throw new Error('в файле подписки не ссылка http(s)');
    what = `подписка ${new URL(item.subscription).host}`;
  } else {
    item.profile = readWgProfile(oc.conf, oc.env);
    what = describeProfile(item.profile);
  }
  prepared.outlets.push(item.outlet);
  prepared.mihomo.push(item);
  prepared.lines.push(`выход «${oc.name}» (mihomo): ${what} → SOCKS :${port}`);
}

export function prepareOutlets(config: Config): Prepared {
  const prepared: Prepared = { outlets: [], mihomo: [], lines: [] };
  for (const oc of config.outlets) {
    if (!oc.enabled) continue;
    try {
      if (oc.kind === 'netns') prepareNetns(oc, prepared);
      else prepareMihomo(oc, config.mihomo.socksBase + prepared.mihomo.length, prepared);
    } catch (error) {
      throw new Error(`выход «${oc.name}»: ${(error as Error).message}`);
    }
  }
  return prepared;
}
