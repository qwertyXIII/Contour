import dgram from 'node:dgram';
import net from 'node:net';
import dnsPacket, { type Packet } from 'dns-packet';
import type { Config } from '../config.ts';
import { errorText, type Logger } from '../log.ts';
import { inCidr } from '../inlets/lan-match.ts';

/**
 * «Умный DNS» для устройств домашней сети.
 *
 * Имя, которое решено вести через VPN (`decide`: списки и самообучение —
 * lists.ts, learn.ts), → `A` = адрес сервера (там SNI-вход Contour), `AAAA` и
 * `HTTPS`/`SVCB` — пусто: иначе устройство ушло бы по IPv6 или взяло адрес из
 * подсказки HTTPS-записи мимо нас. Всё остальное — пакет как есть к обычному
 * DNS (роутер), ответ как есть обратно: остальной трафик устройства идёт мимо
 * сервера.
 *
 * Отдельный процесс от Contour на то и отдельный: пока сервер — DNS телевизора,
 * упавший DNS — это телевизор без интернета вовсе, а не только без YouTube.
 */

type Lan = Config['lan'];

const OUR_TTL = 60;
const UPSTREAM_TIMEOUT_MS = 2_500;
const TYPE_A = 'A';
// HTTPS (65) и SVCB (64) dns-packet по имени не знает и зовёт UNKNOWN_65 / UNKNOWN_64.
// Их ответ несёт подсказки адресов (ipv4hint) — отдай мы их обычному DNS,
// устройство могло бы уйти по подсказке мимо нас.
const EMPTY_TYPES = new Set(['AAAA', 'HTTPS', 'SVCB', 'UNKNOWN_65', 'UNKNOWN_64']);

/** Вопрос, по которому решаем мы: один, и типа A / AAAA / HTTPS / SVCB. Остальное — обычному DNS. */
export function ownQuestion(query: Packet): string | null {
  const q = query.questions?.[0];
  if (!q || (query.questions?.length ?? 0) !== 1) return null;
  return q.type === TYPE_A || EMPTY_TYPES.has(q.type) ? q.name : null;
}

/**
 * Решение по имени: через VPN или напрямую. `shortTtl` — решение ещё не
 * окончательное (проверка идёт): ответ напрямую уходит с коротким сроком жизни,
 * чтобы устройство переспросило, когда вердикт будет.
 */
export type Decision = { tunnel: boolean; shortTtl?: boolean };
export type Decide = (name: string) => Promise<Decision>;

const PENDING_TTL = 30;

/** Срок жизни всех записей ответа — не больше `max`. */
export function capTtl(answer: Buffer, max: number): Buffer {
  try {
    const p = dnsPacket.decode(answer);
    const cap = <T extends { ttl?: number }>(list: T[] | undefined): T[] | undefined => list?.map((r) => ({ ...r, ttl: Math.min(r.ttl ?? max, max) }));
    return dnsPacket.encode({ ...p, answers: cap(p.answers as Array<{ ttl?: number }>) as typeof p.answers });
  } catch {
    return answer;
  }
}

/** Ответ «через нас» на вопрос, уже решённый в пользу VPN. */
export function answerOwn(query: Packet, lan: Lan): Buffer | null {
  const q = query.questions?.[0];
  if (!q || ownQuestion(query) === null) return null;
  const answers = q.type === TYPE_A
    ? [{ type: 'A' as const, name: q.name, class: 'IN' as const, ttl: OUR_TTL, data: lan.address }]
    : EMPTY_TYPES.has(q.type) ? [] : null;
  if (answers === null) return null;
  return dnsPacket.encode({
    id: query.id,
    type: 'response',
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE | dnsPacket.AUTHORITATIVE_ANSWER,
    questions: [q],
    answers,
  });
}

/** Пакет к обычным DNS по очереди, по UDP; первый ответ — обратно. */
function askUpstream(packet: Buffer, upstream: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let index = 0;
    const socket = dgram.createSocket('udp4');
    let timer: NodeJS.Timeout | null = null;
    const done = (err: Error | null, answer?: Buffer): void => {
      if (timer) clearTimeout(timer);
      socket.close();
      if (err) reject(err); else resolve(answer as Buffer);
    };
    const tryNext = (): void => {
      const server = upstream[index];
      if (!server) { done(new Error('обычные DNS не ответили')); return; }
      index += 1;
      socket.send(packet, 53, server);
      timer = setTimeout(tryNext, UPSTREAM_TIMEOUT_MS);
    };
    socket.on('message', (msg) => done(null, msg));
    socket.on('error', (e) => done(e));
    tryNext();
  });
}

/** SERVFAIL на запрос — устройство спросит ещё раз, а не будет ждать вечно. */
function servfail(packet: Buffer): Buffer | null {
  try {
    const q = dnsPacket.decode(packet);
    return dnsPacket.encode({ id: q.id, type: 'response', flags: dnsPacket.RECURSION_AVAILABLE | 2, questions: q.questions ?? [] });
  } catch {
    return null;
  }
}

/** Кому сообщить, что устройство получило наш адрес на имя (подсказка для портов игр). */
export type OnOwn = (client: string, name: string) => void;

export async function resolvePacket(packet: Buffer, lan: Lan, decide: Decide, log: Logger, client = '', onOwn?: OnOwn): Promise<Buffer | null> {
  let query: Packet;
  try {
    query = dnsPacket.decode(packet);
  } catch {
    return null;
  }
  const name = ownQuestion(query);
  const decision: Decision = name !== null ? await decide(name) : { tunnel: false };
  if (decision.tunnel) {
    const own = answerOwn(query, lan);
    if (own) {
      if (name && query.questions?.[0]?.type === TYPE_A) onOwn?.(client, name.toLowerCase().replace(/\.$/, ''));
      return own;
    }
  }
  try {
    const answer = await askUpstream(packet, lan.upstream);
    return decision.shortTtl ? capTtl(answer, PENDING_TTL) : answer;
  } catch (error) {
    log.warn(`DNS: ${query.questions?.[0]?.name ?? '?'} — ${errorText(error)}`);
    return servfail(packet);
  }
}

export function startDns(lan: Lan, decide: Decide, log: Logger, onOwn?: OnOwn): { udp: dgram.Socket; tcp: net.Server } {
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => {
    if (!inCidr(rinfo.address, lan.allow)) return;
    void resolvePacket(msg, lan, decide, log, rinfo.address, onOwn).then((answer) => {
      if (answer) udp.send(answer, rinfo.port, rinfo.address);
    });
  });
  udp.on('error', (e) => { log.error(`DNS UDP: ${e.message}`); process.exit(1); });
  udp.bind(53, lan.address, () => log.info(`DNS слушает ${lan.address}:53/udp`));

  // TCP — на случай длинного ответа (флаг TC) и для клиентов, которые спрашивают по TCP.
  const tcp = net.createServer((socket) => {
    if (!inCidr(socket.remoteAddress ?? '', lan.allow)) { socket.destroy(); return; }
    let buf = Buffer.alloc(0);
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const len = buf.readUInt16BE(0);
        const msg = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        void resolvePacket(Buffer.from(msg), lan, decide, log, (socket.remoteAddress ?? '').replace(/^::ffff:/, ''), onOwn).then((answer) => {
          if (!answer || socket.destroyed) return;
          const head = Buffer.alloc(2);
          head.writeUInt16BE(answer.length, 0);
          socket.write(Buffer.concat([head, answer]));
        });
      }
    });
    socket.on('error', () => socket.destroy());
  });
  tcp.on('error', (e) => { log.error(`DNS TCP: ${e.message}`); process.exit(1); });
  tcp.listen(53, lan.address, () => log.info(`DNS слушает ${lan.address}:53/tcp`));
  return { udp, tcp };
}
