import { readJson, writeJson } from '../json-file.ts';
import { errorText, type Logger } from '../log.ts';
import { FLOW_DEFAULTS, startFlow, type Flow, type FlowTuning } from './speed-flow.ts';
import { RANK_DEFAULTS, pairedTtfb, rankBy, type Candidate, type Paired, type RankData, type RankTuning, type Ranked } from './speed-rank.ts';
import { cleanWindow, freshValues, lastAt, median, pushSample, quantile, type Sample } from './speed-window.ts';

/**
 * Книга скорости выходов — данные для режима «самый быстрый» (`speed-rank.ts`).
 *
 * Что копится, по уже идущим соединениям (гонки нет — README, «Отвергнуто»):
 * - **TTFB** — от того, как relay отдал выходу байты клиента, до первого байта
 *   от сайта (`noteTtfb`): по паре сервис × выход и по выходу в целом. Для TLS
 *   это ответ на ClientHello, для HTTP — ответ на запрос; меры разные, но
 *   сравниваются всегда внутри одного сервиса, а по выходу в целом — по общим
 *   сервисам (`pairedTtfb`), так что разница не мешает;
 * - **скорость** — по рывкам живого трафика (`flow`, `speed-flow.ts`) и редким
 *   пробам (`speed-probe.ts`). Сводка — верхний квантиль (`throughputQuantile`),
 *   не медиана: каждый замер — нижняя граница канала (упёрся сайт, клиент,
 *   медленный старт), а максимум ловил бы рывок из буферов;
 * - **задержка до выхода** — из `latencyMs` кандидатов: каждая новая проверка
 *   (по `checkedAt`) в короткое окно, чтобы один всплеск проверки не перекинул выход.
 *
 * Хранение — как у `stats/meter.ts`: в памяти, на диск отложенно (`saveDelayMs`) и при
 * остановке; битый файл — пустая книга. Размер ограничен окнами и числом
 * сервисов (`maxServices`, вытесняются давно не виденные): порядка сотни КБ,
 * в худшем случае — до мегабайта. Задержка на диск не пишется: проверка живости
 * пополнит её за минуту.
 */

export type SpeedTuning = RankTuning & FlowTuning & {
  serviceWindow: number;
  outletWindow: number;
  transferWindow: number;
  latencyWindow: number;
  /** Старше — замер не в счёт: выход и сайты за три дня меняются. */
  maxAgeMs: number;
  latencyAgeMs: number;
  /** Дольше — меряли не дорогу, а сайт (долгий опрос, думающий API). */
  maxTtfbMs: number;
  maxServices: number;
  maxOutlets: number;
  throughputQuantile: number;
  saveDelayMs: number;
  /** Сравнение выходов по общим сервисам — сотни медиан; на каждое соединение не пересчитываем. */
  pairCacheMs: number;
};

export const SPEED_DEFAULTS: SpeedTuning = {
  ...RANK_DEFAULTS,
  ...FLOW_DEFAULTS,
  serviceWindow: 15,
  outletWindow: 60,
  transferWindow: 20,
  latencyWindow: 9,
  maxAgeMs: 3 * 86_400_000,
  latencyAgeMs: 10 * 60_000,
  maxTtfbMs: 10_000,
  maxServices: 400,
  maxOutlets: 64,
  throughputQuantile: 0.8,
  saveDelayMs: 60_000,
  pairCacheMs: 60_000,
};

/** Замер активной пробы — как сервис: входит в сравнение по общим сервисам, с настоящим не совпадёт (в имени нет `#`). */
export const PROBE_SERVICE = '#probe';
const MAX_KEY = 200;

export type SpeedOptions = { file: string; log: Logger; tuning?: Partial<SpeedTuning> };

/** Для панели: по выходу. */
export type OutletSpeed = {
  /** Медиана TTFB выхода по всем сайтам — для глаза, не для сравнения выходов. */
  ttfbMs: number | null;
  ttfbCount: number;
  /** По скольким сервисам есть замеры. */
  services: number;
  mbps: number | null;
  /** Замеров скорости с живого трафика и проб. */
  transfers: number;
  probes: number;
  lastAt: number | null;
  probedAt: number | null;
};

export type ProbeResult = { bytes: number; ms: number; firstByteMs?: number | null };
export type RankOptions<C> = { tier?: (c: C) => number; now?: number };

type OutletStats = { ttfb: Sample[]; transfers: Sample[]; probes: Sample[]; probedAt: number | null; latency: Sample[]; latencySeen: number | null };
type ServiceStats = { at: number; outlets: Map<string, Sample[]> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const mbps = (bps: number): number => Math.round((bps * 8) / 1e5) / 10;

export class SpeedBook {
  readonly tuning: SpeedTuning;
  private readonly outlets = new Map<string, OutletStats>();
  private readonly services = new Map<string, ServiceStats>();
  private readonly pairs = new Map<string, { at: number; value: Paired | null }>();
  private readonly file: string;
  private readonly log: Logger;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(opts: SpeedOptions) {
    this.tuning = { ...SPEED_DEFAULTS, ...opts.tuning };
    this.file = opts.file;
    this.log = opts.log;
    this.load(Date.now());
  }

  /** Время до первого байта сайта через выход. `service` пуст — только в счёт выхода. */
  noteTtfb(service: string, outlet: string, ms: number, now = Date.now()): void {
    if (!outlet || !Number.isFinite(ms) || ms < 0 || ms > this.tuning.maxTtfbMs) return;
    const value = Math.round(ms);
    pushSample(this.outlet(outlet).ttfb, value, now, this.tuning.outletWindow);
    const key = service.slice(0, MAX_KEY);
    if (key) {
      let s = this.services.get(key);
      if (!s) {
        if (this.services.size >= this.tuning.maxServices) this.evictServices();
        s = { at: now, outlets: new Map() };
        this.services.set(key, s);
      }
      s.at = now;
      let w = s.outlets.get(outlet);
      if (!w) s.outlets.set(outlet, (w = []));
      pushSample(w, value, now, this.tuning.serviceWindow);
    }
    this.saveSoon();
  }

  /**
   * Передача, по которой канал виден: не меньше `minBytes` за не меньше `minMs`.
   * Обычно её зовёт `flow`; напрямую — для своих замеров (те же пороги).
   */
  noteTransfer(outlet: string, bytes: number, ms: number, now = Date.now()): void {
    if (!outlet || !(bytes >= this.tuning.minBytes) || !(ms >= this.tuning.minMs)) return;
    pushSample(this.outlet(outlet).transfers, Math.round((bytes * 1000) / ms), now, this.tuning.transferWindow);
    this.saveSoon();
  }

  /** Счётчик рывков одного соединения через выход — звать из relay (`speed-flow.ts`). */
  flow(outlet: string): Flow {
    return startFlow(this.tuning, (bytes, ms, at) => this.noteTransfer(outlet, bytes, ms, at));
  }

  /** Проба началась: следующая — не раньше срока, даже если эта не удастся. */
  markProbed(outlet: string, now = Date.now()): void {
    this.outlet(outlet).probedAt = now;
    this.saveSoon();
  }

  /**
   * Итог пробы: скорость — без порога по байтам (проба качает заведомо большой
   * файл, и сколько успело за её срок — это и есть канал), TTFB — под `PROBE_SERVICE`.
   */
  noteProbe(outlet: string, r: ProbeResult, now = Date.now()): void {
    const o = this.outlet(outlet);
    o.probedAt = now;
    if (r.bytes > 0 && r.ms > 0) pushSample(o.probes, Math.round((r.bytes * 1000) / r.ms), now, this.tuning.transferWindow);
    if (typeof r.firstByteMs === 'number') this.noteTtfb(PROBE_SERVICE, outlet, r.firstByteMs, now);
    this.saveSoon();
  }

  /** Свежих замеров скорости с живого трафика — планировщик проб смотрит, нужна ли проба. */
  passiveCount(outlet: string, now = Date.now()): number {
    const o = this.outlets.get(outlet);
    return o ? freshValues(o.transfers, now, this.tuning.maxAgeMs).length : 0;
  }

  probedAt(outlet: string): number | null {
    return this.outlets.get(outlet)?.probedAt ?? null;
  }

  /**
   * Порядок кандидатов одной страны для режима «самый быстрый»; `current` —
   * выход, через который сервис ходит сейчас (гистерезис), `tier` — группы,
   * которые не смешиваются (порт). Правила — `speed-rank.ts`.
   */
  rank<C extends Candidate>(service: string, candidates: readonly C[], current?: string | null, opts: RankOptions<C> = {}): Ranked<C> {
    return rankBy(this.data(opts.now ?? Date.now()), this.tuning, service.slice(0, MAX_KEY), candidates, current, opts.tier);
  }

  snapshot(now = Date.now()): Record<string, OutletSpeed> {
    const out: Record<string, OutletSpeed> = {};
    const age = this.tuning.maxAgeMs;
    for (const [name, o] of this.outlets) {
      const ttfb = freshValues(o.ttfb, now, age);
      const transfers = freshValues(o.transfers, now, age);
      const probes = freshValues(o.probes, now, age);
      if (ttfb.length + transfers.length + probes.length === 0 && o.probedAt === null) continue;
      let services = 0;
      for (const [key, s] of this.services) {
        if (key !== PROBE_SERVICE && freshValues(s.outlets.get(name) ?? [], now, age).length > 0) services += 1;
      }
      const tp = quantile([...transfers, ...probes], this.tuning.throughputQuantile);
      const t = median(ttfb);
      out[name] = {
        ttfbMs: t === null ? null : Math.round(t),
        ttfbCount: ttfb.length,
        services,
        mbps: tp === null ? null : mbps(tp),
        transfers: transfers.length,
        probes: probes.length,
        lastAt: lastAt(o.ttfb, o.transfers, o.probes),
        probedAt: o.probedAt,
      };
    }
    return out;
  }

  stop(): void {
    this.flush();
  }

  private data(now: number): RankData {
    const t = this.tuning;
    const ttfb = (service: string, outlet: string): number[] =>
      freshValues(this.services.get(service)?.outlets.get(outlet) ?? [], now, t.maxAgeMs);
    return {
      ttfb,
      paired: (a, b) => {
        const key = `${a}\n${b}`;
        const hit = this.pairs.get(key);
        if (hit && now - hit.at < t.pairCacheMs && now >= hit.at) return hit.value;
        const common: string[] = [];
        for (const [name, s] of this.services) if (s.outlets.has(a) && s.outlets.has(b)) common.push(name);
        const value = pairedTtfb(ttfb, common, a, b, t.minSamples);
        if (this.pairs.size > 256) this.pairs.clear();
        this.pairs.set(key, { at: now, value });
        return value;
      },
      latency: (c) => {
        this.observeLatency(c);
        const recent = freshValues(this.outlets.get(c.name)?.latency ?? [], now, t.latencyAgeMs);
        return recent.length >= 3 ? median(recent) : c.latencyMs;
      },
      throughput: (outlet) => {
        const o = this.outlets.get(outlet);
        if (!o) return null;
        const values = [...freshValues(o.transfers, now, t.maxAgeMs), ...freshValues(o.probes, now, t.maxAgeMs)];
        const bps = quantile(values, t.throughputQuantile);
        return bps === null ? null : { bps, count: values.length };
      },
    };
  }

  /** Новая успешная проверка живости — в окно; провал (`failures`) оставляет прошлую задержку, её не повторяем. */
  private observeLatency(c: Candidate): void {
    if (c.latencyMs === null || c.checkedAt == null || (c.failures ?? 0) > 0) return;
    const o = this.outlet(c.name);
    if (o.latencySeen === c.checkedAt) return;
    o.latencySeen = c.checkedAt;
    pushSample(o.latency, c.latencyMs, c.checkedAt, this.tuning.latencyWindow);
  }

  private outlet(name: string): OutletStats {
    let o = this.outlets.get(name);
    if (!o) {
      if (this.outlets.size >= this.tuning.maxOutlets) this.evictOutlet();
      o = { ttfb: [], transfers: [], probes: [], probedAt: null, latency: [], latencySeen: null };
      this.outlets.set(name, o);
    }
    return o;
  }

  /** Десятая часть давно не виденных — место новым. */
  private evictServices(): void {
    const old = [...this.services].sort((a, b) => a[1].at - b[1].at).slice(0, Math.ceil(this.tuning.maxServices / 10));
    for (const [key] of old) this.services.delete(key);
  }

  private evictOutlet(): void {
    let oldest: string | null = null;
    let at = Infinity;
    for (const [name, o] of this.outlets) {
      const last = lastAt(o.ttfb, o.transfers, o.probes, o.latency) ?? o.probedAt ?? 0;
      if (last < at) { at = last; oldest = name; }
    }
    if (oldest !== null) this.outlets.delete(oldest);
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), this.tuning.saveDelayMs);
    this.saveTimer.unref();
  }

  private flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const outlets: Record<string, unknown> = {};
    for (const [name, o] of this.outlets) outlets[name] = { ttfb: o.ttfb, transfers: o.transfers, probes: o.probes, probedAt: o.probedAt };
    const services: Record<string, Record<string, Sample[]>> = {};
    for (const [name, s] of this.services) services[name] = Object.fromEntries(s.outlets);
    try {
      writeJson(this.file, { v: 1, outlets, services });
    } catch (error) {
      this.log.warn(`скорость выходов: не сохранить ${this.file} — ${errorText(error)}`);
    }
  }

  /** Из файла — только годное и свежее; чего нет или что битое — пусто. */
  private load(now: number): void {
    const raw = readJson<unknown>(this.file, null);
    if (!isRecord(raw)) return;
    const t = this.tuning;
    const keep = (w: unknown, cap: number): Sample[] => cleanWindow(w, cap).filter(([, at]) => now - at <= t.maxAgeMs);
    for (const [name, v] of Object.entries(isRecord(raw.outlets) ? raw.outlets : {})) {
      if (!isRecord(v) || this.outlets.size >= t.maxOutlets) continue;
      const probedAt = typeof v.probedAt === 'number' && Number.isFinite(v.probedAt) ? v.probedAt : null;
      const o: OutletStats = { ttfb: keep(v.ttfb, t.outletWindow), transfers: keep(v.transfers, t.transferWindow), probes: keep(v.probes, t.transferWindow), probedAt, latency: [], latencySeen: null };
      const empty = o.ttfb.length + o.transfers.length + o.probes.length === 0;
      if (empty && (probedAt === null || now - probedAt > t.maxAgeMs)) continue;
      this.outlets.set(name, o);
    }
    const loaded: Array<[string, ServiceStats]> = [];
    for (const [name, v] of Object.entries(isRecord(raw.services) ? raw.services : {})) {
      if (!isRecord(v) || name.length > MAX_KEY) continue;
      const outlets = new Map<string, Sample[]>();
      for (const [outlet, w] of Object.entries(v)) {
        const samples = keep(w, t.serviceWindow);
        if (samples.length > 0) outlets.set(outlet, samples);
      }
      const at = lastAt(...outlets.values());
      if (at !== null) loaded.push([name, { at, outlets }]);
    }
    loaded.sort((a, b) => b[1].at - a[1].at);
    for (const [name, s] of loaded.slice(0, t.maxServices)) this.services.set(name, s);
  }
}
