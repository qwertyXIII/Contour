import type { Socket } from 'node:net';
import { dialVia } from '../dial.ts';
import { errorText, type Logger } from '../log.ts';
import type { Outlet } from '../outlets/outlet.ts';

/**
 * Выбор выхода — вся ценность Contour в одном месте.
 *
 * - Порядок: сначала выход, к которому сайт уже прилип, потом живые по
 *   приоритету (при равном — по задержке), мёртвые — в самом конце и только
 *   когда живых нет вовсе: проверка могла отстать от жизни на несколько секунд.
 * - Повтор: не соединилось через первый — сразу через следующий, и клиент
 *   получает ответ только когда соединение уже есть. Отказ одного выхода он
 *   не видит.
 * - Прилипание: сайт ходит через выход, где открылся, `stickyMs`. Сайт,
 *   который видит тебя то из одной страны, то из другой, выкидывает из входа.
 * - Выхода «напрямую» здесь нет по построению: умерли все — ошибка, не утечка.
 */

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
};

export class NoOutletError extends Error {
  constructor(host: string, port: number, errors: string[]) {
    super(errors.length === 0
      ? 'нет ни одного выхода'
      : `ни один выход не открыл ${host}:${port} — ${errors.join('; ')}`);
  }
}

export class Chooser {
  private readonly sticky = new Map<string, { name: string; until: number }>();
  private readonly outlets: Outlet[];
  private readonly opts: ChooserOptions;

  constructor(outlets: Outlet[], opts: ChooserOptions) {
    this.outlets = outlets;
    this.opts = opts;
  }

  order(host: string, now = Date.now()): Outlet[] {
    const byPriority = [...this.outlets].sort((a, b) =>
      a.priority - b.priority || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || a.name.localeCompare(b.name));
    const usable = byPriority.filter((o) => o.state !== 'dead');
    const list = usable.length > 0 ? usable : byPriority;

    const stuck = this.sticky.get(host);
    if (stuck && stuck.until > now) {
      const index = list.findIndex((o) => o.name === stuck.name);
      if (index > 0) list.unshift(...list.splice(index, 1));
    } else if (stuck) {
      this.sticky.delete(host);
    }
    return list;
  }

  /** Отказ выхода, замеченный уже после соединения (закрыл, не ответив) — на проверку. */
  noteFailure(outlet: Outlet, why: string): void {
    this.opts.onFailure(outlet, new Error(why));
  }

  async connect(host: string, port: number, exclude: ReadonlySet<string> = new Set()): Promise<Connected> {
    const errors: string[] = [];
    for (const outlet of this.order(host)) {
      if (exclude.has(outlet.name)) continue;
      try {
        const socket = await dialVia(outlet, host, port, this.opts.connectTimeoutMs);
        if (this.opts.stickyMs > 0) this.sticky.set(host, { name: outlet.name, until: Date.now() + this.opts.stickyMs });
        return { socket, outlet, failed: errors.map((e) => e.split(':')[0] as string) };
      } catch (error) {
        errors.push(`${outlet.name}: ${errorText(error)}`);
        this.opts.onFailure(outlet, error);
      }
    }
    throw new NoOutletError(host, port, errors);
  }

  /** Сколько сайтов сейчас прилипло — для экрана и логов. */
  stickyCount(now = Date.now()): number {
    let n = 0;
    for (const s of this.sticky.values()) if (s.until > now) n += 1;
    return n;
  }
}
