import tls from 'node:tls';
import type { Dial } from '../outlets/connect.ts';
import type { Outlet } from '../outlets/outlet.ts';

/**
 * Замер скорости выхода: скачать кусок с speed.cloudflare.com через этот выход.
 *
 * Не дольше `MAX_MS` и не больше `BYTES`: сколько успело — то и посчитано.
 * Через выход идёт ровно так же, как трафик потребителей (DoH-имя, ограда,
 * SOCKS выхода), — значит, замер честный, а не «до VPN-сервера».
 * Проверено 2026-10-01: через ядерный AWG — 13 МБ/с за 25 МБ.
 *
 * Им же — редкая проба режима «самый быстрый» (`select/speed-probe.ts`), с
 * маленьким `bytes`: ей скорость нужна по `bodyMs` (только тело) — на
 * нескольких мегабайтах рукопожатие и запрос заметно занижали бы итог.
 */

const HOST = 'speed.cloudflare.com';
const BYTES = 25_000_000;
const MAX_MS = 10_000;

/** `firstByteMs` — первый байт ответа HTTP (рукопожатие TLS и запрос внутри), `bodyMs` — сколько шло тело. */
export type SpeedResult = { outlet: string; bytes: number; ms: number; mbps: number; firstByteMs: number; bodyMs: number; at: number };

export function speedTest(outlet: Outlet, dial: Dial, opts: { bytes?: number; maxMs?: number } = {}): Promise<SpeedResult> {
  const want = opts.bytes ?? BYTES;
  return dial(outlet, HOST, 443).then((raw) => new Promise<SpeedResult>((resolve, reject) => {
    const started = Date.now();
    let firstByteMs = -1;
    let bodyAt = -1;
    let body = 0;
    let headerDone = false;
    let head = Buffer.alloc(0);
    const socket = tls.connect({ socket: raw, servername: HOST, ALPNProtocols: ['http/1.1'] });
    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      const ms = Date.now() - started;
      if (body === 0) { reject(new Error('ничего не скачалось')); return; }
      const bodyMs = Math.max(1, Date.now() - bodyAt);
      resolve({ outlet: outlet.name, bytes: body, ms, mbps: Math.round((body * 8) / (ms / 1000) / 1e5) / 10, firstByteMs, bodyMs, at: Date.now() });
    };
    const timer = setTimeout(finish, opts.maxMs ?? MAX_MS);
    socket.once('secureConnect', () => {
      socket.write(`GET /__down?bytes=${want} HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: contour-speedtest\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (firstByteMs < 0) firstByteMs = Date.now() - started;
      if (headerDone) { body += chunk.length; return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      headerDone = true;
      bodyAt = Date.now();
      if (!/^HTTP\/1\.[01] 200/.test(head.subarray(0, 20).toString('latin1'))) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`сервер замера ответил ${head.subarray(0, 40).toString('latin1').split('\r\n')[0]}`));
        return;
      }
      body += head.length - end - 4;
    });
    socket.on('end', finish);
    socket.on('error', (e) => { clearTimeout(timer); socket.destroy(); if (body > 0) finish(); else reject(e); });
  }));
}
