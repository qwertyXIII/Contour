import path from 'node:path';
import type { Logger } from '../log.ts';
import { RemoteList } from './remote-list.ts';

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
  private readonly remote: RemoteList<string>;

  constructor(opts: { own: string[]; urls: string[]; cacheDir: string; log: Logger }) {
    this.own = new Set(opts.own);
    this.remote = new RemoteList<string>({
      urls: opts.urls,
      cacheFile: path.join(opts.cacheDir, 'blocked-domains.lst'),
      parse: parseList,
      key: (n) => n,
      format: (n) => n,
      onUpdate: (names, from) => {
        this.common = new Set(names);
        opts.log.info(from === 'disk' ? `общий список с диска: ${names.length} сайтов` : `общий список обновлён: ${names.length} сайтов`);
      },
      label: 'общий список',
      log: opts.log,
    });
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
    this.remote.start();
  }

  stop(): void {
    this.remote.stop();
  }
}
