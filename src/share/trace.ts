import { appendFile, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { errorText, type Logger } from '../log.ts';
import type { Outlet } from '../outlets/outlet.ts';
import { SHARE_PREFIX, type ShareStore } from './store.ts';

/**
 * Запись сайтов телефона для разбора — только у телефона, где её включили в
 * панели (владелец 2026-10-02, чтобы найти, какой запрос Госуслуг уходит в
 * туннель): время, сайт, порт, выход, страна. Только то, что телефон прислал
 * через Contour, — прямое Contour и не видит. Файл на день в папке журналов
 * (`share-trace-ГГГГ-ММ-ДД.log`, строка — JSON), старше `days` дней удаляется.
 * Без содержимого: Contour видит только имя и порт.
 */

const PREFIX = 'share-trace-';
const DAY_MS = 86_400_000;

const day = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export class ShareTrace {
  private readonly store: ShareStore;
  private readonly dir: string;
  private readonly days: number;
  private readonly log: Logger;
  private on = new Map<string, string>();
  private pruned = '';
  private warned = false;

  constructor(opts: { store: ShareStore; dir: string; days: number; log: Logger }) {
    this.store = opts.store;
    this.dir = opts.dir;
    this.days = opts.days;
    this.log = opts.log;
    this.refresh();
    this.store.onChange(() => this.refresh());
    // Чистка — и когда никто не пишет: выключил запись — старые файлы всё равно уходят в срок.
    setInterval(() => this.prune(Date.now(), day(Date.now())), 6 * 3_600_000).unref();
    this.prune(Date.now(), day(Date.now()));
  }

  /** Соединение потребителя `who` открылось через выход — записать, если это телефон с записью. */
  note(who: string, host: string, port: number, outlet: Outlet, now = Date.now()): void {
    if (!who.startsWith(SHARE_PREFIX)) return;
    const name = this.on.get(who.slice(SHARE_PREFIX.length));
    if (!name) return;
    const today = day(now);
    if (today !== this.pruned) this.prune(now, today);
    const line = `${JSON.stringify({ at: new Date(now).toISOString(), device: name, host, port, outlet: outlet.name, country: outlet.country })}\n`;
    appendFile(path.join(this.dir, `${PREFIX}${today}.log`), line, (error) => {
      if (error && !this.warned) { this.warned = true; this.log.warn(`запись сайтов: не пишется в ${this.dir} — ${errorText(error)}`); }
    });
  }

  private refresh(): void {
    this.on = new Map(this.store.devices().filter((d) => d.enabled && d.trace).map((d) => [d.id, d.name]));
  }

  /** Раз в день: файлы старше `days` дней — долой. */
  private prune(now: number, today: string): void {
    this.pruned = today;
    const keep = new Set(Array.from({ length: this.days }, (_, i) => `${PREFIX}${day(now - i * DAY_MS)}.log`));
    try {
      for (const f of readdirSync(this.dir)) if (f.startsWith(PREFIX) && !keep.has(f)) rmSync(path.join(this.dir, f), { force: true });
    } catch {
      // папки нет — запись сама скажет
    }
  }
}
