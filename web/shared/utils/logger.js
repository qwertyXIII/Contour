/* ============================================================
   Universal structured logger.

   Один JSON-объект на строку. Временной префикс вида
   «2026-07-19 15:54:01.777:» добавляет внешняя обвязка — PM2,
   Docker, systemd и т. п.

   Лог-запись (формат совместим с просмотрщиком логов):
     {"type":"info","timeStamp":1784451254782,"app":"metis",
      "runId":"...","content":["message",{}],
      "trace":{"caller_file":"engine.js","line_number":177,
               "caller_method":"out.<computed>"}}

   Граф-точка (.graph — данные для отрисовки во времени):
     {"type":"graph","timeStamp":...,"app":"metis","runId":"...",
      "name":"rps","value":38}                     // одна линия
     {"type":"graph",...,"name":"net","points":{"rx":100,"tx":50}} // серии
     Необязательно: "graphType":"line|bar|heatmap|band|…", "meta":{…}.
     Общий с логами timeStamp и context (app/runId) → графы и логи
     выстраиваются на одной оси времени.
   ============================================================ */

const DEFAULT_REDACT_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'authorization',
  'proxy-authorization',
  'api_key',
  'apiKey',
  'apikey',
  'private_key',
  'privateKey',
  'client_secret',
  'clientSecret',
  'cookie',
  'set-cookie',
];

/**
 * Преобразует строковое значение в boolean.
 *
 * @param {*} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();

  return !['0', 'false', 'off', 'no', 'disabled'].includes(normalized);
}

/**
 * Безопасно читает переменную окружения.
 * Не падает в средах без process.env.
 *
 * @param {string} name
 * @returns {string|undefined}
 */
function getEnv(name) {
  try {
    if (
      typeof process !== 'undefined' &&
      process &&
      process.env
    ) {
      return process.env[name];
    }
  } catch {
    // Среда может запрещать доступ к process.
  }

  return undefined;
}

/**
 * Нормализует уровень логирования.
 *
 * @param {*} level
 * @param {string} fallback
 * @returns {'debug'|'info'|'warn'|'error'}
 */
function normalizeLevel(level, fallback = 'debug') {
  const value = String(level || '').trim().toLowerCase();

  if (value === 'debug') return 'debug';
  if (value === 'info') return 'info';
  if (value === 'warn' || value === 'warning') return 'warn';
  if (value === 'error' || value === 'fatal') return 'error';

  return fallback;
}

const LEVEL_WEIGHT = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

/**
 * Возвращает basename пути без зависимости от node:path.
 *
 * @param {string} filePath
 * @returns {string}
 */
function getBaseName(filePath) {
  if (!filePath) return 'unknown';

  const normalized = String(filePath).replace(/\\/g, '/');
  const parts = normalized.split('/');

  return parts[parts.length - 1] || 'unknown';
}

/**
 * Извлекает имя метода из строки stack trace.
 *
 * @param {string} stackLine
 * @returns {string}
 */
function parseCallerMethod(stackLine) {
  const trimmed = String(stackLine || '').trim();

  let match = trimmed.match(
    /^at\s+(?:async\s+)?(.+?)\s+\((?:file:\/\/\/)?[^)]+:\d+:\d+\)$/,
  );

  if (match) {
    return match[1].trim() || 'unknown';
  }

  match = trimmed.match(
    /^at\s+(?:async\s+)?(.+?)\s+(?:file:\/\/\/)?.+:\d+:\d+$/,
  );

  if (match) {
    const candidate = match[1].trim();

    if (
      candidate &&
      !candidate.includes('/') &&
      !candidate.includes('\\')
    ) {
      return candidate;
    }
  }

  return 'unknown';
}

/**
 * Извлекает путь, строку и колонку из stack frame.
 *
 * Поддерживает варианты:
 *   at fn (/path/file.js:10:20)
 *   at /path/file.js:10:20
 *   at fn (file:///path/file.js:10:20)
 *
 * @param {string} stackLine
 * @returns {{filePath: string, lineNumber: number}|null}
 */
function parseStackLocation(stackLine) {
  const line = String(stackLine || '').trim();

  const parenthesized = line.match(
    /\((?:file:\/\/\/)?(.+):(\d+):(\d+)\)$/,
  );

  if (parenthesized) {
    return {
      filePath: parenthesized[1],
      lineNumber: Number.parseInt(parenthesized[2], 10) || 0,
    };
  }

  const direct = line.match(
    /at\s+(?:async\s+)?(?:file:\/\/\/)?(.+):(\d+):(\d+)$/,
  );

  if (direct) {
    return {
      filePath: direct[1],
      lineNumber: Number.parseInt(direct[2], 10) || 0,
    };
  }

  return null;
}

/**
 * Определяет, является ли stack frame внутренним кадром логгера.
 *
 * Фильтрация специально не привязана только к имени logger.js,
 * поэтому файл можно переименовать.
 *
 * @param {string} stackLine
 * @param {string[]} internalFunctionNames
 * @param {string[]} internalFileNames
 * @returns {boolean}
 */
function isInternalStackFrame(
  stackLine,
  internalFunctionNames,
  internalFileNames,
) {
  const line = String(stackLine || '');

  for (const functionName of internalFunctionNames) {
    if (
      line.includes(`at ${functionName} `) ||
      line.includes(`at ${functionName} (`) ||
      line.includes(`at Object.${functionName} `) ||
      line.includes(`at Object.${functionName} (`)
    ) {
      return true;
    }
  }

  const location = parseStackLocation(line);

  if (location) {
    const baseName = getBaseName(location.filePath);

    if (internalFileNames.includes(baseName)) {
      return true;
    }
  }

  return false;
}

/**
 * Извлекает информацию о вызывающем коде.
 *
 * Stack trace в JavaScript не стандартизирован полностью, поэтому
 * это best-effort механизм. При невозможности разбора возвращается
 * unknown вместо исключения.
 *
 * @param {object} [options]
 * @param {string[]} [options.internalFileNames]
 * @returns {{
 *   caller_file: string,
 *   line_number: number,
 *   caller_method: string
 * }}
 */
function getCallerInfo(options = {}) {
  const {
    internalFileNames = [
      'logger.js',
      'logger.mjs',
      'logger.cjs',
      'structured-logger.js',
    ],
  } = options;

  const unknown = {
    caller_file: 'unknown',
    line_number: 0,
    caller_method: 'unknown',
  };

  try {
    const error = new Error();

    if (!error.stack) return unknown;

    const stackLines = error.stack.split('\n').slice(1);

    const internalFunctionNames = [
      'getCallerInfo',
      'write',
      'log',
      'debug',
      'info',
      'warn',
      'error',
      'emit',
    ];

    for (const stackLine of stackLines) {
      if (
        isInternalStackFrame(
          stackLine,
          internalFunctionNames,
          internalFileNames,
        )
      ) {
        continue;
      }

      const location = parseStackLocation(stackLine);

      if (!location) continue;

      return {
        caller_file: getBaseName(location.filePath),
        line_number: location.lineNumber,
        caller_method: parseCallerMethod(stackLine),
      };
    }
  } catch {
    // Получение trace никогда не должно ломать логирование.
  }

  return unknown;
}

/**
 * Проверяет, является ли значение Promise-подобным.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isPromiseLike(value) {
  return Boolean(
    value &&
    (
      typeof value === 'object' ||
      typeof value === 'function'
    ) &&
    typeof value.then === 'function',
  );
}

/**
 * Создаёт Set нормализованных ключей для маскирования.
 *
 * @param {string[]} keys
 * @returns {Set<string>}
 */
function createRedactSet(keys) {
  return new Set(
    keys.map(key => String(key).trim().toLowerCase()),
  );
}

/**
 * Проверяет, нужно ли скрыть поле.
 *
 * @param {string} key
 * @param {Set<string>} redactSet
 * @returns {boolean}
 */
function shouldRedactKey(key, redactSet) {
  return redactSet.has(String(key).trim().toLowerCase());
}

/**
 * Безопасно сериализует произвольное JavaScript-значение.
 *
 * Поддерживает:
 * - circular references;
 * - Error;
 * - BigInt;
 * - Symbol;
 * - Function;
 * - Map;
 * - Set;
 * - Date;
 * - RegExp;
 * - Buffer;
 * - typed arrays;
 * - ограничение глубины;
 * - ограничение длины массивов;
 * - ограничение количества ключей;
 * - маскирование секретов.
 *
 * @param {*} value
 * @param {object} options
 * @param {WeakSet<object>} seen
 * @param {number} depth
 * @param {string} currentKey
 * @returns {*}
 */
function normalizeValue(
  value,
  options,
  seen,
  depth = 0,
  currentKey = '',
) {
  const {
    maxDepth,
    maxArrayLength,
    maxObjectKeys,
    maxStringLength,
    redactSet,
    redactValue,
  } = options;

  if (currentKey && shouldRedactKey(currentKey, redactSet)) {
    return redactValue;
  }

  if (value === undefined) {
    return '[undefined]';
  }

  if (value === null) {
    return null;
  }

  const valueType = typeof value;

  if (valueType === 'string') {
    if (value.length <= maxStringLength) return value;

    return `${value.slice(0, maxStringLength)}… [truncated ${value.length - maxStringLength} chars]`;
  }

  if (
    valueType === 'number' ||
    valueType === 'boolean'
  ) {
    if (Number.isNaN(value)) return '[NaN]';
    if (value === Infinity) return '[Infinity]';
    if (value === -Infinity) return '[-Infinity]';

    return value;
  }

  if (valueType === 'bigint') {
    return `${value.toString()}n`;
  }

  if (valueType === 'symbol') {
    return value.toString();
  }

  if (valueType === 'function') {
    return `[Function: ${value.name || 'anonymous'}]`;
  }

  if (depth >= maxDepth) {
    return '[MaxDepth]';
  }

  if (value instanceof Error) {
    const errorData = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };

    if ('cause' in value && value.cause !== undefined) {
      errorData.cause = normalizeValue(
        value.cause,
        options,
        seen,
        depth + 1,
        'cause',
      );
    }

    for (const key of Object.keys(value)) {
      if (key in errorData) continue;

      try {
        errorData[key] = normalizeValue(
          value[key],
          options,
          seen,
          depth + 1,
          key,
        );
      } catch {
        errorData[key] = '[Unserializable]';
      }
    }

    return errorData;
  }

  if (value instanceof Date) {
    const time = value.getTime();

    return Number.isNaN(time)
      ? '[Invalid Date]'
      : value.toISOString();
  }

  if (value instanceof RegExp) {
    return value.toString();
  }

  if (
    typeof Buffer !== 'undefined' &&
    typeof Buffer.isBuffer === 'function' &&
    Buffer.isBuffer(value)
  ) {
    return {
      type: 'Buffer',
      length: value.length,
      preview: value
        .subarray(0, Math.min(value.length, 64))
        .toString('base64'),
      truncated: value.length > 64,
    };
  }

  if (ArrayBuffer.isView?.(value)) {
    const array = Array.from(
      value.subarray
        ? value.subarray(0, maxArrayLength)
        : value,
    );

    return {
      type: value.constructor?.name || 'TypedArray',
      length: value.length,
      values: array,
      truncated: value.length > maxArrayLength,
    };
  }

  if (value instanceof ArrayBuffer) {
    return {
      type: 'ArrayBuffer',
      byteLength: value.byteLength,
    };
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, maxArrayLength);

      const result = [];

      for (let index = 0; index < limit; index++) {
        try {
          result.push(
            normalizeValue(
              value[index],
              options,
              seen,
              depth + 1,
              String(index),
            ),
          );
        } catch {
          result.push('[Unserializable]');
        }
      }

      if (value.length > limit) {
        result.push(
          `[Truncated ${value.length - limit} items]`,
        );
      }

      return result;
    }

    if (value instanceof Map) {
      const entries = [];
      let index = 0;

      for (const [mapKey, mapValue] of value.entries()) {
        if (index >= maxObjectKeys) {
          entries.push([
            '[Truncated]',
            `${value.size - maxObjectKeys} entries`,
          ]);
          break;
        }

        entries.push([
          normalizeValue(
            mapKey,
            options,
            seen,
            depth + 1,
            'mapKey',
          ),
          normalizeValue(
            mapValue,
            options,
            seen,
            depth + 1,
            String(mapKey),
          ),
        ]);

        index++;
      }

      return {
        type: 'Map',
        size: value.size,
        entries,
      };
    }

    if (value instanceof Set) {
      const values = [];
      let index = 0;

      for (const item of value.values()) {
        if (index >= maxArrayLength) {
          values.push(
            `[Truncated ${value.size - maxArrayLength} items]`,
          );
          break;
        }

        values.push(
          normalizeValue(
            item,
            options,
            seen,
            depth + 1,
            String(index),
          ),
        );

        index++;
      }

      return {
        type: 'Set',
        size: value.size,
        values,
      };
    }

    const result = {};
    let keys;

    try {
      keys = Object.keys(value);
    } catch {
      return '[Unserializable Object]';
    }

    const limit = Math.min(keys.length, maxObjectKeys);

    for (let index = 0; index < limit; index++) {
      const key = keys[index];

      if (shouldRedactKey(key, redactSet)) {
        result[key] = redactValue;
        continue;
      }

      try {
        result[key] = normalizeValue(
          value[key],
          options,
          seen,
          depth + 1,
          key,
        );
      } catch {
        result[key] = '[Unserializable]';
      }
    }

    if (keys.length > limit) {
      result.__truncatedKeys = keys.length - limit;
    }

    return result;
  } finally {
    seen.delete(value);
  }
}

/**
 * Нормализует аргументы логирования.
 *
 * @param {Array<*>} args
 * @param {object} options
 * @returns {Array<*>}
 */
function serializeArgs(args, options) {
  const seen = new WeakSet();

  return args.map(arg => {
    try {
      return normalizeValue(arg, options, seen);
    } catch {
      return '[Unserializable]';
    }
  });
}

/**
 * Безопасно превращает запись в JSON.
 *
 * @param {object} entry
 * @param {number} maxEntryLength
 * @returns {string}
 */
function stringifyEntry(entry, maxEntryLength) {
  let json;

  try {
    json = JSON.stringify(entry);
  } catch (error) {
    json = JSON.stringify({
      type: 'error',
      timeStamp: Date.now(),
      content: [
        'logger: failed to serialize log entry',
        {
          name: error?.name || 'Error',
          message: error?.message || String(error),
        },
      ],
    });
  }

  if (
    Number.isFinite(maxEntryLength) &&
    maxEntryLength > 0 &&
    json.length > maxEntryLength
  ) {
    const truncatedEntry = {
      type: entry.type,
      timeStamp: entry.timeStamp,
      ...getSafeContext(entry),
      content: [
        '[Log entry truncated]',
        {
          originalLength: json.length,
          maxEntryLength,
        },
      ],
    };

    if (entry.trace) {
      truncatedEntry.trace = entry.trace;
    }

    return JSON.stringify(truncatedEntry);
  }

  return json;
}

/**
 * Извлекает контекст без системных полей.
 *
 * @param {object} entry
 * @returns {object}
 */
function getSafeContext(entry) {
  const result = {};

  for (const [key, value] of Object.entries(entry)) {
    if (
      key === 'type' ||
      key === 'timeStamp' ||
      key === 'content' ||
      key === 'trace'
    ) {
      continue;
    }

    result[key] = value;
  }

  return result;
}

/**
 * Стандартный Node.js writer.
 *
 * Сохраняет привычную маршрутизацию:
 * - debug/info → stdout;
 * - warn/error → stderr.
 *
 * @param {'debug'|'info'|'warn'|'error'} type
 * @param {string} line
 */
function defaultWriter(type, line) {
  if (
    typeof process !== 'undefined' &&
    process &&
    process.stdout &&
    process.stderr
  ) {
    const stream =
      type === 'warn' || type === 'error'
        ? process.stderr
        : process.stdout;

    stream.write(`${line}\n`);
    return;
  }

  const method =
    type === 'error'
      ? 'error'
      : type === 'warn'
        ? 'warn'
        : type === 'debug'
          ? 'debug'
          : 'log';

  const consoleMethod =
    typeof console?.[method] === 'function'
      ? console[method]
      : console.log;

  consoleMethod.call(console, line);
}

/**
 * Создаёт универсальный структурный логгер.
 *
 * @param {object} [options]
 *
 * @param {boolean} [options.enabled=true]
 * Полностью включает или выключает логгер.
 *
 * @param {boolean} [options.graphs=true]
 * Включает метод .graph (точки графиков).
 * По умолчанию берётся из METIS_LOG_GRAPHS / LOG_GRAPHS.
 *
 * @param {boolean} [options.trace]
 * Добавляет caller_file, line_number и caller_method.
 * По умолчанию берётся из METIS_LOG_TRACE / LOG_TRACE.
 *
 * @param {'debug'|'info'|'warn'|'error'} [options.level]
 * Минимальный уровень логирования.
 * По умолчанию берётся из METIS_LOG_LEVEL / LOG_LEVEL.
 *
 * @param {object} [options.context]
 * Поля, которые добавляются в каждую запись:
 * app, component, runId, graphId, nodeId и т. д.
 *
 * @param {function} [options.sink]
 * Дополнительный приёмник готового объекта записи.
 * Может быть синхронным или возвращать Promise.
 *
 * @param {function} [options.writer]
 * Функция непосредственного вывода:
 * writer(type, jsonLine, entry).
 *
 * @param {string[]} [options.redactKeys]
 * Имена полей, значения которых нужно скрывать.
 *
 * @param {string} [options.redactValue='[REDACTED]']
 *
 * @param {number} [options.maxDepth=8]
 * Максимальная глубина сериализации объектов.
 *
 * @param {number} [options.maxArrayLength=100]
 *
 * @param {number} [options.maxObjectKeys=100]
 *
 * @param {number} [options.maxStringLength=20000]
 *
 * @param {number} [options.maxEntryLength=100000]
 * Максимальная длина одной JSON-строки.
 *
 * @param {string[]} [options.internalFileNames]
 * Имена файлов логгера, пропускаемые в stack trace.
 *
 * @returns {{
 *   debug: function(...*): void,
 *   info: function(...*): void,
 *   warn: function(...*): void,
 *   error: function(...*): void,
 *   log: function(...*): void,
 *   graph: function(string, *, object=): void,
 *   child: function(object=, object=): object,
 *   isLevelEnabled: function(string): boolean
 * }}
 */
export function createLogger(options = {}) {
  const envTrace =
    getEnv('METIS_LOG_TRACE') ??
    getEnv('LOG_TRACE');

  const envLevel =
    getEnv('METIS_LOG_LEVEL') ??
    getEnv('LOG_LEVEL');

  const envGraphs =
    getEnv('METIS_LOG_GRAPHS') ??
    getEnv('LOG_GRAPHS');

  const {
    enabled = true,
    graphs = parseBool(envGraphs, true),
    trace = parseBool(envTrace, true),
    level = normalizeLevel(envLevel, 'debug'),
    context = {},
    sink = null,
    writer = defaultWriter,

    redactKeys = DEFAULT_REDACT_KEYS,
    redactValue = '[REDACTED]',

    maxDepth = 8,
    maxArrayLength = 100,
    maxObjectKeys = 100,
    maxStringLength = 20_000,
    maxEntryLength = 100_000,

    internalFileNames = [
      'logger.js',
      'logger.mjs',
      'logger.cjs',
      'structured-logger.js',
    ],
  } = options;

  const normalizedLevel = normalizeLevel(level, 'debug');
  const minimumWeight = LEVEL_WEIGHT[normalizedLevel];

  const serializationOptions = {
    maxDepth,
    maxArrayLength,
    maxObjectKeys,
    maxStringLength,
    redactSet: createRedactSet(redactKeys),
    redactValue,
  };

  function isLevelEnabled(type) {
    if (!enabled) return false;

    const normalizedType = normalizeLevel(type, 'info');

    return LEVEL_WEIGHT[normalizedType] >= minimumWeight;
  }

  function callSink(entry) {
    if (typeof sink !== 'function') return;

    try {
      const result = sink(entry);

      if (isPromiseLike(result)) {
        Promise.resolve(result).catch(() => {
          // Сбой дополнительного sink не должен ронять приложение.
        });
      }
    } catch {
      // Сбой дополнительного sink не должен ронять приложение.
    }
  }

  function write(type, args) {
    const normalizedType = normalizeLevel(type, 'info');

    if (!isLevelEnabled(normalizedType)) return;

    try {
      /*
       * Контекст располагается до системных полей.
       * Поэтому context не может подменить type, timeStamp,
       * content или trace.
       */
      const entry = {
        ...context,
        type: normalizedType,
        timeStamp: Date.now(),
        content: serializeArgs(args, serializationOptions),
      };

      if (trace) {
        entry.trace = getCallerInfo({
          internalFileNames,
        });
      }

      const jsonLine = stringifyEntry(
        entry,
        maxEntryLength,
      );

      try {
        writer(normalizedType, jsonLine, entry);
      } catch {
        // Сбой stdout/stderr не должен пробрасываться из вызова log.
      }

      callSink(entry);
    } catch {
      // Последний рубеж: вызов логгера не должен ломать бизнес-код.
    }
  }

  // ── Графы ─────────────────────────────────────────────────
  // .graph(name, value[, opts]) пишет строку type:"graph" в тот же поток,
  // что и логи. name обязателен — по нему группируется график. value —
  // число|строка|null (одна линия) либо объект серий (мультилиния → points).
  // opts.graphType — подсказка рендереру, прочие ключи opts → meta.
  // Аддитивно к формату логов и, как и логи, никогда не бросает.
  const GRAPH_TYPES = ['line', 'area', 'bar', 'scatter', 'heatmap', 'band'];

  // Значение точки → JSON-безопасное число|строка|null.
  // Нефинитные числа → null (разрыв линии); boolean → 1/0; не-скаляр → undefined.
  function toGraphScalar(value) {
    if (value === null || value === undefined) return null;

    switch (typeof value) {
      case 'number':
        return Number.isFinite(value) ? value : null;
      case 'boolean':
        return value ? 1 : 0;
      case 'string':
        return value.length <= maxStringLength
          ? value
          : value.slice(0, maxStringLength);
      default:
        return undefined;
    }
  }

  function emitGraph(name, value, opts) {
    if (!enabled || !graphs) return;

    if (typeof name !== 'string' || name.trim() === '') {
      write('warn', ['logger.graph: имя графика обязательно (точка отброшена)']);
      return;
    }

    try {
      // context — до системных полей: не может подменить type/timeStamp/name.
      const entry = {
        ...context,
        type: 'graph',
        timeStamp: Date.now(),
        name,
      };

      const isSeries =
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value);

      if (isSeries) {
        const points = {};
        let count = 0;

        for (const key of Object.keys(value)) {
          if (count >= maxObjectKeys) break;
          const scalar = toGraphScalar(value[key]);
          points[key] = typeof scalar === 'number' ? scalar : null;
          count++;
        }

        entry.points = points;
      } else {
        const scalar = toGraphScalar(value);

        if (scalar === undefined) {
          write('warn', [
            'logger.graph: значение должно быть числом, строкой или объектом серий (точка отброшена)',
            { name },
          ]);
          return;
        }

        entry.value = scalar;
      }

      if (opts && typeof opts === 'object') {
        const { graphType, ...hints } = opts;

        if (typeof graphType === 'string' && graphType) {
          entry.graphType = graphType;
        }

        if (Object.keys(hints).length) {
          entry.meta = normalizeValue(hints, serializationOptions, new WeakSet());
        }
      }

      const jsonLine = stringifyEntry(entry, maxEntryLength);

      try {
        writer('graph', jsonLine, entry);
      } catch {
        // Сбой stdout/stderr не должен пробрасываться из .graph.
      }

      callSink(entry);
    } catch {
      // .graph, как и логи, никогда не роняет бизнес-код.
    }
  }

  // Публичный .graph + сахар по типам: .graph.line / .bar / .heatmap / …
  function graph(name, value, opts) {
    emitGraph(name, value, opts);
  }

  for (const graphType of GRAPH_TYPES) {
    graph[graphType] = (name, value, opts) =>
      emitGraph(name, value, { ...opts, graphType });
  }

  const api = {
    debug(...args) {
      write('debug', args);
    },

    info(...args) {
      write('info', args);
    },

    warn(...args) {
      write('warn', args);
    },

    error(...args) {
      write('error', args);
    },

    log(...args) {
      write('info', args);
    },

    graph,

    isLevelEnabled,

    /**
     * Создаёт дочерний логгер.
     *
     * @param {object} [extra]
     * @param {object} [childOptions]
     *
     * Доступные переопределения:
     * - sink;
     * - writer;
     * - enabled;
     * - trace;
     * - level.
     *
     * @returns {object}
     */
    child(extra = {}, childOptions = {}) {
      return createLogger({
        ...options,

        enabled:
          childOptions.enabled !== undefined
            ? childOptions.enabled
            : enabled,

        trace:
          childOptions.trace !== undefined
            ? childOptions.trace
            : trace,

        graphs:
          childOptions.graphs !== undefined
            ? childOptions.graphs
            : graphs,

        level:
          childOptions.level !== undefined
            ? childOptions.level
            : normalizedLevel,

        context: {
          ...context,
          ...extra,
        },

        sink:
          childOptions.sink !== undefined
            ? childOptions.sink
            : sink,

        writer:
          childOptions.writer !== undefined
            ? childOptions.writer
            : writer,

        redactKeys,
        redactValue,
        maxDepth,
        maxArrayLength,
        maxObjectKeys,
        maxStringLength,
        maxEntryLength,
        internalFileNames,
      });
    },
  };

  return Object.freeze(api);
}

/**
 * Логгер по умолчанию.
 *
 * В инфраструктурном коде может импортироваться напрямую.
 * В бизнес-логике предпочтительнее передавать логгер через ctx.
 */
export const logger = createLogger();