/**
 * Типы к `logger.js` — файлу владельца, который лежит здесь КАК ЕСТЬ.
 *
 * Отдельным `.d.ts`, а не переписыванием на TypeScript, ровно по одной
 * причине: логгер общий с другими проектами и обновляется из своего
 * источника. Переписанный, он перестал бы обновляться копированием, и
 * расхождение обнаружилось бы через полгода.
 *
 * Поэтому `src/vendor/` не входит в `include` tsconfig (его никто не
 * проверяет и не компилирует), а сборка кладёт файл в `dist/` копированием —
 * см. скрипт `build` в package.json.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
 type: string;
 timeStamp: number;
 content?: unknown[];
 name?: string;
 value?: number | string | null;
 points?: Record<string, number | null>;
 graphType?: string;
 meta?: unknown;
 trace?: { caller_file: string; line_number: number; caller_method: string };
 [key: string]: unknown;
};

/** Точка графика: одна линия либо набор серий. */
export type GraphValue = number | string | null | Record<string, number | boolean | null>;

export type GraphOptions = { graphType?: string; [key: string]: unknown };

export type GraphFn = {
 (name: string, value: GraphValue, options?: GraphOptions): void;
 line: (name: string, value: GraphValue, options?: GraphOptions) => void;
 area: (name: string, value: GraphValue, options?: GraphOptions) => void;
 bar: (name: string, value: GraphValue, options?: GraphOptions) => void;
 scatter: (name: string, value: GraphValue, options?: GraphOptions) => void;
 heatmap: (name: string, value: GraphValue, options?: GraphOptions) => void;
 band: (name: string, value: GraphValue, options?: GraphOptions) => void;
};

export type Logger = {
 debug: (...args: unknown[]) => void;
 info: (...args: unknown[]) => void;
 warn: (...args: unknown[]) => void;
 error: (...args: unknown[]) => void;
 log: (...args: unknown[]) => void;
 graph: GraphFn;
 isLevelEnabled: (level: string) => boolean;
 child: (extra?: Record<string, unknown>, childOptions?: ChildOptions) => Logger;
};

export type ChildOptions = {
 enabled?: boolean;
 trace?: boolean;
 graphs?: boolean;
 level?: LogLevel;
 sink?: (entry: LogEntry) => unknown;
 writer?: Writer;
};

export type Writer = (type: string, line: string, entry: LogEntry) => void;

export type CreateLoggerOptions = {
 enabled?: boolean;
 graphs?: boolean;
 trace?: boolean;
 level?: LogLevel;
 context?: Record<string, unknown>;
 sink?: (entry: LogEntry) => unknown;
 writer?: Writer;
 redactKeys?: string[];
 redactValue?: string;
 maxDepth?: number;
 maxArrayLength?: number;
 maxObjectKeys?: number;
 maxStringLength?: number;
 maxEntryLength?: number;
 internalFileNames?: string[];
};

export function createLogger(options?: CreateLoggerOptions): Logger;

export const logger: Logger;
