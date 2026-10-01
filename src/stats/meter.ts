import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { errorText, type Logger } from '../log.ts';

/**
 * Счётчик трафика на лету — для панели: скорость сейчас, история за сутки,
 * итоги за день, сайты.
 *
 * Считает каждый кусок потока, а не закрытое соединение: видео на телевизоре —
 * одно соединение на десять минут, и по закрытию скорость была бы видна только
 * задним числом.
 *
 * - скорость — сумма за последнее окно `RATE_WINDOW_S` секунд, по потребителю и выходу;
 * - история — точка в минуту за 24 ч: всего, по выходам, по потребителям;
 * - итоги — с полуночи по местному времени;
 * - сайты — до `MAX_HOSTS` с наибольшим трафиком, кто и через что ходил.
 *
 * История и итоги переживают перезапуск: снимок в файл раз в 5 минут и при остановке.
 */

export type Point = { t: number; all: number; byOutlet: Record<string, number>; byWho: Record<string, number> };
export type HostStat = { host: string; bytes: number; last: number; outlet: string; who: string[] };
type Bucket = { up: number; down: number };

const RATE_WINDOW_S = 3;
const HISTORY_POINTS = 24 * 60;
const MAX_HOSTS = 300;
const SAVE_EVERY_MS = 5 * 60_000;

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function bump(map: Map<string, Bucket>, key: string, up: number, down: number): void {
  const b = map.get(key);
  if (b) { b.up += up; b.down += down; } else map.set(key, { up, down });
}

export class Meter {
  /** Секундные корзины: [секунда → по ключам]. */
  private readonly seconds: Array<{ s: number; who: Map<string, Bucket>; outlet: Map<string, Bucket> }> = [];
  private minute = { who: new Map<string, number>(), outlet: new Map<string, number>(), all: 0 };
  private history: Point[] = [];
  private today = { day: dayKey(Date.now()), who: new Map<string, Bucket>(), outlet: new Map<string, Bucket>() };
  private readonly hosts = new Map<string, HostStat & { whoSet: Set<string> }>();
  private readonly seen = new Map<string, number>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly file: string;
  private readonly log: Logger;

  constructor(opts: { dir: string; log: Logger }) {
    this.file = path.join(opts.dir, 'stats.json');
    this.log = opts.log;
  }

  /** Кусок потока: кто, через какой выход, к какому сайту, сколько туда и обратно. */
  add(who: string, outlet: string, host: string, up: number, down: number): void {
    const s = Math.floor(Date.now() / 1000);
    let slot = this.seconds[this.seconds.length - 1];
    if (!slot || slot.s !== s) {
      slot = { s, who: new Map(), outlet: new Map() };
      this.seconds.push(slot);
      while (this.seconds.length > RATE_WINDOW_S + 1) this.seconds.shift();
    }
    bump(slot.who, who, up, down);
    bump(slot.outlet, outlet, up, down);
    const n = up + down;
    this.minute.all += n;
    this.minute.who.set(who, (this.minute.who.get(who) ?? 0) + n);
    this.minute.outlet.set(outlet, (this.minute.outlet.get(outlet) ?? 0) + n);
    this.rollDay();
    bump(this.today.who, who, up, down);
    bump(this.today.outlet, outlet, up, down);
    this.seen.set(who, Date.now());
    this.countHost(host, outlet, who, n);
  }

  /** Скорость, байт/с: вниз и вверх, по потребителям и выходам (окно — несколько секунд). */
  rates(): { who: Record<string, Bucket>; outlet: Record<string, Bucket> } {
    const now = Math.floor(Date.now() / 1000);
    const who = new Map<string, Bucket>();
    const outlet = new Map<string, Bucket>();
    // Текущая секунда не полная — берём только завершённые.
    for (const slot of this.seconds) {
      if (slot.s >= now || slot.s < now - RATE_WINDOW_S) continue;
      for (const [k, b] of slot.who) bump(who, k, b.up, b.down);
      for (const [k, b] of slot.outlet) bump(outlet, k, b.up, b.down);
    }
    const per = (m: Map<string, Bucket>): Record<string, Bucket> =>
      Object.fromEntries([...m].map(([k, b]) => [k, { up: Math.round(b.up / RATE_WINDOW_S), down: Math.round(b.down / RATE_WINDOW_S) }]));
    return { who: per(who), outlet: per(outlet) };
  }

  todayTotals(): { who: Record<string, Bucket>; outlet: Record<string, Bucket> } {
    this.rollDay();
    return { who: Object.fromEntries(this.today.who), outlet: Object.fromEntries(this.today.outlet) };
  }

  /** Когда потребитель последний раз что-то передал. */
  lastSeen(): Record<string, number> {
    return Object.fromEntries(this.seen);
  }

  points(): Point[] {
    return this.history;
  }

  topHosts(limit = 50): HostStat[] {
    return [...this.hosts.values()]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, limit)
      .map(({ whoSet, ...h }) => ({ ...h, who: [...whoSet] }));
  }

  start(): void {
    this.load();
    // Точка в начале каждой минуты.
    const toMinute = 60_000 - (Date.now() % 60_000);
    const first = setTimeout(() => {
      this.flushMinute();
      const every = setInterval(() => this.flushMinute(), 60_000);
      every.unref();
      this.timers.push(every);
    }, toMinute);
    first.unref();
    const save = setInterval(() => this.save(), SAVE_EVERY_MS);
    save.unref();
    this.timers.push(first, save);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.save();
  }

  private flushMinute(): void {
    const t = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
    this.history.push({
      t,
      all: this.minute.all,
      byOutlet: Object.fromEntries(this.minute.outlet),
      byWho: Object.fromEntries(this.minute.who),
    });
    if (this.history.length > HISTORY_POINTS) this.history.splice(0, this.history.length - HISTORY_POINTS);
    this.minute = { who: new Map(), outlet: new Map(), all: 0 };
  }

  private rollDay(): void {
    const day = dayKey(Date.now());
    if (day !== this.today.day) this.today = { day, who: new Map(), outlet: new Map() };
  }

  private countHost(host: string, outlet: string, who: string, n: number): void {
    const h = this.hosts.get(host);
    if (h) {
      h.bytes += n;
      h.last = Date.now();
      h.outlet = outlet;
      h.whoSet.add(who);
      return;
    }
    if (this.hosts.size >= MAX_HOSTS) this.pruneHosts();
    this.hosts.set(host, { host, bytes: n, last: Date.now(), outlet, who: [], whoSet: new Set([who]) });
  }

  /** Выбросить самую мелкую пятую часть — новым сайтам нужно место. */
  private pruneHosts(): void {
    const sorted = [...this.hosts.values()].sort((a, b) => a.bytes - b.bytes);
    for (const h of sorted.slice(0, Math.ceil(MAX_HOSTS / 5))) this.hosts.delete(h.host);
  }

  private save(): void {
    const data = {
      history: this.history,
      today: { day: this.today.day, who: Object.fromEntries(this.today.who), outlet: Object.fromEntries(this.today.outlet) },
      hosts: this.topHosts(MAX_HOSTS),
      seen: Object.fromEntries(this.seen),
    };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(data));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (error) {
      this.log.warn(`статистика: не сохранить ${this.file} — ${errorText(error)}`);
    }
  }

  private load(): void {
    let raw: { history?: Point[]; today?: { day: string; who: Record<string, Bucket>; outlet: Record<string, Bucket> }; hosts?: HostStat[]; seen?: Record<string, number> };
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    const since = Date.now() - HISTORY_POINTS * 60_000;
    this.history = (raw.history ?? []).filter((p) => p && p.t >= since);
    if (raw.today?.day === dayKey(Date.now())) {
      this.today = { day: raw.today.day, who: new Map(Object.entries(raw.today.who ?? {})), outlet: new Map(Object.entries(raw.today.outlet ?? {})) };
    }
    for (const h of raw.hosts ?? []) this.hosts.set(h.host, { ...h, whoSet: new Set(h.who) });
    for (const [k, v] of Object.entries(raw.seen ?? {})) this.seen.set(k, v);
  }
}
