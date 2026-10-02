import type { Collector } from './collect.ts';
import { addressToken, entryToken, toName } from './names.ts';
import type { Action } from './types.ts';
import { V2FLY_NAME } from './v2fly.ts';

/**
 * Списки Clash (mihomo) и Shadowrocket — строки правил `ТИП,значение[,политика][,опции]`
 * и наборы без типов. Обёртки разные (YAML `payload:`/`rules:` у Clash, разделы
 * INI у Shadowrocket), строки — одни (оба взяли их у Surge), и голое имя у
 * обоих — только само: `+.x` у Clash и `.x` у `DOMAIN-SET` — с поддоменами.
 *
 * Политика в строке задаёт назначение этой строки, если она понятна:
 * `DIRECT` — напрямую, `REJECT…` — отказ. `PROXY`, группы и узлы — «через
 * прокси», а какой — выбрал владелец при загрузке; чужие имена групп
 * называются одним предупреждением.
 */

const DIRECT: Action = { target: { kind: 'direct' } };
const REJECT: Action = { target: { kind: 'reject' } };

/** Опции после значения — не политика: `IP-CIDR,1.2.3.0/24,PROXY,no-resolve` и `IP-CIDR,1.2.3.0/24,no-resolve`. */
const OPTIONS = new Set(['no-resolve', 'src', 'extended-matching', 'pre-matching', 'force-remote-dns']);
const LOGIC = new Set(['AND', 'OR', 'NOT', 'SUB-RULE']);
/** Похоже на правило: тип большими буквами и запятая (в имени сайта запятой не бывает). */
export const RULE_LINE = /^[A-Za-z][A-Za-z0-9-]*,/;

function policy(name: string | undefined, load: Action, line: number, out: Collector): Action {
  if (!name) return load;
  const p = name.toUpperCase();
  if (p === 'DIRECT') return DIRECT;
  if (p.startsWith('REJECT')) return REJECT;
  if (p !== 'PROXY') out.foreignPolicy(name, line);
  return load;
}

/** Одна строка правила; `urlSets` — у Shadowrocket `RULE-SET`/`DOMAIN-SET` с адресом становятся ссылками. */
export function ruleLine(text: string, no: number, out: Collector, load: Action, urlSets: boolean): void {
  const parts = text.split(',').map((s) => s.trim());
  const type = (parts[0] as string).toUpperCase();
  if (LOGIC.has(type)) return out.skip(type);
  const value = parts[1] ?? '';
  // Политику читаем только у того, что берём: предупреждение о чужой группе у пропущенного `GEOIP` ни к чему.
  const action = (): Action => policy(parts.slice(2).find((p) => p && !OPTIONS.has(p.toLowerCase())), load, no, out);
  switch (type) {
    case 'DOMAIN':
    case 'DOMAIN-SUFFIX':
    case 'HOST':
    case 'HOST-SUFFIX': {
      const name = toName(value.replace(/^\.|^\+\./, ''), type.endsWith('SUFFIX'));
      if (!name) return out.error(no, text, 'не имя сайта');
      return out.add(no, { kind: 'domain', name, exact: !type.endsWith('SUFFIX') }, action());
    }
    case 'IP-CIDR':
    case 'IP-CIDR6': {
      const token = addressToken(value) ?? { error: 'не подсеть' };
      return out.token(no, text, token, action());
    }
    case 'GEOSITE': {
      // Имена geosite у mihomo — те же файлы v2fly; `google@cn` — атрибут, его отбрасываем.
      const ref = value.toLowerCase().replace(/@.*$/, '');
      return V2FLY_NAME.test(ref) ? out.include(ref, 'v2fly', action(), no) : out.error(no, text, 'не имя geosite');
    }
    case 'RULE-SET':
    case 'DOMAIN-SET':
      // У Clash `RULE-SET,имя,…` — провайдер, описанный в другом месте конфига: не идём за ним.
      if (urlSets && /^https?:\/\//i.test(value)) return out.include(value, 'shadowrocket', action(), no);
      return out.skip(type);
    default:
      return out.skip(type);
  }
}

/** Значение набора: правило или имя/подсеть без типа (`DOMAIN-SET`, `payload` с behavior domain/ipcidr). */
function setItem(text: string, no: number, out: Collector, load: Action, urlSets: boolean): void {
  if (RULE_LINE.test(text)) return ruleLine(text, no, out, load, urlSets);
  out.token(no, text, entryToken(text, true), load);
}

const unquote = (s: string): string => s.replace(/^'(.*)'$|^"(.*)"$/, '$1$2');
/** YAML-ключ верхнего уровня: `payload:`, `rules:`; `fe80::/10` — не ключ. */
const TOP_KEY = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/;

/**
 * Clash: файл rule-provider (`payload:` списком), конфиг целиком (берём
 * `rules:`, прочие разделы — мимо) или текстовый набор без YAML (`+.x`,
 * `DOMAIN-SUFFIX,x` построчно). YAML разбираем построчно, не библиотекой:
 * нужны номера строк для ошибок, а битый кусок чужого конфига не должен
 * ронять весь разбор.
 */
export function parseClash(lines: Iterable<{ no: number; text: string }>, out: Collector, load: Action): void {
  let section: 'rules' | 'other' | null = null;
  for (const { no, text } of lines) {
    const raw = text.replace(/(^|\s)#.*$/, '').trimEnd();
    if (!raw.trim()) continue;
    const top = /^\S/.test(raw) ? TOP_KEY.exec(raw) : null;
    if (top) {
      section = top[1] === 'payload' || top[1] === 'rules' ? 'rules' : 'other';
      const flow = /^\[(.*)\]$/.exec(top[2]?.trim() ?? '');
      if (section === 'rules' && flow) {
        // `payload: ['+.a.com', 'DOMAIN,b.com']` — запятые внутри кавычек не делят.
        for (const v of (flow[1] as string).match(/'[^']*'|"[^"]*"|[^,\s][^,]*/g) ?? []) setItem(unquote(v.trim()), no, out, load, false);
      }
      continue;
    }
    if (section === 'other') {
      out.skip('не правила');
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(raw);
    setItem(unquote((item ? item[1] as string : raw).trim()), no, out, load, false);
  }
}

/**
 * Shadowrocket: конфиг (берём только `[Rule]`), `RULE-SET` (строки правил без
 * политики) и `DOMAIN-SET` (имена: `.x` — с поддоменами, `x` — только само).
 * Файл без разделов — набор целиком.
 */
export function parseShadowrocket(lines: Iterable<{ no: number; text: string }>, out: Collector, load: Action): void {
  let inRules = true;
  for (const { no, text } of lines) {
    const t = text.replace(/(^|\s)(#|\/\/|;).*$/, '').trim();
    if (!t) continue;
    const sec = /^\[([^\]]+)\]$/.exec(t);
    if (sec) {
      inRules = (sec[1] as string).trim().toLowerCase() === 'rule';
      continue;
    }
    if (inRules) setItem(t, no, out, load, true);
    else out.skip('не правила');
  }
}
