import type { Collector } from './collect.ts';
import { plainLine } from './plain.ts';
import type { Action, Target } from './types.ts';

/**
 * Свой формат Contour — простой текст с разделами. Справка для владельца
 * (её же — в README и в панель):
 *
 *   Строка — имя сайта или подсеть: `example.com` (с поддоменами),
 *   `full:www.example.com` (только это имя), `.ru` (вся зона), `1.2.3.0/24`,
 *   `1.2.3.4`. `#` и `//` — комментарий.
 *
 *   Раздел в квадратных скобках говорит, куда вести строки под ним — до
 *   следующего раздела:
 *     [напрямую]                  мимо туннелей
 *     [через VPN]                 через выходы Contour, какой — решит Contour
 *     [через: DE]                 выходом в этой стране (код или название:
 *                                 [через: Германия]); нет такого выхода — отказ,
 *                                 а не другая страна
 *     [не через: RU, BY]          через выходы, кроме этих стран
 *     [только: corp_ext, ext]  только этими выходами и никогда напрямую
 *                                 (можно [только через: …] — как пишет панель)
 *     [запретить]                 отказать сразу
 *   «, самый быстрый» в конце раздела — из подходящих выходов брать самый
 *   быстрый: [через: DE, самый быстрый], [через VPN, самый быстрый].
 *   Строки до первого раздела идут так, как выбрано при загрузке.
 *
 *   Пример:
 *     # рабочие серверы — только рабочим туннелем
 *     [только: corp_ext]
 *     172.16.42.0/24
 *
 *     [через: DE, самый быстрый]
 *     openai.com
 *     chatgpt.com
 *
 *     [напрямую]
 *     gosuslugi.ru
 *
 *     [запретить]
 *     full:ads.example.com
 *
 * Можно и по-английски: [direct], [tunnel], [via: DE], [avoid: RU],
 * [only: ext], [reject], «fastest».
 *
 * Одна страна на раздел: прилипание держит страну на весь сервис, «DE или NL»
 * ему не по карману, а «любая, кроме» — это `[не через: …]`. Непонятный раздел
 * — ошибка с номером строки, и строки под ним не берутся: молча повести их
 * «как при загрузке» — значит отправить туда, куда владелец не просил.
 */

type Kind = Target['kind'] | 'country';

const WORDS: Record<string, Kind> = {
  'напрямую': 'direct', 'прямо': 'direct', 'direct': 'direct',
  'через vpn': 'tunnel', 'через впн': 'tunnel', 'через туннель': 'tunnel', 'через туннели': 'tunnel', 'tunnel': 'tunnel', 'vpn': 'tunnel',
  'через': 'country', 'via': 'country',
  'не через': 'avoid', 'кроме': 'avoid', 'avoid': 'avoid', 'not via': 'avoid',
  // «только через» — так назначение подписывает сама панель (живьём 2026-10-06: переписал оттуда — раздел ушёл в ошибку).
  'только': 'only', 'только через': 'only', 'only': 'only', 'only via': 'only',
  'запретить': 'reject', 'запрет': 'reject', 'reject': 'reject', 'block': 'reject',
};

const FASTEST = /^(?:самый\s+быстрый(?:\s+выход)?|fastest)$/iu;
/** Имя выхода — как в `config.ts`. */
const OUTLET = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Раздел своего формата — и для распознавания формата (`parse.ts`). */
export const CONTOUR_SECTION = new RegExp(`^\\[\\s*(?:${Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|')})(?=[\\s:,\\]])`, 'iu');

const norm = (s: string): string => s.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

/** `UK` → `GB`, `SU` → `RU`: так страну называет ip-api, и так её назовёт выход. */
const canonical = (code: string): string => (Intl.getCanonicalLocales(`und-${code}`)[0] ?? '').split('-')[1] ?? '';

let names: Map<string, string> | null = null;

/** Название страны (по-русски или по-английски, полное или короткое — «США») → код; карта — лениво, один раз. */
function countryByName(name: string): string | null {
  if (!names) {
    const map = new Map<string, string>();
    const views = ['ru', 'en'].flatMap((lang) => (['long', 'short'] as const).map((style) => new Intl.DisplayNames(lang, { type: 'region', fallback: 'none', style })));
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        for (const view of views) {
          const n = view.of(code);
          if (n && n !== code && !map.has(norm(n))) map.set(norm(n), canonical(code));
        }
      }
    }
    names = map;
  }
  return names.get(norm(name)) ?? null;
}

/** Код или название → код страны; не страна — null. */
export function countryCode(text: string): string | null {
  const t = text.trim();
  if (!/^[A-Za-z]{2}$/.test(t)) return countryByName(t);
  const code = canonical(t.toUpperCase());
  return new Intl.DisplayNames('en', { type: 'region', fallback: 'none' }).of(code) ? code : null;
}

/** `[через: DE, самый быстрый]` → назначение; непонятное — причина. */
export function parseSection(text: string): { action: Action } | { error: string } {
  const m = /^\[(.*)\]$/.exec(text.trim());
  if (!m) return { error: 'раздел без закрывающей скобки' };
  let fastest = false;
  const parts = (m[1] as string).split(',').map((s) => s.trim()).filter((p) => {
    if (!FASTEST.test(p)) return true;
    fastest = true;
    return false;
  });
  const body = /^([^:]*?)\s*(?::(.*))?$/su.exec(parts.join(', ')) as RegExpExecArray;
  const kind = WORDS[norm(body[1] as string)];
  const args = (body[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!kind) return { error: 'неизвестный раздел: [напрямую], [через VPN], [через: DE], [не через: RU], [только: выход], [запретить]' };
  if ((kind === 'direct' || kind === 'tunnel' || kind === 'reject') && args.length > 0) return { error: `у «${(body[1] as string).trim()}» не бывает списка после двоеточия` };
  if (fastest && (kind === 'direct' || kind === 'reject')) return { error: '«самый быстрый» — только у разделов через выходы' };

  const action = (target: Target): { action: Action } => ({ action: fastest ? { target, fastest } : { target } });
  switch (kind) {
    case 'direct':
    case 'tunnel':
    case 'reject':
      return action({ kind });
    case 'country': {
      if (args.length === 0) return { error: 'через какую страну? [через: DE]' };
      if (args.length > 1) return { error: 'одна страна на раздел; «любая, кроме» — [не через: …], свои выходы — [только: …]' };
      if (/^(vpn|впн|туннель)$/iu.test(args[0] as string)) return action({ kind: 'tunnel' });
      const country = countryCode(args[0] as string);
      return country ? action({ kind: 'country', country }) : { error: `«${args[0]}» — не страна: код (DE) или название (Германия)` };
    }
    case 'avoid': {
      if (args.length === 0) return { error: 'не через какие страны? [не через: RU, BY]' };
      const countries = args.map(countryCode);
      const bad = args.find((_, i) => !countries[i]);
      return bad ? { error: `«${bad}» — не страна` } : action({ kind: 'avoid', countries: [...new Set(countries as string[])] });
    }
    case 'only': {
      const outlets = [...new Set(args.map((a) => a.toLowerCase()))];
      if (outlets.length === 0) return { error: 'через какие выходы? [только: corp_ext]' };
      const bad = outlets.find((o) => !OUTLET.test(o));
      return bad ? { error: `«${bad}» — не имя выхода: латиница, цифры, «-» и «_»` } : action({ kind: 'only', outlets });
    }
  }
}

/** Назначение → заголовок раздела (обратное `parseSection`): так панель дописывает строки в свой список. */
export function sectionText(action: Action): string {
  const t = action.target;
  const head = t.kind === 'direct' ? 'напрямую'
    : t.kind === 'tunnel' ? 'через VPN'
      : t.kind === 'reject' ? 'запретить'
        : t.kind === 'country' ? `через: ${t.country}`
          : t.kind === 'avoid' ? `не через: ${t.countries.join(', ')}`
            : `только через: ${t.outlets.join(', ')}`;
  return `[${head}${action.fastest ? ', самый быстрый' : ''}]`;
}

/** Страна без выхода и неизвестный выход — не ошибка (выход может появиться), но сказать надо. */
function checkKnown(action: Action, no: number, text: string, out: Collector, known: Known): void {
  const t = action.target;
  if (t.kind === 'country' && known.countries && !known.countries.includes(t.country)) {
    out.warn(no, text, `выхода в стране ${t.country} сейчас нет — эти строки будут получать отказ`);
  }
  if (t.kind === 'only' && known.outlets) {
    for (const o of t.outlets) if (!known.outlets.includes(o)) out.warn(no, text, `выхода «${o}» нет`);
  }
}

export type Known = { countries?: readonly string[]; outlets?: readonly string[] };

export function parseContour(lines: Iterable<{ no: number; text: string }>, out: Collector, load: Action, known: Known): void {
  let action: Action | null = load;
  for (const { no, text } of lines) {
    const t = text.trim();
    if (!t.startsWith('[')) {
      if (action) plainLine(text, no, out, action);
      else if (t && !/^(#|\/\/)/.test(t)) out.skip('под ошибочным разделом');
      continue;
    }
    const s = parseSection(t.replace(/\s(#|\/\/).*$/, ''));
    if ('error' in s) {
      out.error(no, t, s.error);
      action = null;
    } else {
      action = s.action;
      checkKnown(action, no, t, out, known);
    }
  }
}
