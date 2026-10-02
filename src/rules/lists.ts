import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../json-file.ts';
import { errorText, type Logger } from '../log.ts';
import type { Layer, RuleSource } from './engine.ts';
import type { ParseResult } from './parse.ts';
import type { Action, Entry } from './types.ts';

/**
 * Свои списки владельца (решение 2026-10-02): по ссылке, файлом из панели,
 * руками. У списка — назначение («куда»), выбранное при загрузке; свой формат
 * с разделами задаёт его построчно (`[через: DE]`). Ручной список — слой
 * «ручное», по ссылке и файлом — «загруженное».
 *
 * Текст списка лежит как есть (`list-<id>.txt`): правила разбираются из него
 * при каждой сборке — сменился разбор или назначение, перекачивать не нужно.
 * По ссылке — раз в сутки; не скачалось — работает прежняя копия.
 */

export type ListKind = 'url' | 'file' | 'manual';
export type ListFormat = 'auto' | 'plain' | 'clash' | 'shadowrocket' | 'v2fly' | 'contour';
export type RuleList = {
  id: string; title: string; kind: ListKind; url: string | null; format: ListFormat; action: Action;
  enabled: boolean; created: number; updated: number | null;
  /** Итог последнего разбора — для панели. */
  stats: { format: string; entries: number; skipped: number; errors: number; fenced: number } | null;
  error: string | null;
};
export type Parse = (text: string, opts: { format?: ListFormat; action?: Action }) => ParseResult;

const FILE = 'lists.json';
const MAX_LISTS = 100;
const MAX_BYTES = 5 * 1024 * 1024;
const REFRESH_MS = 24 * 3_600_000;
const FETCH_MS = 30_000;

const layerOf = (kind: ListKind): Layer => (kind === 'manual' ? 'manual' : 'loaded');

export class RuleLists {
  private readonly dir: string;
  private readonly parse: Parse;
  private readonly log: Logger;
  private lists: RuleList[];
  private parsed = new Map<string, { at: number; entries: Entry[] }>();
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: { dir: string; parse: Parse; log: Logger }) {
    this.dir = opts.dir;
    this.parse = opts.parse;
    this.log = opts.log;
    this.lists = readJson<RuleList[]>(path.join(this.dir, FILE), []);
  }

  start(): void {
    void this.refreshDue();
    this.timer = setInterval(() => void this.refreshDue(), 3_600_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  all(): RuleList[] {
    return this.lists.map((l) => ({ ...l }));
  }

  /** Источники для книги: включённые списки, разобранные из текста. */
  sources(): RuleSource[] {
    return this.lists.filter((l) => l.enabled).map((l) => ({ layer: layerOf(l.kind), source: l.title, entries: this.entries(l) }));
  }

  text(id: string): string {
    try {
      return readFileSync(this.textFile(id), 'utf8');
    } catch {
      return '';
    }
  }

  async add(input: { title: string; kind: ListKind; url?: string; text?: string; format: ListFormat; action: Action }): Promise<RuleList> {
    if (this.lists.length >= MAX_LISTS) throw new Error(`списков уже ${MAX_LISTS}`);
    const title = input.title.trim().slice(0, 60);
    if (!title) throw new Error('нужно название');
    if (input.kind === 'url' && !/^https?:\/\/\S+$/.test(input.url ?? '')) throw new Error('ссылка — http(s)://…');
    const list: RuleList = {
      id: randomBytes(4).toString('hex'), title, kind: input.kind, url: input.kind === 'url' ? (input.url as string) : null,
      format: input.format, action: input.action, enabled: true, created: Date.now(), updated: null, stats: null, error: null,
    };
    if (input.kind === 'url') {
      await this.download(list);
      if (list.error) throw new Error(list.error);
    } else {
      this.store(list, input.text ?? '');
    }
    this.lists.push(list);
    this.commit();
    return { ...list };
  }

  /** Сменить название, назначение, формат, включённость или текст (у файла и ручного). */
  update(id: string, patch: Partial<Pick<RuleList, 'title' | 'action' | 'format' | 'enabled'>> & { text?: string }): RuleList {
    const list = this.find(id);
    if (patch.title !== undefined) list.title = patch.title.trim().slice(0, 60) || list.title;
    if (patch.action) list.action = patch.action;
    if (patch.format) list.format = patch.format;
    if (patch.enabled !== undefined) list.enabled = patch.enabled;
    if (patch.text !== undefined) {
      if (list.kind === 'url') throw new Error('список по ссылке меняется на сайте, не здесь');
      this.store(list, patch.text);
    }
    this.parsed.delete(id);
    this.commit();
    return { ...list };
  }

  remove(id: string): void {
    this.find(id);
    this.lists = this.lists.filter((l) => l.id !== id);
    rmSync(this.textFile(id), { force: true });
    this.parsed.delete(id);
    this.commit();
  }

  async refresh(id: string): Promise<RuleList> {
    const list = this.find(id);
    if (list.kind !== 'url') throw new Error('обновляется только список по ссылке');
    await this.download(list);
    this.commit();
    return { ...list };
  }

  private entries(list: RuleList): Entry[] {
    const cached = this.parsed.get(list.id);
    if (cached && cached.at === (list.updated ?? 0)) return cached.entries;
    let r: ParseResult;
    try {
      r = this.parse(this.text(list.id), { format: list.format, action: list.action });
    } catch (error) {
      list.error = errorText(error);
      this.parsed.set(list.id, { at: list.updated ?? 0, entries: [] });
      return [];
    }
    // Частные подсети разбор держит отдельно; назад — только «только через эти
    // выходы»: единственное исключение из ограды (корпоративная сеть).
    const allowed = r.fenced.filter((f) => f.entry.match.kind === 'cidr' && f.entry.action.target.kind === 'only').map((f) => f.entry);
    const entries = [...r.entries, ...allowed];
    list.stats = { format: r.format, entries: entries.length, skipped: Object.values(r.skipped).reduce((a, b) => a + b, 0), errors: r.errors.length, fenced: r.fenced.length - allowed.length };
    this.parsed.set(list.id, { at: list.updated ?? 0, entries });
    return entries;
  }

  private store(list: RuleList, text: string): void {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('список больше 5 МБ');
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.textFile(list.id), text);
    list.updated = Date.now();
    list.error = null;
    this.parsed.delete(list.id);
    this.entries(list);
  }

  private async download(list: RuleList): Promise<void> {
    try {
      const res = await fetch(list.url as string, { signal: AbortSignal.timeout(FETCH_MS) });
      if (!res.ok) throw new Error(`ответ ${res.status}`);
      const text = await res.text();
      this.store(list, text);
      this.log.info(`список «${list.title}»: ${list.stats?.entries ?? 0} правил`);
    } catch (error) {
      list.error = `не скачался: ${errorText(error)}`;
      this.log.warn(`список «${list.title}» ${list.error}`);
    }
  }

  private async refreshDue(): Promise<void> {
    let changed = false;
    for (const l of this.lists) {
      if (l.kind !== 'url' || !l.enabled || (l.updated && Date.now() - l.updated < REFRESH_MS)) continue;
      await this.download(l);
      changed = true;
    }
    if (changed) this.commit();
  }

  private find(id: string): RuleList {
    const l = this.lists.find((x) => x.id === id);
    if (!l) throw new Error('такого списка нет');
    return l;
  }

  private textFile(id: string): string {
    return path.join(this.dir, `list-${id}.txt`);
  }

  private commit(): void {
    writeJson(path.join(this.dir, FILE), this.lists);
    for (const fn of this.listeners) fn();
  }
}
