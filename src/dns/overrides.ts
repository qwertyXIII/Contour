import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inSet } from './lists.ts';

/**
 * Ручные решения владельца из панели: «этот сайт — всегда через VPN» или
 * «никогда через VPN». Сильнее списков и самообучения.
 *
 * Файл `overrides.json` в папке DNS: пишет панель (процесс Contour), читает
 * `contour-dns` — проверяет, не поменялся ли, раз в несколько секунд. Оба
 * процесса — пользователь `contour`, так что нужен только общий файл, а не
 * канал между процессами.
 */

export type Via = 'tunnel' | 'direct';
export type OverrideMap = Record<string, Via>;

const RECHECK_MS = 3_000;
const NAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

export function overridesFile(dir: string): string {
  return path.join(dir, 'overrides.json');
}

export function normalizeSite(name: string): string {
  const n = name.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '').replace(/\.$/, '');
  if (!NAME.test(n)) throw new Error(`«${name}» — не имя сайта`);
  return n;
}

export function readOverrides(dir: string): OverrideMap {
  try {
    const raw = JSON.parse(readFileSync(overridesFile(dir), 'utf8')) as Record<string, string>;
    const out: OverrideMap = {};
    for (const [k, v] of Object.entries(raw)) if (v === 'tunnel' || v === 'direct') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Поставить (или снять — `via: null`) ручное решение. Пишет панель. */
export function writeOverride(dir: string, name: string, via: Via | null): OverrideMap {
  const site = normalizeSite(name);
  const all = readOverrides(dir);
  if (via) all[site] = via; else delete all[site];
  mkdirSync(dir, { recursive: true });
  const file = overridesFile(dir);
  writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 1));
  renameSync(`${file}.tmp`, file);
  return all;
}

/** Чтение для DNS: само перечитывает файл, если он поменялся. */
export class Overrides {
  private tunnel = new Set<string>();
  private direct = new Set<string>();
  private mtime = -1;
  private checkedAt = 0;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.refresh(true);
  }

  private refresh(force = false): void {
    const now = Date.now();
    if (!force && now - this.checkedAt < RECHECK_MS) return;
    this.checkedAt = now;
    let m = -1;
    try {
      m = statSync(overridesFile(this.dir)).mtimeMs;
    } catch {
      // файла нет — решений нет
    }
    if (m === this.mtime) return;
    this.mtime = m;
    const all = readOverrides(this.dir);
    this.tunnel = new Set(Object.keys(all).filter((k) => all[k] === 'tunnel'));
    this.direct = new Set(Object.keys(all).filter((k) => all[k] === 'direct'));
  }

  /** Ручное решение для имени (с учётом родителей), или null. Ближайшее к имени — сильнее. */
  match(name: string): Via | null {
    this.refresh();
    const t = inSet(name, this.tunnel);
    const d = inSet(name, this.direct);
    if (t && d) return t.length >= d.length ? 'tunnel' : 'direct';
    return t ? 'tunnel' : d ? 'direct' : null;
  }
}
