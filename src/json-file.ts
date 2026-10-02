import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Состояние на диске одним JSON-файлом: прочитать с запасным значением и
 * записать атомарно — во временный файл рядом и переименованием, чтобы
 * выключение посреди записи не оставило половину файла.
 */

/** Нет файла или он битый — `fallback`: состояние — подсказка, не повод не запуститься. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** `mode` — права файла (600 для тайн); папка создаётся, если её нет. */
export function writeJson(file: string, data: unknown, mode = 0o644): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}
