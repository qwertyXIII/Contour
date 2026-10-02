import type { Collector } from './collect.ts';
import { toName } from './names.ts';
import type { Action } from './types.ts';

/**
 * Файлы v2fly domain-list-community (`data/<name>`): `domain:x` или голое `x`
 * — с поддоменами, `full:x` — только само, `keyword:`/`regexp:` — подстрока и
 * выражение (не умеем), `include:name` — другой файл целиком. Атрибуты
 * (`@cn`, `@ads`, `@!cn`, `&…`) отбрасываем: они про то, какой кусок списка
 * брать китайским клиентам, а нам нужен весь сервис. Один разбор строки — и
 * для правил (`parse.ts`), и для групп сервисов (`services.ts`).
 */

export type V2flyItem = { kind: 'domain' | 'full' | 'keyword' | 'regexp' | 'include'; value: string };

/** Имя файла в `data/`: `google`, `bytedance-ai-!cn`, `geolocation-!cn`. Без `/` и `..` — оно же имя копии на диске. */
export const V2FLY_NAME = /^[a-z0-9][a-z0-9!_-]*(?:\.[a-z0-9!_-]+)*$/;

const KINDS = new Set(['domain', 'full', 'keyword', 'regexp', 'include']);

/** Строка → запись; пустая и комментарий — null; непонятная — 'bad'. */
export function v2flyLine(raw: string): V2flyItem | 'bad' | null {
  const t = raw.replace(/#.*$/, '').trim();
  if (!t) return null;
  const head = t.split(/\s+/)[0] as string;
  const colon = head.indexOf(':');
  const kind = colon > 0 ? head.slice(0, colon).toLowerCase() : 'domain';
  const value = colon > 0 ? head.slice(colon + 1) : head;
  if (!KINDS.has(kind) || !value) return 'bad';
  if (kind === 'keyword' || kind === 'regexp') return { kind, value };
  if (kind === 'include') return V2FLY_NAME.test(value.toLowerCase()) ? { kind, value: value.toLowerCase() } : 'bad';
  const name = toName(value, kind === 'domain');
  return name ? { kind: kind as 'domain' | 'full', value: name } : 'bad';
}

/** Файл → записи (непонятное — мимо): для `RemoteList` и копии на диске. */
export function parseV2flyFile(text: string): V2flyItem[] {
  const out: V2flyItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const item = v2flyLine(line);
    if (item && item !== 'bad') out.push(item);
  }
  return out;
}

/** Обратно в строку того же формата: копия на диске читается тем же `parseV2flyFile`. */
export function formatV2flyItem(item: V2flyItem): string {
  return `${item.kind}:${item.value}`;
}

/** Строки v2fly как правила: всё — одним назначением загрузки, `include:` — ссылкой. */
export function parseV2flyRules(lines: Iterable<{ no: number; text: string }>, out: Collector, load: Action): void {
  for (const { no, text } of lines) {
    const item = v2flyLine(text);
    if (item === null) continue;
    if (item === 'bad') out.error(no, text.trim(), 'не строка v2fly');
    else if (item.kind === 'include') out.include(item.value, 'v2fly', load, no);
    else if (item.kind === 'keyword' || item.kind === 'regexp') out.skip(`${item.kind}:`);
    else out.add(no, { kind: 'domain', name: item.value, exact: item.kind === 'full' }, load);
  }
}
