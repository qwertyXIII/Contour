import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeSite } from '../dns/overrides.ts';

/**
 * Раздача: устройства, которые ходят через Contour из любой сети (Shadowrocket
 * на телефоне), и адрес, по которому их ждать.
 *
 * Своё хранилище в папке данных Contour, а не файл `tokens` в `/etc/contour`:
 * тот принадлежит root, а устройства добавляются из панели. У устройства:
 * - `uuid` — его ключ VLESS (вход края, `edge.ts`) и пароль, с которым край
 *   ходит за него в HTTP-прокси Contour (`share.<id>`): одна тайна на одно
 *   устройство, обе стороны — на этой машине;
 * - `countries` — страны выходов, открытые этому телефону (панель; у нового —
 *   никаких: другу не уходит домашний адрес без спроса, владелец 2026-10-02);
 *   на каждую — свой сервер в Shadowrocket («Contour-RU», «Contour-DE»): всё,
 *   что телефон шлёт на него, Contour выпускает в этой стране;
 * - `exits` — ключи этих серверов, по стране. Появляется при первом включении
 *   страны и не пропадает при выключении: включил снова — сервер в телефоне
 *   тот же;
 * - `list` — отдельный токен ссылки на правила: адрес ссылки попадает в журнал
 *   nginx и в настройки Shadowrocket, а ключ VLESS туда попадать не должен;
 * - `id` — имя устройства для края и счётчиков, без тайны.
 *
 * Секретный путь WebSocket создаётся один раз и не меняется: сменить его —
 * значит отвязать все телефоны. `countrySites` — свои сайты «только с адресом
 * этой страны» (банки и прочее, чего нет в общем списке).
 */

export type ShareDevice = { id: string; name: string; uuid: string; countries: string[]; exits: Record<string, string>; list: string; enabled: boolean; created: number };
export type ShareSettings = { domain: string | null; path: string; countrySites: Record<string, string[]> };

type File = { settings: ShareSettings; devices: ShareDevice[] };

/** Имя потребителя Contour за устройство раздачи. */
export const SHARE_PREFIX = 'share.';
export const shareWho = (id: string): string => `${SHARE_PREFIX}${id}`;

const MAX_DEVICES = 50;
const COUNTRY = /^[A-Z]{2}$/;
const MAX_SITES = 500;

function fresh(): File {
  return { settings: { domain: null, path: `/s-${randomBytes(12).toString('hex')}`, countrySites: {} }, devices: [] };
}

const copy = (d: ShareDevice): ShareDevice => ({ ...d, countries: [...d.countries], exits: { ...d.exits } });

function checkCountry(code: string): void {
  if (!COUNTRY.test(code)) throw new Error('страна — две латинские буквы, например NL');
}

/** Страны устройства, которые сервер раздаёт (`share.countries` сужает; null — все). */
export function deviceCountries(d: ShareDevice, allowed: readonly string[] | null): string[] {
  return d.countries.filter((c) => d.exits[c] && (!allowed || allowed.includes(c)));
}

export class ShareStore {
  private readonly file: string;
  private data: File;
  private readonly listeners: Array<() => void> = [];

  constructor(dir: string) {
    this.file = path.join(dir, 'share.json');
    let loaded: File | null = null;
    try {
      loaded = JSON.parse(readFileSync(this.file, 'utf8')) as File;
    } catch {
      // Первый запуск: путь создаётся сразу и сохраняется — дальше он постоянный.
    }
    this.data = loaded ?? fresh();
    // Файл прежней версии: стран и своих сайтов в нём ещё нет — добавить и сохранить.
    if (this.upgrade() || !loaded) this.save();
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  settings(): ShareSettings {
    const s = this.data.settings;
    return { ...s, countrySites: Object.fromEntries(Object.entries(s.countrySites).map(([k, v]) => [k, [...v]])) };
  }

  devices(): ShareDevice[] {
    return this.data.devices.map(copy);
  }

  /** Адрес снаружи (`contour.example.ru`); пусто — раздача без адреса, ссылок не будет. */
  setDomain(value: string): ShareSettings {
    this.data.settings.domain = value.trim() ? normalizeSite(value) : null;
    this.commit();
    return this.settings();
  }

  /** Свой сайт «только с адресом страны»: добавить (`on`) или убрать. */
  setCountrySite(country: string, name: string, on: boolean): string[] {
    checkCountry(country);
    const site = normalizeSite(name);
    const list = new Set(this.data.settings.countrySites[country] ?? []);
    if (on && list.size >= MAX_SITES) throw new Error(`сайтов уже ${MAX_SITES}`);
    if (on) list.add(site); else list.delete(site);
    this.data.settings.countrySites[country] = [...list].sort();
    this.commit();
    return [...list].sort();
  }

  add(name: string): ShareDevice {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error('нужно имя устройства');
    if (this.data.devices.length >= MAX_DEVICES) throw new Error(`устройств уже ${MAX_DEVICES}`);
    let id = randomBytes(4).toString('hex');
    while (this.data.devices.some((d) => d.id === id)) id = randomBytes(4).toString('hex');
    const device: ShareDevice = { id, name: clean, uuid: randomUUID(), countries: [], exits: {}, list: randomBytes(24).toString('base64url'), enabled: true, created: Date.now() };
    this.data.devices.push(device);
    this.commit();
    return copy(device);
  }

  remove(id: string): void {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    if (this.data.devices.length === before) throw new Error('такого устройства нет');
    this.commit();
  }

  setEnabled(id: string, enabled: boolean): void {
    this.find(id).enabled = enabled;
    this.commit();
  }

  /** Открыть телефону страну выхода (`on`) или закрыть; ключ её сервера — при первом открытии. */
  setCountry(id: string, code: string, on: boolean): ShareDevice {
    checkCountry(code);
    const d = this.find(id);
    if (on && !d.exits[code]) d.exits[code] = randomUUID();
    d.countries = on ? [...new Set([...d.countries, code])].sort() : d.countries.filter((c) => c !== code);
    this.commit();
    return copy(d);
  }

  /** Включённое устройство по токену ссылки на правила, сравнение — без утечки по времени. */
  byList(token: string): ShareDevice | null {
    const given = Buffer.from(token);
    for (const d of this.data.devices) {
      const want = Buffer.from(d.list);
      if (d.enabled && want.length === given.length && timingSafeEqual(want, given)) return copy(d);
    }
    return null;
  }

  /** Пароли края в HTTP-прокси: `share.<id>` → uuid, только включённые (страна едет заголовком, а не паролем). */
  proxyTokens(): Map<string, Buffer> {
    return new Map(this.data.devices.filter((d) => d.enabled).map((d) => [shareWho(d.id), Buffer.from(d.uuid)]));
  }

  private find(id: string): ShareDevice {
    const d = this.data.devices.find((x) => x.id === id);
    if (!d) throw new Error('такого устройства нет');
    return d;
  }

  /**
   * Недостающее у прежнего файла: свои сайты стран, ключи стран. Открытые
   * страны прежнего файла — те, ключи которых уже выданы: телефон, которому
   * выдали «Contour-RU», его не теряет.
   */
  private upgrade(): boolean {
    let changed = false;
    if (!this.data.settings.countrySites) { this.data.settings.countrySites = {}; changed = true; }
    for (const d of this.data.devices) {
      if (!d.exits) { d.exits = {}; changed = true; }
      if (!d.countries) { d.countries = Object.keys(d.exits).sort(); changed = true; }
    }
    return changed;
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
