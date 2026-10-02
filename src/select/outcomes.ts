import { readJson, writeJson } from '../json-file.ts';
import { errorText, type Logger } from '../log.ts';
import { FenceError } from '../outlets/connect.ts';
import { ResolveError } from '../outlets/doh.ts';

/**
 * Самообучение по выходам и странам: пускает ли сервис через этот выход.
 *
 * Contour видит только исход соединения (`inlets/relay.ts`): пришёл первый
 * байт сайта; выход закрыл, не ответив (так рвут блокировки по дороге и так
 * закрываются сервисы, не пускающие страну: Госуслуги через немецкий выход);
 * не соединилось вовсе. Отказ внутри страницы («ваш регион не поддерживается»
 * в HTML, ошибка TLS) отсюда не виден — и не надо: это ответ, не исход.
 *
 * Помним **сервис × выход**, из него выводим **сервис × страну** (страна —
 * ключ прилипания: за «телепортацию» выкидывают из учёток, а внутри страны
 * выходы менять можно). Сервис — готовая строка от движка правил (eTLD+1 или
 * имя группы сервисов), здесь его не вычисляют. Выученное слабее списков и
 * ручных правил — это решает движок; модуль только отвечает «что я знаю».
 *
 * ⚠️ Болезнь выхода — не отказ сервиса. Выход, который лежит целиком, валит
 * все сервисы, и это работа проверки живости (`outlets/health.ts`). Поэтому
 * неудача учитывается, только когда выход в это же время отвечает другим
 * (другому сервису или проверке живости — `exitAlive`) не дальше `aliveWindowMs`,
 * а новой попыткой считается, только если между ней и прошлой выход успел
 * ответить кому-то ещё: одно падение выхода даёт сервису не больше одной
 * попытки, сколько бы соединений за это время ни сорвалось.
 *
 * `fast-close` (закрыл быстрее `FAST_CLOSE_MS`) не учитывается вовсе — ни
 * неудачей, ни успехом, ни признаком жизни выхода: так рвёт фильтр порта у
 * выхода, а не сервис за ним. Это знание о «выход × порт», его держит
 * `outlets/ports.ts` и перепроверяет сам; записанное сюда, оно размножилось бы
 * на все сервисы этого порта и прожило бы `badDays` после того, как карта
 * портов уже исправилась.
 */

export type Outcome = 'answered' | 'silent' | 'fast-close' | 'refused' | 'timeout';
export type FailKind = 'silent' | 'refused' | 'timeout';
/** Выход глазами самообучения: имя и страна (`Outlet` подходит как есть). */
export type ExitRef = { name: string; country: string | null };
export type Verdict = 'good' | 'unknown' | 'bad';
export type Known = { verdict: Verdict; until: number | null };
export type ExitKnown = Known & { at: number | null; ok: number; fails: number; streak: number; kind: FailKind | null };
/** Строка снимка: `exit === null` — вывод по стране целиком. */
export type OutcomeRow = ExitKnown & { service: string; country: string | null; exit: string | null };

export type OutcomeOptions = {
  /** Где помнить выученное между перезапусками; null — только в памяти. */
  file: string | null;
  log: Logger;
  /**
   * Попыток подряд без успеха до «плохо». Одна — часто случайность (сайт
   * перезапускался, балансировщик сбросил), две совпадают при коротком сбое
   * самого сервиса; три отдельные попытки, между которыми выход отвечал
   * другим, — уже отказ. Ждать недорого: каждую неудачу и так спасает повтор
   * через другой выход в `relay.ts`, а ложное «плохо» по стране толкает
   * сервис в другую страну — ту самую телепортацию.
   */
  attempts?: number;
  /** Сколько дней обходить плохой выход; потом «не знаю» — и пробуем снова. */
  badDays?: number;
  /** Сколько дней помнить успех: месяц — Госуслуги открывают раз в месяц, а устаревшее «хорошо» стоит одной неудачи. */
  goodDays?: number;
  /** «Выход в это время работает»: отвечал другим не дальше этого (минуты; проверка живости — раз в 10 с). */
  aliveWindowMs?: number;
  /** Неудачи ближе этого к прошлой попытке — та же попытка: страница открывает пачку соединений сразу. */
  burstMs?: number;
  /** Предел числа сервисов; лишние вытесняются — сначала то, что ничего не знает. */
  maxServices?: number;
  /** Запись на диск — не чаще: «ответил» приходит на каждое соединение. */
  saveDelayMs?: number;
};

const DAY_MS = 86_400_000;
const DEFAULTS = {
  attempts: 3,
  badDays: 3,
  goodDays: 30,
  aliveWindowMs: 2 * 60_000,
  burstMs: 20_000,
  maxServices: 2_000,
  saveDelayMs: 60_000,
};
/** Сервис-заглушка для `exitAlive`: настоящий сервис пустым не бывает. */
const HEALTH = '';
const RANK: Record<Verdict, number> = { good: 0, unknown: 1, bad: 2 };
const KIND_TEXT: Record<FailKind, string> = { silent: 'закрывает, не ответив', refused: 'не соединяется', timeout: 'нет соединения за отведённое время' };

type Pair = {
  /** Страна выхода, когда это узнали; другая страна у того же имени — другой адрес, опыт обнуляется. */
  country: string | null;
  ok: number;
  okAt: number | null;
  /** Учтённые неудачи (болезнь выхода сюда не попадает). */
  fails: number;
  failAt: number | null;
  /** Попыток подряд без успеха; вспышка соединений — одна попытка. */
  streak: number;
  attemptAt: number | null;
  kind: FailKind | null;
};
/** Кто последним получил ответ через выход и кто — до него, другой: «отвечал ли выход кому-то, кроме S». */
type Pulse = { last: { service: string; at: number } | null; prev: { service: string; at: number } | null };

/** Вид отказа по ошибке соединения (`dial`); null — это не исход выхода. */
export function failureKind(error: unknown): FailKind | null {
  // Ограда — наш собственный отказ, «имени нет» — ответ DNS, одинаковый через любой выход.
  if (error instanceof FenceError || error instanceof ResolveError) return null;
  const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'ENODATA') return null;
  return code === 'ETIMEDOUT' || /timed out|нет соединения за|нет ответа/i.test(errorText(error)) ? 'timeout' : 'refused';
}

function lastAt(p: Pair): number {
  return Math.max(p.okAt ?? 0, p.failAt ?? 0);
}

function span(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} мин`;
  return ms < 2 * DAY_MS ? `${Math.round(ms / 3_600_000)} ч` : `${Math.round(ms / DAY_MS)} дн.`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): number | null | undefined => (v === null ? null : isNum(v) ? v : undefined);

/** Запись с диска — только целиком правильная: битая пара выпадает, остальное живёт. */
function parsePair(raw: unknown): Pair | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const okAt = numOrNull(r.okAt);
  const failAt = numOrNull(r.failAt);
  const attemptAt = numOrNull(r.attemptAt);
  const country = r.country === null || typeof r.country === 'string' ? r.country : undefined;
  const kind = r.kind === null || r.kind === 'silent' || r.kind === 'refused' || r.kind === 'timeout' ? r.kind : undefined;
  if (!isNum(r.ok) || !isNum(r.fails) || !isNum(r.streak) || okAt === undefined || failAt === undefined
    || attemptAt === undefined || country === undefined || kind === undefined) return null;
  return { country, ok: r.ok, okAt, fails: r.fails, failAt, streak: r.streak, attemptAt, kind };
}

export class OutcomeBook {
  private readonly services = new Map<string, Map<string, Pair>>();
  private readonly pulse = new Map<string, Pulse>();
  private readonly o: typeof DEFAULTS;
  private readonly file: string | null;
  private readonly log: Logger;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(opts: OutcomeOptions) {
    this.o = {
      attempts: opts.attempts ?? DEFAULTS.attempts,
      badDays: opts.badDays ?? DEFAULTS.badDays,
      goodDays: opts.goodDays ?? DEFAULTS.goodDays,
      aliveWindowMs: opts.aliveWindowMs ?? DEFAULTS.aliveWindowMs,
      burstMs: opts.burstMs ?? DEFAULTS.burstMs,
      maxServices: opts.maxServices ?? DEFAULTS.maxServices,
      saveDelayMs: opts.saveDelayMs ?? DEFAULTS.saveDelayMs,
    };
    this.file = opts.file;
    this.log = opts.log;
    this.load();
  }

  /** Исход соединения через выход. Порядок событий — по времени (`now` не убывает). */
  record(service: string, exit: ExitRef, outcome: Outcome, now = Date.now()): void {
    if (!service || outcome === 'fast-close') return;
    if (outcome === 'answered') this.answered(service, exit, now);
    else this.failed(service, exit, outcome, now);
  }

  /** Выход ответил проверке живости — тоже «в это время работает» (для тихих часов без трафика). */
  exitAlive(exitName: string, now = Date.now()): void {
    this.beat(exitName, HEALTH, now);
  }

  exitVerdict(service: string, exit: ExitRef, now = Date.now()): ExitKnown {
    const p = this.services.get(service)?.get(exit.name);
    if (!p || (exit.country !== null && p.country !== null && p.country !== exit.country)) {
      return { verdict: 'unknown', until: null, at: null, ok: 0, fails: 0, streak: 0, kind: null };
    }
    return { ...this.judge(p, now), at: lastAt(p), ok: p.ok, fails: p.fails, streak: p.streak, kind: p.kind };
  }

  /**
   * Плохо — если плохи все выходы страны, что пробовали для сервиса (и такой
   * есть): «сервис не пускает страну». Хорошо — если хорош хоть один.
   * Непробованный выход страну не спасает и не топит — его просто нет в счёте.
   */
  countryVerdict(service: string, country: string, now = Date.now()): Known {
    let known = 0;
    let bad = 0;
    let badUntil = Infinity;
    let goodUntil = 0;
    for (const p of this.services.get(service)?.values() ?? []) {
      if (p.country !== country) continue;
      known += 1;
      const v = this.judge(p, now);
      if (v.verdict === 'good') goodUntil = Math.max(goodUntil, v.until ?? 0);
      if (v.verdict === 'bad') { bad += 1; badUntil = Math.min(badUntil, v.until ?? Infinity); }
    }
    if (goodUntil > 0) return { verdict: 'good', until: goodUntil };
    // Страна плоха, пока плох каждый: первый же выход, у которого «плохо» истекло, снова пробуем.
    return known > 0 && bad === known ? { verdict: 'bad', until: badUntil } : { verdict: 'unknown', until: null };
  }

  /** Всё, что известно о сервисе по странам, — для движка правил. */
  countries(service: string, now = Date.now()): Array<Known & { country: string }> {
    const seen = new Set<string>();
    for (const p of this.services.get(service)?.values() ?? []) if (p.country !== null) seen.add(p.country);
    return [...seen].sort().map((country) => ({ country, ...this.countryVerdict(service, country, now) }));
  }

  /** Ключ для сравнения в `chooser.ts`: 0 — хорош, 1 — не знаю, 2 — плох. */
  rank(service: string, exit: ExitRef, now = Date.now()): number {
    return RANK[this.exitVerdict(service, exit, now).verdict];
  }

  /**
   * Порядок кандидатов: хорошие → неизвестные → плохие, внутри — как пришли
   * (устойчиво). Плохие не выкидываются: ничего другого нет — пробуем и их,
   * один успех снимет «плохо». `why` — для журнала; null — ничего не знаем.
   */
  order<T extends ExitRef>(service: string, candidates: readonly T[], now = Date.now()): { list: T[]; why: string | null } {
    const known = candidates.map((c, i) => ({ c, i, k: this.exitVerdict(service, c, now) }));
    known.sort((a, b) => RANK[a.k.verdict] - RANK[b.k.verdict] || a.i - b.i);
    const notes = known.filter((x) => x.k.verdict !== 'unknown').map(({ c, k }) => (k.verdict === 'good'
      ? `«${c.name}» отвечает (успех ${span(now - (k.at ?? now))} назад)`
      : `«${c.name}» ${KIND_TEXT[k.kind ?? 'silent']} (${k.streak} попыт., обходим ещё ${span((k.until ?? now) - now)})`));
    return { list: known.map((x) => x.c), why: notes.length > 0 ? `${service}: ${notes.join(', ')}` : null };
  }

  /** Для панели: сервисы, где что-то известно, — первыми; внутри — страна, потом её выходы. Целыми сервисами до `limit` строк. */
  snapshot(limit = 200, now = Date.now()): { rows: OutcomeRow[]; services: number } {
    const all = [...this.services].map(([service, exits]) => ({ service, exits, ...this.weight(exits, now) }));
    all.sort((a, b) => b.weight - a.weight || b.at - a.at);
    const rows: OutcomeRow[] = [];
    for (const { service, exits } of all) {
      const group: OutcomeRow[] = [];
      for (const country of this.countries(service, now)) {
        const mine = [...exits].filter(([, p]) => p.country === country.country);
        const sum = (f: (p: Pair) => number): number => mine.reduce((n, [, p]) => n + f(p), 0);
        group.push({
          service, country: country.country, exit: null, verdict: country.verdict, until: country.until,
          at: Math.max(...mine.map(([, p]) => lastAt(p))), ok: sum((p) => p.ok), fails: sum((p) => p.fails),
          streak: Math.min(...mine.map(([, p]) => p.streak)), kind: null,
        });
        for (const [name, p] of mine) group.push({ service, country: p.country, exit: name, ...this.exitVerdict(service, { name, country: p.country }, now) });
      }
      for (const [name, p] of exits) if (p.country === null) group.push({ service, country: null, exit: name, ...this.exitVerdict(service, { name, country: null }, now) });
      if (rows.length + group.length > limit) break;
      rows.push(...group);
    }
    return { rows, services: this.services.size };
  }

  /** Записать сейчас (при остановке и в тестах). */
  flush(now = Date.now()): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    this.forgetStale(now);
    const services: Record<string, Record<string, Pair>> = {};
    for (const [service, exits] of this.services) services[service] = Object.fromEntries(exits);
    try {
      writeJson(this.file, { v: 1, services });
    } catch (error) {
      this.log.warn(`самообучение по выходам: не сохранить ${this.file} — ${errorText(error)}`);
    }
  }

  stop(): void {
    this.flush();
  }

  private answered(service: string, exit: ExitRef, now: number): void {
    this.beat(exit.name, service, now);
    const p = this.pair(service, exit, now);
    const wasBad = this.judge(p, now).verdict === 'bad';
    p.ok += 1;
    p.okAt = Math.max(p.okAt ?? 0, now);
    p.streak = 0;
    p.attemptAt = null;
    if (wasBad) this.log.info(`«${service}» снова открывается через «${exit.name}» — выход больше не обходим`);
    this.saveSoon();
  }

  private failed(service: string, exit: ExitRef, kind: FailKind, now: number): void {
    const others = this.othersAt(exit.name, service);
    // Выход в это время никому не отвечает — это его болезнь (health.ts), а не отказ сервиса.
    if (others === null || now - others > this.o.aliveWindowMs) return;
    const p = this.pair(service, exit, now);
    const wasBad = this.judge(p, now).verdict === 'bad';
    p.fails += 1;
    p.failAt = Math.max(p.failAt ?? 0, now);
    p.kind = kind;
    // Новая попытка — не из той же пачки соединений и не из того же падения выхода.
    if (p.attemptAt === null || (now - p.attemptAt >= this.o.burstMs && others > p.attemptAt)) {
      p.streak += 1;
      p.attemptAt = now;
    }
    if (!wasBad && this.judge(p, now).verdict === 'bad') this.becameBad(service, exit, p, now);
    this.saveSoon();
  }

  private becameBad(service: string, exit: ExitRef, p: Pair, now: number): void {
    this.log.info(`«${service}» через «${exit.name}» ${KIND_TEXT[p.kind ?? 'silent']} (${p.streak} попыт. подряд, а другим выход отвечает) — обходим ${this.o.badDays} дн.`);
    if (p.country && this.countryVerdict(service, p.country, now).verdict === 'bad') {
      this.log.info(`«${service}» не пускает страну ${p.country}: плохи все её выходы, что пробовали`);
    }
  }

  private judge(p: Pair, now: number): Known {
    const badUntil = (p.failAt ?? 0) + this.o.badDays * DAY_MS;
    if (p.streak >= this.o.attempts && p.failAt !== null && now < badUntil) return { verdict: 'bad', until: badUntil };
    // Хорошо — пока последнее, что видели, успех: первая же неудача после него — снова «не знаю».
    const goodUntil = (p.okAt ?? 0) + this.o.goodDays * DAY_MS;
    if (p.streak === 0 && p.okAt !== null && now < goodUntil) return { verdict: 'good', until: goodUntil };
    return { verdict: 'unknown', until: null };
  }

  private beat(exitName: string, service: string, now: number): void {
    const p = this.pulse.get(exitName) ?? { last: null, prev: null };
    if (p.last?.service === service) p.last.at = Math.max(p.last.at, now);
    else { p.prev = p.last; p.last = { service, at: now }; }
    this.pulse.set(exitName, p);
  }

  /** Когда выход последний раз отвечал кому-то, кроме `service`. */
  private othersAt(exitName: string, service: string): number | null {
    const p = this.pulse.get(exitName);
    if (!p?.last) return null;
    return p.last.service !== service ? p.last.at : p.prev?.at ?? null;
  }

  private pair(service: string, exit: ExitRef, now: number): Pair {
    let exits = this.services.get(service);
    if (!exits) {
      this.makeRoom(now);
      exits = new Map();
      this.services.set(service, exits);
    }
    let p = exits.get(exit.name);
    // Выход сменил страну — новый адрес у провайдера: прежний опыт был про другой адрес. Неизвестная (null) — не смена: после перезапуска страну узнают заново.
    if (!p || (exit.country !== null && p.country !== null && p.country !== exit.country)) {
      p = { country: exit.country, ok: 0, okAt: null, fails: 0, failAt: null, streak: 0, attemptAt: null, kind: null };
      exits.set(exit.name, p);
    } else if (p.country === null) {
      p.country = exit.country;
    }
    return p;
  }

  /** Ценность знания о сервисе: «плохо» дороже всего переучивать (K неудач), «хорошо» — одним успехом. */
  private weight(exits: Map<string, Pair>, now: number): { weight: number; at: number } {
    let weight = 0;
    let at = 0;
    for (const p of exits.values()) {
      const v = this.judge(p, now).verdict;
      weight = Math.max(weight, v === 'bad' ? 2 : v === 'good' ? 1 : 0);
      at = Math.max(at, lastAt(p));
    }
    return { weight, at };
  }

  /** Перед новым сервисом при полном списке — вытеснить пятую часть наименее ценных, а не по одному на каждый. */
  private makeRoom(now: number): void {
    if (this.services.size < this.o.maxServices) return;
    const scored = [...this.services].map(([service, exits]) => ({ service, ...this.weight(exits, now) }));
    scored.sort((a, b) => a.weight - b.weight || a.at - b.at);
    const drop = Math.max(this.services.size - this.o.maxServices + 1, Math.ceil(this.o.maxServices / 5));
    for (const s of scored.slice(0, drop)) this.services.delete(s.service);
  }

  /** Забыть, о чём ничего не слышно дольше, чем живёт любой вердикт. */
  private forgetStale(now: number): void {
    const horizon = Math.max(this.o.goodDays, this.o.badDays) * DAY_MS;
    for (const [service, exits] of this.services) {
      for (const [name, p] of exits) if (now - lastAt(p) > horizon) exits.delete(name);
      if (exits.size === 0) this.services.delete(service);
    }
  }

  private saveSoon(): void {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), this.o.saveDelayMs);
    this.saveTimer.unref();
  }

  /** Битый файл или чужой вид — пустое состояние: выученное — подсказка, не повод не запуститься. */
  private load(): void {
    if (!this.file) return;
    const raw = readJson<unknown>(this.file, null);
    const services = raw && typeof raw === 'object' ? (raw as { services?: unknown }).services : null;
    if (!services || typeof services !== 'object') return;
    for (const [service, exits] of Object.entries(services as Record<string, unknown>)) {
      if (!service || !exits || typeof exits !== 'object') continue;
      const map = new Map<string, Pair>();
      for (const [name, p] of Object.entries(exits as Record<string, unknown>)) {
        const pair = parsePair(p);
        if (pair) map.set(name, pair);
      }
      if (map.size > 0) this.services.set(service, map);
    }
    this.forgetStale(Date.now());
    if (this.services.size > this.o.maxServices) this.makeRoom(Date.now());
    if (this.services.size > 0) this.log.info(`самообучение по выходам: с диска ${this.services.size} сервисов`);
  }
}
