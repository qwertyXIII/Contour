import type { Socket } from 'node:net';
import { dialVia } from '../dial.ts';
import type { Dial } from '../outlets/connect.ts';
import { errorText, type Logger } from '../log.ts';
import type { Outlet } from '../outlets/outlet.ts';
import { portRank } from '../outlets/ports.ts';
import { failureKind, type Outcome, type OutcomeBook } from './outcomes.ts';
import type { SpeedBook } from './speed.ts';
import { StickyBook } from './sticky.ts';

/**
 * Выбор выхода — вся ценность Contour в одном месте.
 *
 * - Порядок: сначала выходы, которые пропускают нужный порт (`outlets/ports.ts`:
 *   проверенный — раньше непроверенного, «вероятно режет» и «режет» — в конце,
 *   но не выкинуты: проверка могла ошибиться), внутри — выход, к которому сайт
 *   уже прилип, потом живые по приоритету (при равном — по задержке), мёртвые —
 *   в самом конце и только когда живых нет вовсе: проверка могла отстать от
 *   жизни на несколько секунд.
 * - Повтор: не соединилось через первый — сразу через следующий, и клиент
 *   получает ответ только когда соединение уже есть. Отказ одного выхода он
 *   не видит.
 * - Прилипание — **страна на весь сервис, замком** (владелец 2026-10-02: за
 *   «телепортацию» выкидывают из учёток и могут забанить; 2026-10-23: «нельзя
 *   допускать, чтобы мы телепортировались»): сервис (основной домен или группа
 *   доменов — `serviceOf`) держится страны выхода, через который **сайт
 *   ответил** (`confirm`, не «успех» SOCKS: mihomo отвечает его раньше сайта),
 *   `stickyMs` от последнего ответа; первым идёт тот же выход, за ним — другие
 *   выходы той же страны, **другие страны — никогда**: в стране сервиса не
 *   открылось — отказ. Повтор внутри соединения тоже держит страну первого
 *   выхода (`keep`), даже когда сервис ещё не прилип. Выходов страны сервиса
 *   нет вовсе (выключены, ждут в запасе, после запуска страну ещё не узнали) —
 *   тоже отказ, а не другая страна (владелец 2026-10-30); снимают замок только
 *   срок и правило «не через» эту страну. Прилипание — на диске (`sticky.ts`):
 *   перезапуск его не стирает. Замок только у свободного
 *   выбора: «только эти выходы», страна из правила или заголовка и «напрямую» —
 *   решение правила, они замок не трогают и не ставят. Выход без страны (её ещё
 *   не узнали) замком не служит — только первым в очереди.
 * - Выхода «напрямую» здесь нет по построению: умерли все — ошибка, не утечка.
 *   Прямой выход (`config.direct`) — выход как выход, но по умолчанию «по
 *   просьбе»: его видит только соединение, которое просит его страну.
 * - Требование к выходу (`need`, от правила или заголовка телефона): страна —
 *   только выходы этой страны (и «по просьбе» тоже), подходящего нет — отказ, а
 *   не другая страна: Госуслугам заграничный адрес хуже, чем никакого; «не через
 *   эти страны»; «только эти выходы» (никогда прямой: корпоративная сеть —
 *   только корпоративными туннелями); «напрямую» — только прямой выход.
 */

/** Чего соединение требует от выхода; пусто — туннели по приоритету. */
export type ExitNeed = { country?: string; avoid?: string[]; only?: string[]; direct?: boolean; fastest?: boolean };

/** Подходит ли выход под требование. Прямой «по просьбе» виден только тому, кто просит его страну или «напрямую». */
export function fitsNeed(o: Outlet, need: ExitNeed): boolean {
  if (need.direct) return o.direct;
  if (need.only) return !o.direct && need.only.includes(o.name);
  if (need.country) return o.country === need.country;
  if (o.onRequest) return false;
  return !need.avoid || !o.country || !need.avoid.includes(o.country);
}

function needText(need: ExitNeed): string {
  if (need.direct) return 'прямого выхода нет';
  if (need.only) return `нет выхода из ${need.only.join(', ')}`;
  if (need.country) return `нет выхода в стране ${need.country}`;
  if (need.avoid) return `нет выхода вне ${need.avoid.join(', ')}`;
  return 'нет ни одного выхода';
}

export type Connected = {
  socket: Socket;
  outlet: Outlet;
  /** Выходы, через которые не вышло, прежде чем получилось. */
  failed: string[];
};

export type ChooserOptions = {
  stickyMs: number;
  connectTimeoutMs: number;
  onFailure: (outlet: Outlet, error: unknown) => void;
  log: Logger;
  /** Как соединяться через выход; по умолчанию — SOCKS по имени (в тестах). */
  dial?: Dial;
  /** Сервис по имени сайта — ключ прилипания; по умолчанию — само имя. */
  serviceOf?: (host: string) => string;
  /** Самообучение: что открывалось через какой выход и страну (`outcomes.ts`). */
  outcomes?: OutcomeBook;
  /** Замеры скорости для правил «самый быстрый» (`speed.ts`). */
  speed?: SpeedBook;
  /** Страна сервиса на диске (`sticky.ts`); нет — только в памяти. */
  sticky?: StickyBook;
};

export class NoOutletError extends Error {
  constructor(host: string, port: number, errors: string[], excluded: number, need: ExitNeed = {}, locked: string | null = null) {
    const where = locked ? ` в стране ${locked} (другую страну не берём)` : '';
    super(errors.length > 0
      ? `ни один выход${where} не открыл ${host}:${port} — ${errors.join('; ')}`
      : excluded > 0 ? `других выходов${where} нет` : locked ? `нет выхода${where}` : needText(need));
  }
}

/** Свободный выбор — без требования правила к выходу; только его держит страна сервиса. */
function free(need: ExitNeed): boolean {
  return !need.only && !need.country && !need.direct;
}

type Plan = { list: Outlet[]; locked: string | null };

export class Chooser {
  /** Сервис → выход, где открылся, и его страна. */
  private readonly sticky: StickyBook;
  private readonly outlets: Outlet[];
  private readonly opts: ChooserOptions;

  constructor(outlets: Outlet[], opts: ChooserOptions) {
    this.outlets = outlets;
    this.opts = opts;
    this.sticky = opts.sticky ?? new StickyBook({ file: null, log: opts.log });
  }

  /**
   * `port` не задан — порт неважен (проверки, тесты): только приоритет и живость.
   * `keep` — страна первого выхода этого соединения: повтор не уходит из неё.
   */
  order(host: string, port?: number, now = Date.now(), need: ExitNeed = {}, keep: string | null = null): Outlet[] {
    return this.plan(host, port, now, need, keep).list;
  }

  private plan(host: string, port: number | undefined, now: number, need: ExitNeed, keep: string | null): Plan {
    const key = this.service(host);
    // Порт, потом выученное (хорошие → неизвестные → плохие: плохие не выкидываем — вдруг больше некому).
    const learned = (o: Outlet): number => this.opts.outcomes?.rank(key, o, now) ?? 0;
    const rank = (o: Outlet): number => (port === undefined ? 0 : portRank(o, port)) * 3 + learned(o);
    const byPriority = this.outlets.filter((o) => fitsNeed(o, need)).sort((a, b) =>
      rank(a) - rank(b) || a.priority - b.priority || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || a.name.localeCompare(b.name));
    // Запасной (не поднят, ждёт своей очереди в группе соперников) не годится никогда.
    // «Не через» страны: выход, чью страну ещё не узнали, может оказаться той самой — только если других нет.
    const sure = need.avoid ? byPriority.filter((o) => o.country !== null) : byPriority;
    const up = (sure.length > 0 ? sure : byPriority).filter((o) => o.state !== 'standby');

    const stuck = free(need) ? this.sticky.get(key, now) : null;
    // Замок страны: только выходы страны сервиса (или первого выхода соединения), живые — раньше мёртвых;
    // выходов этой страны нет — пустой список, отказ. Правило «не через» эту страну — замок не держит: страну выбрало правило.
    const wanted = keep ?? stuck?.country ?? null;
    const locked = wanted && !need.avoid?.includes(wanted) ? wanted : null;
    const pool = locked ? up.filter((o) => o.country === locked) : up;
    const usable = pool.filter((o) => o.state !== 'dead');
    const list = usable.length > 0 ? usable : pool;

    // Прилипание к выходу сильнее приоритета, но не сильнее порта и выученного: выход, который этот порт режет или где сервис не открывается, вперёд не пойдёт.
    if (need.fastest && this.opts.speed) return { list: this.fastest(key, list, stuck?.name ?? null, rank, now), locked };
    if (!stuck) return { list, locked };
    const index = list.findIndex((o) => o.name === stuck.name);
    if (index > 0 && rank(list[index] as Outlet) <= rank(list[0] as Outlet)) list.unshift(...list.splice(index, 1));
    return { list, locked };
  }

  /**
   * «Самый быстрый» — только внутри страны первого кандидата (прилипшей или
   * лучшей по приоритету): страну держим на весь сервис, а между выходами одной
   * страны выбирает скорость, с гистерезисом вместо прилипания к выходу.
   */
  private fastest(key: string, list: Outlet[], current: string | null, tier: (o: Outlet) => number, now: number): Outlet[] {
    const country = list[0]?.country ?? null;
    const same = list.filter((o) => o.country === country);
    const r = (this.opts.speed as SpeedBook).rank(key, same, current, { tier, now });
    if (r.switched) this.opts.log.info(`${key}: ${r.reason}`);
    return [...r.order, ...list.filter((o) => o.country !== country)];
  }

  /** Сервис сайта — ключ прилипания, самообучения и замеров. */
  serviceKey(host: string): string {
    return this.service(host);
  }

  private service(host: string): string {
    return this.opts.serviceOf ? this.opts.serviceOf(host) : host;
  }

  /** Отказ выхода, замеченный уже после соединения (закрыл, не ответив) — на проверку. */
  noteFailure(outlet: Outlet, why: string): void {
    this.opts.onFailure(outlet, new Error(why));
  }

  /**
   * Сайт ответил через выход — сервис прилипает к его стране (и продлевает
   * срок). Только у свободного выбора: выход по требованию правила страну
   * сервиса не переносит (Google push по правилу через США не уводит весь
   * Google из Германии).
   */
  confirm(host: string, outlet: Outlet, need: ExitNeed = {}, now = Date.now()): void {
    if (this.opts.stickyMs > 0 && free(need)) this.sticky.set(this.service(host), { name: outlet.name, country: outlet.country, until: now + this.opts.stickyMs });
  }

  /** Записать прилипание на диск сейчас — при остановке. */
  stop(): void {
    this.sticky.stop();
  }

  /** Исход соединения сайта через выход — самообучению, по сервису сайта. */
  noteOutcome(host: string, outlet: Outlet, outcome: Outcome): void {
    this.opts.outcomes?.record(this.service(host), outlet, outcome);
  }

  /** `keep` — страна, из которой это соединение не уходит (первый выход его же повтора). */
  async connect(host: string, port: number, exclude: ReadonlySet<string> = new Set(), need: ExitNeed = {}, keep: string | null = null): Promise<Connected> {
    const errors: string[] = [];
    const { list, locked } = this.plan(host, port, Date.now(), need, keep);
    for (const outlet of list) {
      if (exclude.has(outlet.name)) continue;
      try {
        const socket = this.opts.dial
          ? await this.opts.dial(outlet, host, port)
          : await dialVia(outlet, host, port, this.opts.connectTimeoutMs);
        return { socket, outlet, failed: errors.map((e) => e.split(':')[0] as string) };
      } catch (error) {
        errors.push(`${outlet.name}: ${errorText(error)}`);
        this.opts.onFailure(outlet, error);
        const kind = failureKind(error);
        if (kind) this.noteOutcome(host, outlet, kind);
      }
    }
    throw new NoOutletError(host, port, errors, exclude.size, need, locked);
  }

  /** Сколько сайтов сейчас прилипло — для экрана и логов. */
  stickyCount(now = Date.now()): number {
    return this.sticky.count(now);
  }
}
