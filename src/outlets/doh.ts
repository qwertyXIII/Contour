import https from 'node:https';
import { isIP, type Socket } from 'node:net';
import tls from 'node:tls';
import { errorText } from '../log.ts';

/**
 * DNS-over-HTTPS поверх уже открытого сокета — через выход (Contour,
 * `resolver.ts`) или через HTTP-прокси Contour (DNS для устройств-шлюзов,
 * `dns/tunnel-resolve.ts`). Резолвер публичный и снаружи туннеля, поэтому CDN
 * отдаёт узел рядом с выходом, а не рядом с домом.
 */

export type DohServer = { ip: string; servername: string; path: (name: string) => string };

export const DOH_SERVERS: DohServer[] = [
  { ip: '1.1.1.1', servername: 'cloudflare-dns.com', path: (n) => `/dns-query?name=${encodeURIComponent(n)}&type=A` },
  { ip: '8.8.8.8', servername: 'dns.google', path: (n) => `/resolve?name=${encodeURIComponent(n)}&type=A` },
];

export const DOH_TIMEOUT_MS = 4_000;
const MIN_TTL_S = 30;

type Answer = { Status?: number; Answer?: Array<{ type?: number; data?: string; TTL?: number }> };

/** «Имени нет» или «нет IPv4» — ответ, а не сбой: второй сервер скажет то же самое. */
export class ResolveError extends Error {}

export type DohResult = { ips: string[]; ttl: number };

/** Один запрос: TLS поверх `raw`, GET, разбор JSON. */
export function dohOverSocket(raw: Socket, server: DohServer, name: string): Promise<DohResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(new Error('нет ответа')); }, DOH_TIMEOUT_MS);
    const req = https.request({
      host: server.ip,
      path: server.path(name),
      headers: { accept: 'application/dns-json', connection: 'close' },
      createConnection: () => tls.connect({ socket: raw, servername: server.servername }),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; if (body.length > 65_536) req.destroy(new Error('ответ слишком большой')); });
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let parsed: Answer;
        try { parsed = JSON.parse(body) as Answer; } catch { reject(new Error('ответ не JSON')); return; }
        if (parsed.Status === 3) { reject(new ResolveError(`имени «${name}» нет`)); return; }
        const records = (parsed.Answer ?? []).filter((a) => a.type === 1 && typeof a.data === 'string' && isIP(a.data) === 4);
        if (records.length === 0) { reject(new ResolveError(`у «${name}» нет IPv4-адреса`)); return; }
        const ttl = Math.min(...records.map((r) => r.TTL ?? MIN_TTL_S));
        resolve({ ips: records.map((r) => r.data as string), ttl });
      });
    });
    req.on('error', (error) => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

/** Серверы по очереди; `open` — как дотянуться до сервера (через выход или прокси). */
export async function dohLookup(open: (server: DohServer) => Promise<Socket>, name: string, via: string): Promise<DohResult> {
  const errors: string[] = [];
  for (const server of DOH_SERVERS) {
    try {
      return await dohOverSocket(await open(server), server, name);
    } catch (error) {
      if (error instanceof ResolveError) throw error;
      errors.push(`${server.ip}: ${errorText(error)}`);
    }
  }
  throw new Error(`имя «${name}» не разрешилось ${via} — ${errors.join('; ')}`);
}
