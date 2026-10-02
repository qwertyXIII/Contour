import type { Socket } from 'node:net';
import { dialVia } from '../dial.ts';
import type { Dial } from '../outlets/connect.ts';
import { errorText, type Logger } from '../log.ts';
import type { Outlet } from '../outlets/outlet.ts';
import { portRank } from '../outlets/ports.ts';
import { failureKind, type Outcome, type OutcomeBook } from './outcomes.ts';
import type { SpeedBook } from './speed.ts';

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
 * - Прилипание — **страна на весь сервис** (владелец 2026-10-02: за
 *   «телепортацию» выкидывают из учёток и могут забанить): сервис (основной
 *   домен или группа доменов — `serviceOf`) держится страны выхода, где
 *   открылся, `stickyMs`; первым идёт тот же выход, за ним — другие выходы той
 *   же страны, остальные страны — только когда в ней не осталось ни одного.
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
};

export class NoOutletError extends Error {
  constructor(host: string, port: number, errors: string[], excluded: number, need: ExitNeed = {}) {
    super(errors.length > 0
      ? `ни один выход не открыл ${host}:${port} — ${errors.join('; ')}`
      : excluded > 0 ? 'других выходов нет' : needText(need));
  }
}

export class Chooser {
  /** Сервис → выход, где открылся, и его страна. */
  private readonly sticky = new Map<string, { name: string; country: string | null; until: number }>();
  private readonly outlets: Outlet[];
  private readonly opts: ChooserOptions;

  constructor(outlets: Outlet[], opts: ChooserOptions) {
    this.outlets = outlets;
    this.opts = opts;
  }

  /** `port` не задан — порт неважен (проверки, тесты): только приоритет и живость. */
  order(host: string, port?: number, now = Date.now(), need: ExitNeed = {}): Outlet[] {
    const key = this.service(host);
    // Порт, потом выученное (хорошие → неизвестные → плохие: плохие не выкидываем — вдруг больше некому).
    const learned = (o: Outlet): number => this.opts.outcomes?.rank(key, o, now) ?? 0;
    const rank = (o: Outlet): number => (port === undefined ? 0 : portRank(o, port)) * 3 + learned(o);
    const byPriority = this.outlets.filter((o) => fitsNeed(o, need)).sort((a, b) =>
      rank(a) - rank(b) || a.priority - b.priority || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || a.name.localeCompare(b.name));
    // Запасной (не поднят, ждёт своей очереди в группе соперников) не годится никогда.
    const up = byPriority.filter((o) => o.state !== 'standby');
    const usable = up.filter((o) => o.state !== 'dead');
    const list = usable.length > 0 ? usable : up;

    // Прилипание сильнее приоритета, но не сильнее порта и выученного: выход, который этот порт режет или где сервис не открывается, вперёд не пойдёт.
    let stuck = this.sticky.get(key) ?? null;
    if (stuck && stuck.until <= now) { this.sticky.delete(key); stuck = null; }
    // Страна — вперёд целиком (порядок внутри сохраняется), остальные страны — за ней.
    const country = stuck?.country ?? null;
    const home = country ? list.filter((o) => o.country === country) : [];
    const ordered = home.length > 0 ? [...home, ...list.filter((o) => o.country !== country)] : list;
    if (need.fastest && this.opts.speed) return this.fastest(key, ordered, stuck?.name ?? null, rank, now);
    if (!stuck) return ordered;
    const index = ordered.findIndex((o) => o.name === stuck.name);
    if (index > 0 && rank(ordered[index] as Outlet) <= rank(ordered[0] as Outlet)) ordered.unshift(...ordered.splice(index, 1));
    return ordered;
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

  /** Исход соединения сайта через выход — самообучению, по сервису сайта. */
  noteOutcome(host: string, outlet: Outlet, outcome: Outcome): void {
    this.opts.outcomes?.record(this.service(host), outlet, outcome);
  }

  async connect(host: string, port: number, exclude: ReadonlySet<string> = new Set(), need: ExitNeed = {}): Promise<Connected> {
    const errors: string[] = [];
    for (const outlet of this.order(host, port, Date.now(), need)) {
      if (exclude.has(outlet.name)) continue;
      try {
        const socket = this.opts.dial
          ? await this.opts.dial(outlet, host, port)
          : await dialVia(outlet, host, port, this.opts.connectTimeoutMs);
        if (this.opts.stickyMs > 0) this.sticky.set(this.service(host), { name: outlet.name, country: outlet.country, until: Date.now() + this.opts.stickyMs });
        return { socket, outlet, failed: errors.map((e) => e.split(':')[0] as string) };
      } catch (error) {
        errors.push(`${outlet.name}: ${errorText(error)}`);
        this.opts.onFailure(outlet, error);
        const kind = failureKind(error);
        if (kind) this.noteOutcome(host, outlet, kind);
      }
    }
    throw new NoOutletError(host, port, errors, exclude.size, need);
  }

  /** Сколько сайтов сейчас прилипло — для экрана и логов. */
  stickyCount(now = Date.now()): number {
    let n = 0;
    for (const s of this.sticky.values()) if (s.until > now) n += 1;
    return n;
  }
}
