import { createLogger, type LogEntry, type Logger } from './vendor/logger.js';

/**
 * Логи Contour.
 *
 * Сам логгер — общий для проектов владельца, лежит в `src/vendor/logger.js`
 * как есть и обновляется копированием. Здесь только настройка.
 *
 * В файл — один JSON на строку с префиксом времени `2026-08-01 05:50:51.777: `.
 * У Alter'а этот префикс ставит PM2; Contour живёт под systemd, который ничего
 * не дописывает, поэтому префикс ставим сами — в том же формате, его ждёт
 * просмотрщик логов владельца.
 *
 * В терминале — короткая строка для человека. Признак — TTY; `ssh сервер 'cmd'`
 * идёт без псевдотерминала и получит JSON, конвейер забирает TTY у stdout, —
 * отсюда оба переключателя: `CONTOUR_LOG_PRETTY=1` и `CONTOUR_LOG_JSON=1`.
 */

const pretty = process.env.CONTOUR_LOG_JSON === '1'
  ? false
  : process.env.CONTOUR_LOG_PRETTY === '1' || process.stdout.isTTY === true;

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const level = LEVELS.has(process.env.CONTOUR_LOG_LEVEL ?? '')
  ? (process.env.CONTOUR_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error')
  : 'info';

const COLOR: Record<string, string> = {
  debug: '\u001b[90m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  graph: '\u001b[36m',
};
const RESET = '\u001b[0m';

/** Местное время, как у PM2 (`YYYY-MM-DD HH:mm:ss.SSS`). */
function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function prettyWriter(type: string, _line: string, entry: LogEntry): void {
  const time = new Date(entry.timeStamp).toTimeString().slice(0, 8);
  const color = COLOR[type] ?? '';
  if (type === 'graph') {
    const value = entry.points ? JSON.stringify(entry.points) : String(entry.value);
    process.stdout.write(`${time} ${color}graph${RESET} ${entry.name} = ${value}\n`);
    return;
  }
  const [first, ...rest] = entry.content ?? [];
  const extra = rest.length > 0 ? ` ${rest.map((v) => JSON.stringify(v)).join(' ')}` : '';
  process.stdout.write(`${time} ${color}${type}${RESET}: ${String(first)}${extra}\n`);
}

/** Всё в stdout, ошибки тоже: один файл, один дескриптор, строки не перемешиваются. */
function jsonWriter(_type: string, line: string, entry: LogEntry): void {
  process.stdout.write(`${stamp(entry.timeStamp)}: ${line}\n`);
}

/**
 * Журнал для панели — последние записи info и выше, в памяти. Берётся
 * из того же лога дополнительным приёмником логгера: всё, что Contour и так
 * пишет (выход упал/поднялся, переключение, отказы), попадает сюда без
 * отдельной проводки событий. Строки mihomo в журнал не идут — их много и
 * они на его языке.
 */
export type JournalEntry = { t: number; level: string; text: string; src: string | null };
const JOURNAL_MAX = 300;
export const journal: JournalEntry[] = [];

function toJournal(entry: LogEntry): void {
  if (entry.type !== 'info' && entry.type !== 'warn' && entry.type !== 'error') return;
  const src = typeof entry.src === 'string' ? entry.src : null;
  if (src === 'mihomo') return;
  const [first] = entry.content ?? [];
  journal.push({ t: entry.timeStamp, level: entry.type, text: String(first ?? ''), src });
  if (journal.length > JOURNAL_MAX) journal.splice(0, journal.length - JOURNAL_MAX);
}

export const log: Logger = createLogger({
  level,
  context: { app: 'contour' },
  trace: !pretty,
  writer: pretty ? prettyWriter : jsonWriter,
  sink: toJournal,
});

export type { Logger };

/** Текст ошибки для лога и ответа клиенту — без стека. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
