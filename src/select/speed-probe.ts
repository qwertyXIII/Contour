import { errorText, type Logger } from '../log.ts';
import type { OutletState } from '../outlets/outlet.ts';
import type { ProbeResult, SpeedBook } from './speed.ts';

/**
 * Редкая активная проба скорости выхода — там, где живого трафика нет.
 *
 * Зачем, если есть пассивные замеры: выход, через который никто не ходит
 * (запасной в стране), ни TTFB, ни скорости не накопит, а задержка проверки
 * живости меряет маленький запрос — и не видит выход, который отвечает бодро, а
 * качает 35 КБ/с (AWG в mihomo, README, 2026-10-01). Проба — единственное, что
 * такой выход выдаст до того, как на него переведут сервис.
 *
 * Это не гонка: проба — наше скачивание с сервера замеров (`panel/speedtest.ts`,
 * тот же путь, что ручной замер в панели), не соединение пользователя через два
 * выхода. И она бережная:
 * - только живой выход, у которого пассивных замеров скорости меньше `minTransfers`;
 * - один выход не чаще `everyMs`, даже если проба не удалась;
 * - одна проба за раз и не больше одной за `tickMs` на весь Contour;
 * - маленький объём (`bytes`, по умолчанию 4 МБ) — несколько мегабайт в сутки на выход.
 *
 * Что именно качать, решает тот, кто встраивает (`download`); в тестах — подставная.
 */

export type ProbeDownload = (outlet: string, bytes: number) => Promise<ProbeResult>;
export type ProbeTarget = { name: string; state: OutletState };

export type ProbeOptions = {
  download: ProbeDownload;
  /** Выходы сейчас — живой список, а не копия: состояние меняет проверка живости. */
  outlets: () => readonly ProbeTarget[];
  log: Logger;
  everyMs?: number;
  tickMs?: number;
  firstTickMs?: number;
  bytes?: number;
};

const EVERY_MS = 6 * 3_600_000;
const TICK_MS = 10 * 60_000;
/** После запуска — не сразу: выходы ещё поднимаются, и живой трафик может успеть сам. */
const FIRST_TICK_MS = 15 * 60_000;
const BYTES = 4_000_000;

export class SpeedProbe {
  private readonly book: SpeedBook;
  private readonly opts: ProbeOptions;
  private readonly every: number;
  private busy = false;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(book: SpeedBook, opts: ProbeOptions) {
    this.book = book;
    this.opts = opts;
    this.every = opts.everyMs ?? EVERY_MS;
  }

  /** Какой выход пробовать сейчас: давно не пробованный первым; null — никакой. */
  due(now = Date.now()): string | null {
    if (this.busy) return null;
    const need = this.book.tuning.minTransfers;
    const at = (name: string): number => this.book.probedAt(name) ?? -Infinity;
    const ready = this.opts.outlets()
      .filter((o) => o.state === 'alive' && this.book.passiveCount(o.name, now) < need && now - at(o.name) >= this.every)
      .sort((a, b) => at(a.name) - at(b.name) || a.name.localeCompare(b.name));
    return ready[0]?.name ?? null;
  }

  /** Одна проба, если пора; вернёт имя выхода, который пробовали. */
  async tick(now = Date.now()): Promise<string | null> {
    const name = this.due(now);
    if (name === null) return null;
    this.busy = true;
    this.book.markProbed(name, now);
    try {
      const r = await this.opts.download(name, this.opts.bytes ?? BYTES);
      this.book.noteProbe(name, r, now);
      const speed = r.ms > 0 ? `${Math.round((r.bytes * 8) / (r.ms / 1000) / 1e5) / 10} Мбит/с` : '—';
      this.opts.log.info(`проба скорости «${name}»: ${r.bytes} Б за ${r.ms} мс — ${speed}${typeof r.firstByteMs === 'number' ? `, первый байт ${r.firstByteMs} мс` : ''}`);
    } catch (error) {
      this.opts.log.warn(`проба скорости «${name}» не удалась — ${errorText(error)}`);
    } finally {
      this.busy = false;
    }
    return name;
  }

  start(): void {
    const first = setTimeout(() => {
      void this.tick();
      const every = setInterval(() => void this.tick(), this.opts.tickMs ?? TICK_MS);
      every.unref();
      this.timers.push(every);
    }, this.opts.firstTickMs ?? FIRST_TICK_MS);
    first.unref();
    this.timers.push(first);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
  }
}
