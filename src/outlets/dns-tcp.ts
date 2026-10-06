import { randomInt } from 'node:crypto';
import { isIP, type Socket } from 'node:net';
import dnsPacket, { type Packet } from 'dns-packet';
import { DOH_TIMEOUT_MS, ResolveError, type DohResult } from './doh.ts';

/**
 * Запрос A по TCP поверх уже открытого сокета — к DNS выхода
 * (`outlet-dns.ts`). TCP, а не UDP: SOCKS выхода — это CONNECT, а внутри
 * туннеля TCP и так надёжнее (`resolver.ts`). CNAME сервер разворачивает сам —
 * из ответа берём адреса A.
 */

const MIN_TTL_S = 30;
const MAX_ANSWER = 65_535;

export function tcpLookup(socket: Socket, name: string, timeoutMs = DOH_TIMEOUT_MS): Promise<DohResult> {
  return new Promise((resolve, reject) => {
    const id = randomInt(0, 0x10000);
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('нет ответа'))), timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const len = buf.readUInt16BE(0);
      if (len > MAX_ANSWER) { finish(() => reject(new Error('ответ слишком большой'))); return; }
      if (buf.length < 2 + len) return;
      let p: Packet;
      try {
        p = dnsPacket.decode(buf.subarray(2, 2 + len));
      } catch {
        finish(() => reject(new Error('ответ не DNS')));
        return;
      }
      finish(() => answer(p, id, name, resolve, reject));
    });
    socket.on('error', (error) => finish(() => reject(error)));
    socket.on('close', () => finish(() => reject(new Error('закрыл соединение, не ответив'))));
    socket.write(dnsPacket.streamEncode({ type: 'query', id, flags: dnsPacket.RECURSION_DESIRED, questions: [{ type: 'A', name }] }));
  });
}

function answer(p: Packet, id: number, name: string, resolve: (r: DohResult) => void, reject: (e: Error) => void): void {
  if (p.id !== id) { reject(new Error('чужой ответ')); return; }
  const rcode = (p as Packet & { rcode?: string }).rcode ?? 'NOERROR';
  if (rcode === 'NXDOMAIN') { reject(new ResolveError(`имени «${name}» нет`)); return; }
  if (rcode !== 'NOERROR') { reject(new Error(`DNS ответил ${rcode}`)); return; }
  const records = (p.answers ?? []).flatMap((a) => (a.type === 'A' && typeof a.data === 'string' && isIP(a.data) === 4 ? [{ ip: a.data, ttl: a.ttl ?? MIN_TTL_S }] : []));
  if (records.length === 0) { reject(new ResolveError(`у «${name}» нет IPv4-адреса`)); return; }
  resolve({ ips: [...new Set(records.map((r) => r.ip))], ttl: Math.min(...records.map((r) => r.ttl)) });
}
