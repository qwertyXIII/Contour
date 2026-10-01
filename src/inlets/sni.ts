/**
 * Имя сайта из первого сообщения TLS (ClientHello, расширение server_name).
 *
 * Разбираем руками: нужен один кусок, а библиотека ради него тянула бы весь
 * TLS. ClientHello с постквантовым ключом бывает ~1,8 КБ — это два TCP-сегмента,
 * поэтому сначала ждём всю запись целиком (`tlsRecordLength`), потом разбираем.
 */

export type SniResult =
  | { kind: 'need-more' }
  | { kind: 'name'; name: string }
  | { kind: 'none'; reason: string };

/** Сколько байт нужно для всей первой записи TLS, или null — это не TLS. */
export function tlsRecordLength(buf: Buffer): number | null | 'short' {
  if (buf.length < 5) return 'short';
  if (buf[0] !== 0x16 || buf[1] !== 0x03) return null;
  return 5 + buf.readUInt16BE(3);
}

export function parseSni(buf: Buffer): SniResult {
  const total = tlsRecordLength(buf);
  if (total === 'short') return { kind: 'need-more' };
  if (total === null) return { kind: 'none', reason: 'не TLS' };
  if (buf.length < total) return { kind: 'need-more' };

  let p = 5;
  const end = total;
  const need = (n: number): boolean => p + n <= end;
  if (!need(4) || buf[p] !== 0x01) return { kind: 'none', reason: 'не ClientHello' };
  p += 4; // тип + длина рукопожатия
  if (!need(2 + 32)) return { kind: 'none', reason: 'обрезано' };
  p += 2 + 32; // версия + random
  if (!need(1)) return { kind: 'none', reason: 'обрезано' };
  p += 1 + (buf[p] as number); // session id
  if (!need(2)) return { kind: 'none', reason: 'обрезано' };
  p += 2 + buf.readUInt16BE(p); // cipher suites
  if (!need(1)) return { kind: 'none', reason: 'обрезано' };
  p += 1 + (buf[p] as number); // compression
  if (!need(2)) return { kind: 'none', reason: 'нет расширений' };
  const extEnd = p + 2 + buf.readUInt16BE(p);
  p += 2;
  if (extEnd > end) return { kind: 'none', reason: 'обрезано' };

  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    p += 4;
    if (p + len > extEnd) return { kind: 'none', reason: 'обрезано' };
    if (type === 0x0000) {
      // server_name_list: длина(2), затем [тип(1)=0, длина(2), имя]
      let q = p + 2;
      const listEnd = p + len;
      while (q + 3 <= listEnd) {
        const nameType = buf[q] as number;
        const nameLen = buf.readUInt16BE(q + 1);
        q += 3;
        if (q + nameLen > listEnd) break;
        if (nameType === 0) {
          const name = buf.subarray(q, q + nameLen).toString('ascii').toLowerCase();
          return /^[a-z0-9.-]+$/.test(name) ? { kind: 'name', name } : { kind: 'none', reason: 'странное имя' };
        }
        q += nameLen;
      }
      return { kind: 'none', reason: 'пустой server_name' };
    }
    p += len;
  }
  return { kind: 'none', reason: 'нет server_name' };
}

/** Host из начала http-запроса, или 'need-more' / null. */
export function parseHttpHost(buf: Buffer): string | null | 'need-more' {
  const text = buf.subarray(0, 8192).toString('latin1');
  const headEnd = text.indexOf('\r\n\r\n');
  if (headEnd < 0) return buf.length >= 8192 ? null : 'need-more';
  const m = /\r\nhost:[ \t]*([^\r\n:]+)(?::\d+)?[ \t]*\r\n/i.exec(text.slice(0, headEnd + 2));
  return m ? (m[1] as string).toLowerCase() : null;
}
