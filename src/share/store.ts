import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeSite } from '../dns/overrides.ts';

/**
 * Раздача: устройства, которые ходят через Contour из любой сети (Shadowrocket
 * на телефоне), и адрес, по которому их ждать.
 *
 * Своё хранилище в папке данных Contour, а не файл `tokens` в `/etc/contour`:
 * тот принадлежит root, а устройства добавляются из панели. У устройства три
 * значения:
 * - `uuid` — его ключ VLESS (вход края, `edge.ts`) и пароль, с которым край
 *   ходит за него в HTTP-прокси Contour (`share.<id>`): одна тайна на одно
 *   устройство, обе стороны — на этой машине;
 * - `list` — отдельный токен ссылки на правила: адрес ссылки попадает в журнал
 *   nginx и в настройки Shadowrocket, а ключ VLESS туда попадать не должен;
 * - `id` — имя устройства для края и счётчиков, без тайны.
 *
 * Секретный путь WebSocket создаётся один раз и не меняется: сменить его —
 * значит отвязать все телефоны.
 */

export type ShareDevice = { id: string; name: string; uuid: string; list: string; enabled: boolean; created: number };
export type ShareSettings = { domain: string | null; path: string };

type File = { settings: ShareSettings; devices: ShareDevice[] };

/** Имя потребителя Contour за устройство раздачи. */
export const SHARE_PREFIX = 'share.';
export const shareWho = (id: string): string => `${SHARE_PREFIX}${id}`;

const MAX_DEVICES = 50;

function fresh(): File {
  return { settings: { domain: null, path: `/s-${randomBytes(12).toString('hex')}` }, devices: [] };
}

export class ShareStore {
  private readonly file: string;
  private data: File;
  private readonly listeners: Array<() => void> = [];

  constructor(dir: string) {
    this.file = path.join(dir, 'share.json');
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8')) as File;
    } catch {
      // Первый запуск: путь создаётся сразу и сохраняется — дальше он постоянный.
      this.data = fresh();
      this.save();
    }
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  settings(): ShareSettings {
    return { ...this.data.settings };
  }

  devices(): ShareDevice[] {
    return this.data.devices.map((d) => ({ ...d }));
  }

  /** Адрес снаружи (`contour.example.ru`); пусто — раздача без адреса, ссылок не будет. */
  setDomain(value: string): ShareSettings {
    const domain = value.trim() ? normalizeSite(value) : null;
    this.data.settings.domain = domain;
    this.commit();
    return this.settings();
  }

  add(name: string): ShareDevice {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error('нужно имя устройства');
    if (this.data.devices.length >= MAX_DEVICES) throw new Error(`устройств уже ${MAX_DEVICES}`);
    let id = randomBytes(4).toString('hex');
    while (this.data.devices.some((d) => d.id === id)) id = randomBytes(4).toString('hex');
    const device: ShareDevice = { id, name: clean, uuid: randomUUID(), list: randomBytes(24).toString('base64url'), enabled: true, created: Date.now() };
    this.data.devices.push(device);
    this.commit();
    return { ...device };
  }

  remove(id: string): void {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    if (this.data.devices.length === before) throw new Error('такого устройства нет');
    this.commit();
  }

  setEnabled(id: string, enabled: boolean): void {
    const d = this.data.devices.find((x) => x.id === id);
    if (!d) throw new Error('такого устройства нет');
    d.enabled = enabled;
    this.commit();
  }

  /** Включённое устройство по токену ссылки на правила, сравнение — без утечки по времени. */
  byList(token: string): ShareDevice | null {
    const given = Buffer.from(token);
    for (const d of this.data.devices) {
      const want = Buffer.from(d.list);
      if (d.enabled && want.length === given.length && timingSafeEqual(want, given)) return { ...d };
    }
    return null;
  }

  /** Пароли края в HTTP-прокси: `share.<id>` → uuid, только включённые. */
  proxyTokens(): Map<string, Buffer> {
    return new Map(this.data.devices.filter((d) => d.enabled).map((d) => [shareWho(d.id), Buffer.from(d.uuid)]));
  }

  private commit(): void {
    this.save();
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    chmodSync(`${this.file}.tmp`, 0o600);
    renameSync(`${this.file}.tmp`, this.file);
  }
}
