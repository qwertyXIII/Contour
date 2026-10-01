import { readFileSync } from 'node:fs';

/**
 * Таблица соседей ядра: адрес устройства → MAC. Читается без root.
 *
 * Адрес выдаёт DHCP роутера, и он меняется; MAC — нет (у iPhone и Android
 * «частный адрес» свой на каждую сеть, но постоянный для этой сети). Поэтому
 * всё, что привязано к устройству — имя, режим шлюза, — привязано к MAC.
 */

export const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

export function readArp(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n').slice(1)) {
    const [ip, , flags, mac] = line.trim().split(/\s+/);
    if (ip && mac && MAC.test(mac) && flags !== '0x0' && mac !== '00:00:00:00:00:00') out.set(ip, mac);
  }
  return out;
}

export function arpTable(file = '/proc/net/arp'): Map<string, string> {
  try {
    return readArp(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
}
