import { randomBytes } from 'node:crypto';
import type { Config, OutletConfig } from '../config.ts';
import { readWgProfile, type WgProfile } from './profile.ts';

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

/** Выход mihomo: что нужно, чтобы вписать его в конфиг ядра. */
export type MihomoOutlet = {
  outlet: Outlet;
  config: OutletConfig;
  profile: WgProfile;
};

export function newOutlet(config: OutletConfig, socksPort: number): Outlet {
  return {
    name: config.name,
    priority: config.priority,
    socks: { host: '127.0.0.1', port: socksPort, user: config.name, pass: randomBytes(18).toString('hex') },
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
export function prepareOutlets(config: Config): MihomoOutlet[] {
  const prepared: MihomoOutlet[] = [];
  let index = 0;
  for (const oc of config.outlets) {
    if (!oc.enabled) continue;
    let profile: WgProfile;
    try {
      profile = readWgProfile(oc.conf, oc.env);
    } catch (error) {
      throw new Error(`выход «${oc.name}»: ${(error as Error).message}`);
    }
    prepared.push({ outlet: newOutlet(oc, config.mihomo.socksBase + index), config: oc, profile });
    index += 1;
  }
  return prepared;
}
