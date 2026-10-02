import type { Socket } from 'node:net';
import { dialVia } from '../dial.ts';
import type { Dial } from '../outlets/connect.ts';
import { errorText, type Logger } from '../log.ts';
import type { Outlet } from '../outlets/outlet.ts';
import { portRank } from '../outlets/ports.ts';

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
 * - Прилипание: сайт ходит через выход, где открылся, `stickyMs`. Сайт,
 *   который видит тебя то из одной страны, то из другой, выкидывает из входа.
 * - Выхода «напрямую» здесь нет по построению: умерли все — ошибка, не утечка.
 *   Прямой выход (`config.direct`) — выход как выход, но по умолчанию «по
 *   просьбе»: его видит только соединение, которое просит его страну.
 * - Страна выхода (`need.country`): соединение просит, например, Россию —
 *   выбор только среди выходов этой страны (и «по просьбе» тоже); подходящего
 *   нет — отказ, а не выход из другой страны: Госуслугам заграничный адрес
 *   хуже, чем никакого.
 */

/** Чего соединение требует от выхода. */
export type ExitNeed = { country?: string };

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
};

export class NoOutletError extends Error {
  constructor(host: string, port: number, errors: string[], excluded: number, need: ExitNeed = {}) {
    super(errors.length > 0
      ? `ни один выход не открыл ${host}:${port} — ${errors.join('; ')}`
      : excluded > 0 ? 'других выходов нет' : need.country ? `нет выхода в стране ${need.country}` : 'нет ни одного выхода');
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

  /** `port` не задан — порт неважен (проверки, тесты): только приоритет и живость. */
  order(host: string, port?: number, now = Date.now(), need: ExitNeed = {}): Outlet[] {
    const rank = (o: Outlet): number => (port === undefined ? 0 : portRank(o, port));
    const wanted = need.country;
    const fits = (o: Outlet): boolean => (wanted ? o.country === wanted : !o.onRequest);
    const byPriority = this.outlets.filter(fits).sort((a, b) =>
      rank(a) - rank(b) || a.priority - b.priority || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || a.name.localeCompare(b.name));
    // Запасной (не поднят, ждёт своей очереди в группе соперников) не годится никогда.
    const up = byPriority.filter((o) => o.state !== 'standby');
    const usable = up.filter((o) => o.state !== 'dead');
    const list = usable.length > 0 ? usable : up;

    // Прилипание сильнее приоритета, но не сильнее порта: выход, который этот порт режет, вперёд не пойдёт.
    const stuck = this.sticky.get(host);
    if (stuck && stuck.until > now) {
      const index = list.findIndex((o) => o.name === stuck.name);
      if (index > 0 && rank(list[index] as Outlet) <= rank(list[0] as Outlet)) list.unshift(...list.splice(index, 1));
    } else if (stuck) {
      this.sticky.delete(host);
    }
    return list;
  }

  /** Отказ выхода, замеченный уже после соединения (закрыл, не ответив) — на проверку. */
  noteFailure(outlet: Outlet, why: string): void {
    this.opts.onFailure(outlet, new Error(why));
  }

  async connect(host: string, port: number, exclude: ReadonlySet<string> = new Set(), need: ExitNeed = {}): Promise<Connected> {
    const errors: string[] = [];
    for (const outlet of this.order(host, port, Date.now(), need)) {
      if (exclude.has(outlet.name)) continue;
      try {
        const socket = this.opts.dial
          ? await this.opts.dial(outlet, host, port)
          : await dialVia(outlet, host, port, this.opts.connectTimeoutMs);
        if (this.opts.stickyMs > 0) this.sticky.set(host, { name: outlet.name, until: Date.now() + this.opts.stickyMs });
        return { socket, outlet, failed: errors.map((e) => e.split(':')[0] as string) };
      } catch (error) {
        errors.push(`${outlet.name}: ${errorText(error)}`);
        this.opts.onFailure(outlet, error);
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
