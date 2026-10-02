import { dohLookup, type DohResult } from '../outlets/doh.ts';
import { connectVia, type ProxyAuth } from './tunnel-probe.ts';

/**
 * Адреса имени через туннель — для устройств-шлюзов (`gateway.ts`): DoH к
 * публичному резолверу через HTTP-прокси Contour. CDN видит адрес выхода и
 * отдаёт узел рядом с ним — так и нужно: пакеты к этому адресу пойдут через
 * выход. Узел рядом с домом (кэш YouTube у провайдера) был бы медленным путём
 * «Германия → обратно в Россию».
 *
 * Кэш по TTL (от 30 с до 5 минут); одинаковые запросы в полёте — один.
 * `exit` — страна выхода для класса «через страну»: CDN рядом с ней, а не с
 * выходом по умолчанию (кэш — отдельно на страну).
 */

const MIN_TTL_S = 30;
const MAX_TTL_S = 300;
const MAX_ENTRIES = 5_000;

export class TunnelResolver {
  private readonly proxy: ProxyAuth;
  private readonly cache = new Map<string, { r: DohResult; until: number }>();
  private readonly inflight = new Map<string, Promise<DohResult>>();

  constructor(proxy: ProxyAuth) {
    this.proxy = proxy;
  }

  async resolve(name: string, exit?: string): Promise<DohResult> {
    const n = name.toLowerCase().replace(/\.$/, '');
    const key = exit ? `${exit} ${n}` : n;
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return { ips: hit.r.ips, ttl: Math.max(1, Math.round((hit.until - Date.now()) / 1000)) };
    const running = this.inflight.get(key);
    if (running) return running;
    const job = dohLookup((server) => connectVia(this.proxy, server.ip, 443, undefined, exit), n, exit ? `через выход ${exit}` : 'через туннель').then((r) => {
      const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, r.ttl));
      if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
      this.cache.set(key, { r: { ips: r.ips, ttl }, until: Date.now() + ttl * 1000 });
      return { ips: r.ips, ttl };
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }
}
