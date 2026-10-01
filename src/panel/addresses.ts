import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Адреса устройств-шлюзов: у каждого свой, вне пула DHCP роутера (100–199).
 *
 * Живьём 2026-10-02: панель подсказывала «свободный» адрес по таблице соседей,
 * адрес первого телефона из неё выпал, пока тот молчал, — и второму предложили
 * тот же `.20`. Два устройства на одном адресе — у одного из них пропал весь
 * интернет. Поэтому адрес, на котором устройство-шлюз хоть раз было видно,
 * запоминается за его MAC и другому не предлагается никогда; а занял его всё
 * же кто-то другой — строка устройства говорит об этом прямо.
 */

const FIRST = 20;
const LAST = 49;
/** Ручные адреса — всё, что ниже пула DHCP роутера. */
const MANUAL_MAX = 99;

const octet = (ip: string): number => Number(ip.split('.')[3]);

export class GatewayAddresses {
  private readonly file: string;
  private byMac = new Map<string, string>();

  constructor(dir: string) {
    this.file = path.join(dir, 'gateway-addresses.json');
    try {
      this.byMac = new Map(Object.entries(JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>));
    } catch {
      // ещё никого не запоминали
    }
  }

  /** Запомнить ручные адреса устройств-шлюзов, которые сейчас видны. */
  observe(arp: Map<string, string>, gatewayMacs: Set<string>): void {
    let changed = false;
    for (const [ip, mac] of arp) {
      if (!gatewayMacs.has(mac) || octet(ip) > MANUAL_MAX || this.byMac.get(mac) === ip) continue;
      this.byMac.set(mac, ip);
      changed = true;
    }
    if (changed) this.save();
  }

  /** Адрес для устройства: его запомненный, иначе первый, который не занят и не обещан другому. */
  suggest(mac: string, arp: Map<string, string>, serverIp: string): string | null {
    const mine = this.byMac.get(mac);
    if (mine) return mine;
    const base = serverIp.split('.').slice(0, 3).join('.');
    const promised = new Set([...this.byMac.entries()].filter(([m]) => m !== mac).map(([, ip]) => ip));
    for (let n = FIRST; n <= LAST; n++) {
      const ip = `${base}.${n}`;
      const holder = arp.get(ip);
      if (ip !== serverIp && !promised.has(ip) && (holder === undefined || holder === mac)) return ip;
    }
    return null;
  }

  /** Запомненный адрес устройства сейчас у другого MAC — конфликт: один из двух без интернета. */
  conflict(mac: string, arp: Map<string, string>): string | null {
    const mine = this.byMac.get(mac);
    const holder = mine ? arp.get(mine) : undefined;
    return mine && holder && holder !== mac ? mine : null;
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.byMac), null, 1));
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // не сохранили — запомним в следующий раз
    }
  }
}
