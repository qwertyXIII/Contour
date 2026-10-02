import { isIP } from 'node:net';
import { parse as parseHost } from 'tldts';
import type { V2flyItem } from './v2fly.ts';

/**
 * «Сервис» сайта — ключ прилипания: страну держим на весь сервис, а не на
 * имя (решение владельца: за «телепортацию» между странами выкидывают из
 * учёток). Сервис — группа из готового списка, если имя в неё входит, иначе
 * основной домен (eTLD+1).
 *
 * Основной домен — по списку публичных суффиксов **с частным разделом**
 * (`allowPrivateDomains`): `a.github.io` и `b.github.io`, `x.vercel.app` и
 * `y.vercel.app` — разные сервисы. Частный раздел и есть граница кук, а учётка
 * живёт в куках: два хозяина на одной площадке друг другу не учётка. Без него
 * первый попавшийся сайт на Vercel держал бы страну за все сайты Vercel.
 *
 * Группа сильнее основного домена — и под частным суффиксом тоже:
 * `youtubei.googleapis.com` — Google, хотя `googleapis.com` в частном разделе.
 * Лишняя склейка стоит гибкости, лишний разрез — учётки. Цена — чужие сайты
 * на площадках, которые группа называет целиком (`x.appspot.com`,
 * `user.github.io` — Google и GitHub): они стоят на тех же входах компании,
 * блокируются и открываются вместе с ней. Площадки с чужим «за ними» (AWS,
 * Azure) отрезаются набором `platforms` (`services.ts`).
 */

const HOST_OPTIONS = { allowPrivateDomains: true, extractHostname: false, detectIp: false, validateHostname: false } as const;

const clean = (host: string): string => host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/** Основной домен без групп: IP — сам адрес, одна метка и сам суффикс (`co.uk`) — само имя. */
export function siteOf(host: string): string {
  const h = clean(host);
  if (!h.includes('.') || isIP(h)) return h;
  return parseHost(h, HOST_OPTIONS).domain ?? h;
}

/** Файлы групп для сборки: имя файла → записи (не скачан — нет в карте). */
export type GroupFiles = ReadonlyMap<string, readonly V2flyItem[]>;

export type IndexStats = {
  /** Группа → сколько имён в неё собралось (с `include:`). */
  names: Record<string, number>;
  /** `keyword:`/`regexp:` — в группах не умеем; сколько таких строк. */
  skipped: number;
  /** На какие файлы есть `include:`, а их нет (не скачаны, нет такого) — имена. */
  missing: string[];
  /** Какие файлы вошли хоть в одну группу (остальные — лишние, их можно не качать). */
  reachable: Set<string>;
};

export const INDEX_LIMITS = { maxDepth: 8 };

/**
 * Индекс «имя → группа»: точные имена и суффиксы в двух картах, поиск — по
 * меткам от длинного к короткому, без перебора групп. Зовётся на каждое
 * соединение.
 */
export class ServiceIndex {
  private readonly exact = new Map<string, string>();
  private readonly suffix = new Map<string, string>();
  readonly stats: IndexStats = { names: {}, skipped: 0, missing: [], reachable: new Set() };

  /**
   * Группа — файл и всё, что он включает, вглубь (с защитой от циклов и
   * пределом глубины). `include:` другой группы из набора — граница: её имена
   * остаются её. Так набор `[microsoft, github]` держит GitHub отдельно, хоть
   * `microsoft` и включает `github`. `platforms` — площадки, где живут чужие
   * сайты (AWS, Azure, Firebase): их не втягиваем ни в какую группу. Имя в двух
   * группах — за той, что раньше в наборе.
   */
  constructor(groups: readonly string[], files: GroupFiles, platforms: readonly string[] = [], maxDepth = INDEX_LIMITS.maxDepth) {
    const stop = new Set([...groups, ...platforms]);
    const missing = new Set<string>();
    for (const group of groups) {
      // Вширь, по уровням: файл, до которого есть короткий путь, не обрежется пределом из-за длинного.
      const seen = new Set([group]);
      let level = [group];
      let count = 0;
      for (let depth = 0; level.length > 0 && depth <= maxDepth; depth++) {
        const next: string[] = [];
        for (const name of level) {
          const items = files.get(name);
          if (!items) {
            missing.add(name);
            continue;
          }
          this.stats.reachable.add(name);
          for (const item of items) {
            if (item.kind === 'include') {
              if (!stop.has(item.value) && !seen.has(item.value)) {
                seen.add(item.value);
                next.push(item.value);
              }
            } else if (item.kind === 'keyword' || item.kind === 'regexp') {
              this.stats.skipped++;
            } else {
              const map = item.kind === 'full' ? this.exact : this.suffix;
              if (!map.has(item.value)) map.set(item.value, group);
              count++;
            }
          }
        }
        level = next;
      }
      this.stats.names[group] = count;
    }
    this.stats.missing = [...missing].sort();
  }

  /** Группа имени или null. Точное — сильнее суффикса, длинный суффикс — сильнее короткого. */
  groupOf(host: string): string | null {
    let n = clean(host);
    const hit = this.exact.get(n);
    if (hit) return hit;
    for (;;) {
      const g = this.suffix.get(n);
      if (g) return g;
      const dot = n.indexOf('.');
      if (dot < 0) return null;
      n = n.slice(dot + 1);
    }
  }

  /** Сервис: группа, иначе основной домен (`siteOf`). */
  serviceOf(host: string): string {
    const h = clean(host);
    if (isIP(h)) return h;
    return this.groupOf(h) ?? siteOf(h);
  }
}
