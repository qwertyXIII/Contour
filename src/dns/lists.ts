import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { errorText, type Logger } from '../log.ts';

/**
 * Списки сайтов, которые сразу идут через VPN.
 *
 * Свой (`lan.domains` + `lan.extraDomains`) и общие по ссылке (`lan.lists`, по
 * умолчанию itdoginfo/allow-domains «Russia inside» — 1183 сайта на 2026-10-01,
 * его же ставят на Keenetic). Общий скачивается раз в сутки напрямую и
 * кладётся копией на диск: GitHub недоступен — работаем по вчерашнему.
 *
 * Список нужен и при самообучении: проверка соединением ловит только
 * «не открывается», а замедление (YouTube) и отказ «из России нельзя»
 * (ChatGPT отвечает 403 после нормального соединения) видны только по списку.
 */

const REFRESH_MS = 24 * 3_600_000;
const RETRY_MS = 3_600_000;
const FETCH_TIMEOUT_MS = 30_000;
const NAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** Строки файла списка → имена: комментарии, `*.`, пробелы и мусор — прочь. */
export function parseList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '').replace(/\.$/, '');
    if (NAME.test(line)) out.push(line);
  }
  return out;
}

/** Совпадение имени или любого его родителя с набором: `a.b.instagram.com` → `instagram.com`. */
export function inSet(name: string, set: ReadonlySet<string>): string | null {
  let n = name.toLowerCase().replace(/\.$/, '');
  for (;;) {
    if (set.has(n)) return n;
    const dot = n.indexOf('.');
    if (dot < 0) return null;
    n = n.slice(dot + 1);
  }
}

export class Lists {
  private own: Set<string>;
  private common = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly urls: string[];
  private readonly cacheFile: string;
  private readonly log: Logger;

  constructor(opts: { own: string[]; urls: string[]; cacheDir: string; log: Logger }) {
    this.own = new Set(opts.own);
    this.urls = opts.urls;
    this.cacheFile = path.join(opts.cacheDir, 'blocked-domains.lst');
    this.log = opts.log;
  }

  /** Какой записью списка совпало имя — для лога; null — ни с какой. */
  match(name: string): string | null {
    return inSet(name, this.own) ?? inSet(name, this.common);
  }

  size(): { own: number; common: number } {
    return { own: this.own.size, common: this.common.size };
  }

  /** Копия с диска сразу, свежая из сети — в фоне, потом раз в сутки. */
  start(): void {
    try {
      this.common = new Set(parseList(readFileSync(this.cacheFile, 'utf8')));
      this.log.info(`общий список с диска: ${this.common.size} сайтов`);
    } catch {
      // первый запуск — копии ещё нет
    }
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private async refresh(): Promise<void> {
    if (this.urls.length === 0) return;
    const names = new Set<string>();
    const failed: string[] = [];
    for (const url of this.urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for (const n of parseList(await res.text())) names.add(n);
      } catch (error) {
        failed.push(`${url}: ${errorText(error)}`);
      }
    }
    if (names.size > 0 && failed.length === 0) {
      this.common = names;
      try {
        mkdirSync(path.dirname(this.cacheFile), { recursive: true });
        writeFileSync(`${this.cacheFile}.tmp`, `${[...names].sort().join('\n')}\n`);
        renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
      } catch (error) {
        this.log.warn(`общий список: не сохранить копию — ${errorText(error)}`);
      }
      this.log.info(`общий список обновлён: ${names.size} сайтов`);
      this.schedule(REFRESH_MS);
    } else {
      this.log.warn(`общий список не обновился (работаю по копии, ${this.common.size} сайтов): ${failed.join('; ')}`);
      this.schedule(RETRY_MS);
    }
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => { void this.refresh(); }, ms);
    this.timer.unref();
  }
}
