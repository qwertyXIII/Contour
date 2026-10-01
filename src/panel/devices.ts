import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { arpTable, MAC } from '../arp.ts';

/**
 * Устройства домашней сети — по MAC.
 *
 * Contour видит устройство как адрес (`lan:192.168.0.105`), но адрес выдаёт
 * DHCP роутера и он может смениться. MAC сервер видит сам — в таблице соседей
 * ядра (`/proc/net/arp`, читается без root), — поэтому имя («Телевизор»)
 * привязывается к MAC и переживает смену адреса (`arp.ts`). Роутер TP-Link имён не отдаёт.
 */

export type Device = { ip: string; mac: string | null; name: string | null };

export class Devices {
  private names = new Map<string, string>();
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'devices.json');
    try {
      this.names = new Map(Object.entries(JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>));
    } catch {
      // первый запуск
    }
  }

  /** Потребители вида `lan:IP` → устройство с MAC и именем. */
  resolve(ips: string[]): Device[] {
    const arp = arpTable();
    return ips.map((ip) => {
      const mac = arp.get(ip) ?? null;
      return { ip, mac, name: mac ? this.names.get(mac) ?? null : null };
    });
  }

  rename(mac: string, name: string): void {
    const m = mac.toLowerCase();
    if (!MAC.test(m)) throw new Error('MAC вида aa:bb:cc:dd:ee:ff');
    const clean = name.trim().slice(0, 40);
    if (clean) this.names.set(m, clean); else this.names.delete(m);
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.names), null, 1));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
