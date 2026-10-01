import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { errorText, type Logger } from '../log.ts';

/**
 * Список по ссылкам с копией на диске — для общего списка сайтов (`lists.ts`) и
 * подсетей шлюза (`subnets.ts`). Скачивается напрямую раз в сутки; все ссылки
 * — или ни одной: половина списка опаснее вчерашнего целого. GitHub
 * недоступен — работаем по копии, повтор через час.
 */

const REFRESH_MS = 24 * 3_600_000;
const RETRY_MS = 3_600_000;
const FETCH_TIMEOUT_MS = 30_000;

export type RemoteListOptions<T> = {
  urls: string[];
  cacheFile: string;
  /** Текст файла → записи; повторы уберёт `key`. */
  parse: (text: string) => T[];
  key: (item: T) => string;
  format: (item: T) => string;
  /** Новые записи — с диска при запуске или из сети. */
  onUpdate: (items: T[], from: 'disk' | 'net') => void;
  /** «общий список», «подсети шлюза» — для журнала. */
  label: string;
  log: Logger;
};

export class RemoteList<T> {
  private readonly opts: RemoteListOptions<T>;
  private timer: NodeJS.Timeout | null = null;
  private count = 0;

  constructor(opts: RemoteListOptions<T>) {
    this.opts = opts;
  }

  start(): void {
    try {
      const items = this.opts.parse(readFileSync(this.opts.cacheFile, 'utf8'));
      this.count = items.length;
      this.opts.onUpdate(items, 'disk');
    } catch {
      // первый запуск — копии ещё нет
    }
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private async refresh(): Promise<void> {
    if (this.opts.urls.length === 0) return;
    const items = new Map<string, T>();
    const failed: string[] = [];
    for (const url of this.opts.urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for (const item of this.opts.parse(await res.text())) items.set(this.opts.key(item), item);
      } catch (error) {
        failed.push(`${url}: ${errorText(error)}`);
      }
    }
    if (items.size > 0 && failed.length === 0) {
      const list = [...items.values()];
      this.count = list.length;
      this.save(list);
      this.opts.onUpdate(list, 'net');
      this.schedule(REFRESH_MS);
    } else {
      this.opts.log.warn(`${this.opts.label} не обновился (работаю по копии, ${this.count} записей): ${failed.join('; ')}`);
      this.schedule(RETRY_MS);
    }
  }

  private save(list: T[]): void {
    try {
      mkdirSync(path.dirname(this.opts.cacheFile), { recursive: true });
      writeFileSync(`${this.opts.cacheFile}.tmp`, `${list.map(this.opts.format).sort().join('\n')}\n`);
      renameSync(`${this.opts.cacheFile}.tmp`, this.opts.cacheFile);
    } catch (error) {
      this.opts.log.warn(`${this.opts.label}: не сохранить копию — ${errorText(error)}`);
    }
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => { void this.refresh(); }, ms);
    this.timer.unref();
  }
}
