import { readJson, writeJson } from '../json-file.ts';
import { errorText, type Logger } from '../log.ts';

/**
 * Страна сервиса — на диске (владелец 2026-10-30: «почини»). Было только в
 * памяти: любой перезапуск Contour — свет моргнул, выход включили или выключили
 * в панели — и сервис выбирал выход заново по приоритету, то есть мог уехать в
 * другую страну (2026-10-29: выключили немецкие выходы — Contour перезапустился,
 * и ChatGPT с Claude ушли из Германии).
 *
 * Пишем не на каждый ответ сайта, а через `saveDelayMs` после первого
 * изменения: оборвётся питание — пропадут только последние секунды.
 */

/** Выход, через который сервис ответил, его страна и до какого времени держим. */
export type Stuck = { name: string; country: string | null; until: number };

export type StickyOptions = {
  /** null — только в памяти (тесты). */
  file: string | null;
  log: Logger;
  saveDelayMs?: number;
};

const SAVE_DELAY_MS = 10_000;

function parseStuck(v: unknown, now: number): Stuck | null {
  if (!v || typeof v !== 'object') return null;
  const { name, country, until } = v as Record<string, unknown>;
  if (typeof name !== 'string' || !name || typeof until !== 'number' || until <= now) return null;
  if (country !== null && (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country))) return null;
  return { name, country, until };
}

export class StickyBook {
  private readonly services = new Map<string, Stuck>();
  private readonly file: string | null;
  private readonly log: Logger;
  private readonly saveDelayMs: number;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(opts: StickyOptions) {
    this.file = opts.file;
    this.log = opts.log;
    this.saveDelayMs = opts.saveDelayMs ?? SAVE_DELAY_MS;
    this.load();
  }

  /** Срок вышел — сервис свободен. */
  get(service: string, now = Date.now()): Stuck | null {
    const s = this.services.get(service);
    if (!s) return null;
    if (s.until > now) return s;
    this.services.delete(service);
    return null;
  }

  set(service: string, stuck: Stuck): void {
    this.services.set(service, stuck);
    this.saveSoon();
  }

  count(now = Date.now()): number {
    let n = 0;
    for (const s of this.services.values()) if (s.until > now) n += 1;
    return n;
  }

  /** Записать сейчас (при остановке и в тестах). */
  flush(now = Date.now()): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    const services: Record<string, Stuck> = {};
    for (const [service, s] of this.services) if (s.until > now) services[service] = s;
    try {
      writeJson(this.file, { v: 1, services });
    } catch (error) {
      this.log.warn(`прилипание сервисов: не сохранить ${this.file} — ${errorText(error)}`);
    }
  }

  stop(): void {
    this.flush();
  }

  private saveSoon(): void {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelayMs);
    this.saveTimer.unref();
  }

  /** Битый файл или чужой вид — пусто: прилипание — подсказка, не повод не запуститься. */
  private load(): void {
    if (!this.file) return;
    const raw = readJson<unknown>(this.file, null);
    const services = raw && typeof raw === 'object' ? (raw as { services?: unknown }).services : null;
    if (!services || typeof services !== 'object') return;
    const now = Date.now();
    for (const [service, v] of Object.entries(services as Record<string, unknown>)) {
      const s = parseStuck(v, now);
      if (service && s) this.services.set(service, s);
    }
    if (this.services.size > 0) this.log.info(`прилипание сервисов: с диска ${this.services.size}`);
  }
}
