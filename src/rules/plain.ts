import type { Collector } from './collect.ts';
import { entryToken, nameToken } from './names.ts';
import type { Action } from './types.ts';

/**
 * Простой текст: строка — имя или подсеть. Голое `example.com` — **с
 * поддоменами**: так читают такие списки все, кто их ставит (itdoginfo для
 * Keenetic и dnsmasq, наш `lists.ts`), а у «только само» в маршруте цена —
 * полсайта мимо туннеля (`instagram.com` в списке, `i.instagram.com` — нет).
 * Только само — `full:www.example.com`.
 *
 * Понимаем и обёртки, в которых такие списки ходят: `||example.com^` из
 * adblock, `0.0.0.0 example.com` из hosts, `nftset=/a.com/b.com/…` из dnsmasq,
 * `https://example.com/путь` вставленный ссылкой.
 */

/** Комментарий во всю строку: `#`, `!` (adblock), `//`, `;`. Внутри строки — с `#` (как `lists.ts`). */
const COMMENT = /^(#|!|\/\/|;)/;
const DNSMASQ = /^(?:server|address|ipset|nftset|local)=\/(.+)\/[^/]*$/;
const HOSTS = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+(\S+)$/;

/** Одна строка простого текста — она же строка внутри раздела своего формата. */
export function plainLine(text: string, no: number, out: Collector, action: Action): void {
  const raw = text.trim();
  if (!raw || COMMENT.test(raw)) return;
  // Косметика adblock (`site.com##.banner`) — не про сайт целиком, хоть имя и в начале.
  if (/#[@?$]?#/.test(raw)) return out.skip('adblock: косметика');
  const t = raw.replace(/#.*$/, '').trim();
  if (!t) return;
  if (t.startsWith('@@')) return out.skip('adblock: исключение');
  if (/^\[adblock/i.test(t)) return;

  const adblock = /^\|\|([^/^$|]+)/.exec(t);
  if (adblock) return out.token(no, raw, nameToken(`.${adblock[1]}`, false), action);

  const dnsmasq = DNSMASQ.exec(t);
  if (dnsmasq) {
    for (const name of (dnsmasq[1] as string).split('/').filter(Boolean)) out.token(no, raw, nameToken(name, false), action);
    return;
  }

  const hosts = HOSTS.exec(t);
  if (hosts) {
    const name = hosts[1] as string;
    return name.includes('.') ? out.token(no, raw, nameToken(name, false), action) : out.skip('hosts: местное имя');
  }

  if (/^(keyword|regexp|include):/i.test(t)) return out.skip(`${(t.split(':')[0] as string).toLowerCase()}:`);
  if (/\s/.test(t)) return out.error(no, raw, 'в строке больше одного слова');
  out.token(no, raw, entryToken(t, false), action);
}

export function parsePlain(lines: Iterable<{ no: number; text: string }>, out: Collector, load: Action): void {
  for (const { no, text } of lines) plainLine(text, no, out, load);
}
