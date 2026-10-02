import { describeMatch, fenceReason, matchKey, type Token } from './names.ts';
import type { Action, Entry, Match } from './types.ts';

/**
 * Итог разбора списка и то, что его собирает: каждый формат (`parse.ts`)
 * отдаёт сюда строки, а здесь — общее для всех: повторы, ограда, счётчики
 * пропусков, ошибки с номером строки.
 */

export type RuleFormat = 'plain' | 'clash' | 'shadowrocket' | 'v2fly' | 'contour';

/** `text` — сама строка (обрезанная), `reason` — что с ней не так, по-русски. */
export type LineNote = { line: number; text: string; reason: string };

/**
 * Ссылка на другой список: `include:` у v2fly (имя файла `data/<name>`),
 * `GEOSITE,` у Clash (то же имя) и `RULE-SET,`/`DOMAIN-SET,` с адресом у
 * Shadowrocket. Качать — забота движка: разбор сети не трогает.
 */
export type Include = { ref: string; format: 'v2fly' | 'shadowrocket'; action: Action; line: number };

/** Запись, которую не пустит ограда частных адресов: решает движок, не разбор. */
export type Fenced = { line: number; entry: Entry; reason: string };

export type ParseResult = {
  format: RuleFormat;
  entries: Entry[];
  /**
   * Частные и служебные подсети и местные имена — отдельно, не в `entries`:
   * исключение из ограды бывает только явным «только через эти туннели»
   * (корпоративная `172.16.42.0/24`), и забытая проверка у потребителя
   * не должна её открыть. Подсеть, которая лишь задевает частную (`0.0.0.0/0`),
   * — тоже здесь: впустить её целиком значило бы впустить и частную часть.
   */
  fenced: Fenced[];
  includes: Include[];
  /** Причина → сколько строк: «DOMAIN-KEYWORD», «IPv6», «повтор», «ошибка» (всего, `errors` — первые сто). */
  skipped: Record<string, number>;
  /** Строка не понята — пропущена. */
  errors: LineNote[];
  /** Понята и взята, но подозрительна: повтор с другим назначением, страна без выхода, чужая политика. */
  warnings: LineNote[];
};

const MAX_NOTES = 100;
const NOTE_TEXT = 200;

/** Назначение строкой — для сравнения повторов; объектов назначений в списке единицы, строк — сотни тысяч. */
const actionKeys = new WeakMap<Action, string>();
function actionKey(action: Action): string {
  let key = actionKeys.get(action);
  if (key === undefined) actionKeys.set(action, (key = JSON.stringify(action)));
  return key;
}

export class Collector {
  readonly result: ParseResult;
  private readonly seen = new Map<string, { line: number; action: string }>();
  private readonly policies = new Set<string>();

  constructor(format: RuleFormat) {
    this.result = { format, entries: [], fenced: [], includes: [], skipped: {}, errors: [], warnings: [] };
  }

  /**
   * Повтор — первое остаётся: у Clash и Shadowrocket правила идут сверху вниз
   * и действует первое совпавшее, у своего формата повтор — ошибка владельца,
   * о которой лучше сказать, чем молча взять последнее.
   */
  add(line: number, match: Match, action: Action): void {
    const key = matchKey(match);
    const act = actionKey(action);
    const prev = this.seen.get(key);
    if (prev) {
      if (prev.action === act) this.skip('повтор');
      else this.warn(line, describeMatch(match), `уже есть на строке ${prev.line} с другим назначением — действует первое`);
      return;
    }
    this.seen.set(key, { line, action: act });
    const entry: Entry = { match, action };
    const reason = fenceReason(match);
    if (reason) this.result.fenced.push({ line, entry, reason });
    else this.result.entries.push(entry);
  }

  /** Разобранный кусок строки: запись, пропуск или ошибка с самой строкой. */
  token(line: number, text: string, token: Token, action: Action): void {
    if ('match' in token) this.add(line, token.match, action);
    else if ('skip' in token) this.skip(token.skip);
    else this.error(line, text, token.error);
  }

  include(ref: string, format: Include['format'], action: Action, line: number): void {
    this.result.includes.push({ ref, format, action, line });
  }

  skip(reason: string, n = 1): void {
    this.result.skipped[reason] = (this.result.skipped[reason] ?? 0) + n;
  }

  error(line: number, text: string, reason: string): void {
    this.skip('ошибка');
    if (this.result.errors.length < MAX_NOTES) this.result.errors.push(note(line, text, reason));
  }

  warn(line: number, text: string, reason: string): void {
    if (this.result.warnings.length < MAX_NOTES) this.result.warnings.push(note(line, text, reason));
  }

  /** Чужая политика в строке (группа, узел) — одно предупреждение на имя, не на каждую строку. */
  foreignPolicy(policy: string, line: number): void {
    if (this.policies.has(policy)) return;
    this.policies.add(policy);
    this.warn(line, policy, 'политика списка, которой у Contour нет, — строки с ней идут, как выбрано при загрузке');
  }
}

function note(line: number, text: string, reason: string): LineNote {
  return { line, text: text.length > NOTE_TEXT ? `${text.slice(0, NOTE_TEXT)}…` : text, reason };
}
