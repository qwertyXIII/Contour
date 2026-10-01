import https from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { dialVia } from '../dial.ts';
import { errorText } from '../log.ts';
import type { Outlet } from './outlet.ts';

/**
 * Имена — через тот же выход, по DNS-over-HTTPS.
 *
 * Почему не резолвер mihomo: на живом запуске 2026-10-01 его DNS поверх UDP
 * внутри туннеля отвечал через раз (`dns resolve failed: context deadline
 * exceeded` на каждой второй проверке), а TCP через тот же туннель — всегда:
 * DoH к `1.1.1.1` по IP прошёл 15 из 15 за 0,5 с. Поэтому имя разрешаем сами,
 * через выход, и в SOCKS отдаём уже адрес. Резолвер — публичный и снаружи
 * туннеля, так что CDN отдаёт узел рядом с выходом, как и раньше.
 *
 * Кэш — на выход и имя, по TTL ответа (от 30 с до часа); одинаковые запросы
 * в полёте сливаются в один.
 */

type Server = { ip: string; servername: string; path: (name: string) => string };

const SERVERS: Server[] = [
  { ip: '1.1.1.1', servername: 'cloudflare-dns.com', path: (n) => `/dns-query?name=${encodeURIComponent(n)}&type=A` },
  { ip: '8.8.8.8', servername: 'dns.google', path: (n) => `/resolve?name=${encodeURIComponent(n)}&type=A` },
];

const TIMEOUT_MS = 4_000;
const MIN_TTL_S = 30;
const MAX_TTL_S = 3_600;
const MAX_ENTRIES = 5_000;

type Answer = { Status?: number; Answer?: Array<{ type?: number; data?: string; TTL?: number }> };

export class ResolveError extends Error {}

/** Один запрос DoH через выход: открыть SOCKS к серверу, TLS поверх, GET. */
async function ask(outlet: Outlet, server: Server, name: string): Promise<{ ips: string[]; ttl: number }> {
  const raw = await dialVia(outlet, server.ip, 443, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(new Error('нет ответа')); }, TIMEOUT_MS);
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

export class Resolver {
  private readonly cache = new Map<string, { ips: string[]; until: number }>();
  private readonly inflight = new Map<string, Promise<string[]>>();

  /** Адреса имени через выход. Голый IP возвращается как есть. */
  async resolve(outlet: Outlet, host: string): Promise<string[]> {
    if (isIP(host) !== 0) return [host];
    const name = host.toLowerCase().replace(/\.$/, '');
    const key = `${outlet.name} ${name}`;
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.ips;

    const running = this.inflight.get(key);
    if (running) return running;
    const job = this.lookup(outlet, name).then((r) => {
      if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
      const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, r.ttl));
      this.cache.set(key, { ips: r.ips, until: Date.now() + ttl * 1000 });
      return r.ips;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async lookup(outlet: Outlet, name: string): Promise<{ ips: string[]; ttl: number }> {
    const errors: string[] = [];
    for (const server of SERVERS) {
      try {
        return await ask(outlet, server, name);
      } catch (error) {
        // «Имени нет» — ответ, а не сбой: второй сервер скажет то же самое.
        if (error instanceof ResolveError) throw error;
        errors.push(`${server.ip}: ${errorText(error)}`);
      }
    }
    throw new Error(`имя «${name}» не разрешилось через «${outlet.name}» — ${errors.join('; ')}`);
  }
}
