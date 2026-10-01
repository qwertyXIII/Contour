import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readOverrides, writeOverride, type OverrideMap, type Via } from '../dns/overrides.ts';

/**
 * Сайты для панели: что идёт через VPN и почему.
 *
 * Источники — файлы процесса `contour-dns` в его папке: выученное
 * (`dns-learned.json`), копия общего списка (`blocked-domains.lst`), ручные
 * решения (`overrides.json`, сюда панель и пишет). Сайты с трафиком — из
 * счётчика Contour.
 */

export type Learned = { name: string; via: Via; why: string; until: number };

export class Sites {
  private readonly dir: string;
  private readonly own: string[];

  constructor(opts: { dnsDir: string; own: string[] }) {
    this.dir = opts.dnsDir;
    this.own = opts.own;
  }

  learned(): Learned[] {
    try {
      const raw = JSON.parse(readFileSync(path.join(this.dir, 'dns-learned.json'), 'utf8')) as Record<string, { via: Via; why: string; until: number }>;
      const now = Date.now();
      return Object.entries(raw)
        .filter(([, e]) => e.until > now)
        .map(([name, e]) => ({ name, via: e.via, why: e.why, until: e.until }));
    } catch {
      return [];
    }
  }

  commonCount(): number {
    try {
      return readFileSync(path.join(this.dir, 'blocked-domains.lst'), 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  overrides(): OverrideMap {
    return readOverrides(this.dir);
  }

  /** `tunnel` / `direct` — ручное решение; `auto` — снять ручное, решат списки и самообучение. */
  set(name: string, via: Via | 'auto'): OverrideMap {
    return writeOverride(this.dir, name, via === 'auto' ? null : via);
  }

  summary(): { own: string[]; common: number; learnedTunnel: Learned[]; overrides: OverrideMap } {
    return {
      own: this.own,
      common: this.commonCount(),
      learnedTunnel: this.learned().filter((l) => l.via === 'tunnel').sort((a, b) => a.name.localeCompare(b.name)),
      overrides: this.overrides(),
    };
  }
}
