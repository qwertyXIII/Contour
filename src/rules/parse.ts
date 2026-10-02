import { Collector, type ParseResult, type RuleFormat } from './collect.ts';
import { CONTOUR_SECTION, parseContour } from './contour-format.ts';
import { parsePlain } from './plain.ts';
import { parseClash, parseShadowrocket, RULE_LINE } from './rule-lines.ts';
import type { Action } from './types.ts';
import { parseV2flyRules } from './v2fly.ts';

/**
 * Разбор готового списка в правила «что + куда» — для списка по ссылке, файла
 * из панели и ручного списка. Готовые списки берутся как есть: простой текст
 * (`plain.ts`), Clash и Shadowrocket (`rule-lines.ts`), v2fly (`v2fly.ts`), и
 * свой формат с разделами (`contour-format.ts`, там и справка). Назначение —
 * выбранное при загрузке; его меняют только политика в строке
 * (`,DIRECT`/`,REJECT`) и разделы своего формата.
 *
 * Чего разбор не делает: не качает (`includes` — движку), не решает, что
 * сильнее (ручное, загруженное, выученное, точное, широкое — движок), и не
 * открывает ограду (частное — в `fenced`).
 */

export type { Fenced, Include, LineNote, ParseResult, RuleFormat } from './collect.ts';

export type ParseOptions = {
  /** `auto` (по умолчанию) — по содержимому, что определилось — в `result.format`. */
  format?: 'auto' | RuleFormat;
  /** Куда вести строки без своей политики; по умолчанию — через туннели, как заблокированное сейчас. */
  action?: Action;
  /** Страны выходов и имена выходов: разделы своего формата сверяются с ними (предупреждения, не ошибки). */
  countries?: readonly string[];
  outlets?: readonly string[];
  /** Больше — отказ целиком: половина списка опаснее, чем никакого. */
  maxBytes?: number;
  maxLines?: number;
  /** Длиннее — строка пропускается (`skipped['длинная строка']`): имя — до 253 знаков, правило с политикой — до сотни. */
  maxLineLength?: number;
};

export const RULE_LIST_LIMITS = { maxBytes: 5 * 1024 * 1024, maxLines: 300_000, maxLineLength: 1_000 };

const TUNNEL: Action = { target: { kind: 'tunnel' } };

/** Разделы конфига Shadowrocket (и Surge). */
const ROCKET_SECTION = /^\[(?:general|rule|proxy|proxy group|host|url rewrite|header rewrite|body rewrite|map local|mitm|script|replica)\]$/i;
const YAML_TOP = /^(?:payload|rules|proxies|proxy-groups|rule-providers|proxy-providers|dns|mode):(?:\s|$)/;
/** `full:` — не признак: его понимает и простой текст, и читают они его одинаково. Признак — остальные приставки и атрибуты (`@cn`). */
const V2FLY = /^(?:domain|keyword|regexp|include):|\s@!?[a-z-]+(?:\s|$)/i;
const FULL_COMMENT = /^(?:#|!|\/\/|;)/;

/**
 * Формат по содержимому. Свой — по разделу с нашим словом; Clash — по
 * ключам YAML, пунктам `- ` и `+.`; Shadowrocket — по разделам конфига, по
 * `RULE-SET`/`DOMAIN-SET` с адресом, по `FINAL,` и по набору, где не меньше
 * половины имён с точкой впереди (`DOMAIN-SET`: голое имя там — только само;
 * у Loyalsoldier таких 97 %); строки правил без обёртки — Clash (тот же
 * набор, что `RULE-SET`); v2fly — по `domain:`/`include:`/`regexp:` и
 * атрибутам `@cn`. Остальное — простой текст: при сомнении голое имя читаем
 * шире («с поддоменами»), лишний поддомен в туннеле безвреднее недостающего.
 */
export function detectFormat(lines: readonly string[]): RuleFormat {
  let clash = false;
  let rocket = false;
  let rules = false;
  let v2fly = false;
  let dotted = 0;
  let bare = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || FULL_COMMENT.test(t)) continue;
    if (CONTOUR_SECTION.test(t)) return 'contour';
    if (ROCKET_SECTION.test(t) || /^(?:DOMAIN-SET|RULE-SET),https?:/i.test(t) || /^FINAL,/i.test(t)) rocket = true;
    else if (YAML_TOP.test(raw) || /^-\s+\S/.test(t) || t.startsWith('+.')) clash = true;
    else if (RULE_LINE.test(t)) rules = true;
    else if (V2FLY.test(t)) v2fly = true;
    else if (t.startsWith('.')) dotted++;
    else bare++;
  }
  if (clash) return 'clash';
  if (rocket || (dotted > 0 && dotted >= bare)) return 'shadowrocket';
  if (rules) return 'clash';
  return v2fly ? 'v2fly' : 'plain';
}

/** Строки с номерами; слишком длинные — мимо, со счётчиком. */
function* numbered(lines: readonly string[], maxLength: number, out: Collector): Generator<{ no: number; text: string }> {
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] as string;
    if (text.length > maxLength) out.skip('длинная строка');
    else yield { no: i + 1, text };
  }
}

export function parseRuleList(text: string, opts: ParseOptions = {}): ParseResult {
  const limits = { ...RULE_LIST_LIMITS, ...definedOnly(opts) };
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > limits.maxBytes) throw new Error(`список больше ${mb(limits.maxBytes)} (${mb(bytes)}) — не беру`);
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines.length > limits.maxLines) throw new Error(`в списке больше ${limits.maxLines} строк (${lines.length}) — не беру`);

  const format = !opts.format || opts.format === 'auto' ? detectFormat(lines) : opts.format;
  const out = new Collector(format);
  const load = opts.action ?? TUNNEL;
  const rows = numbered(lines, limits.maxLineLength, out);
  switch (format) {
    case 'plain': parsePlain(rows, out, load); break;
    case 'clash': parseClash(rows, out, load); break;
    case 'shadowrocket': parseShadowrocket(rows, out, load); break;
    case 'v2fly': parseV2flyRules(rows, out, load); break;
    case 'contour': parseContour(rows, out, load, { countries: opts.countries, outlets: opts.outlets }); break;
  }
  return out.result;
}

function definedOnly(opts: ParseOptions): Partial<typeof RULE_LIST_LIMITS> {
  const out: Partial<typeof RULE_LIST_LIMITS> = {};
  for (const k of ['maxBytes', 'maxLines', 'maxLineLength'] as const) if (opts[k] !== undefined) out[k] = opts[k];
  return out;
}

const mb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(n / 1024)} КБ`);
