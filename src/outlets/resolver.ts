import { Resolver as DnsResolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { dialVia } from '../dial.ts';
import { errorText } from '../log.ts';
import { tcpLookup } from './dns-tcp.ts';
import { DOH_TIMEOUT_MS, dohLookup, ResolveError, type DohResult } from './doh.ts';
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
 *
 * Прямой выход — резолвер этой машины: российский сервис через него получает
 * российский узел CDN, как у любого абонента дома.
 *
 * Имя правила «только через этот выход» — DNS самого выхода (`internal`, его
 * выдал корпоративный VPN, `outlet-dns.ts`), по TCP через выход: внутри
 * компании имя разрешается во внутренний адрес. DNS выхода не ответил — как
 * всегда, DoH (раз в журнал); «имени нет» от него — ответ, а не сбой.
 */

/** DNS выхода для этого имени: правило «только через него» и DNS есть — адреса, иначе пусто. */
export type InternalDns = (outlet: Outlet, name: string) => string[];

const MIN_TTL_S = 30;
const MAX_TTL_S = 3_600;
const MAX_ENTRIES = 5_000;

export class Resolver {
  private readonly cache = new Map<string, { ips: string[]; until: number }>();
  private readonly inflight = new Map<string, Promise<string[]>>();
  private readonly internal: InternalDns;
  private readonly warn: (text: string) => void;
  private warned = new Set<string>();

  constructor(opts: { internal?: InternalDns; warn?: (text: string) => void } = {}) {
    this.internal = opts.internal ?? (() => []);
    this.warn = opts.warn ?? (() => {});
  }

  /** Адреса имени через выход. Голый IP возвращается как есть. */
  async resolve(outlet: Outlet, host: string): Promise<string[]> {
    if (isIP(host) !== 0) return [host];
    const name = host.toLowerCase().replace(/\.$/, '');
    const servers = outlet.direct ? [] : this.internal(outlet, name);
    // Свой ключ у ответа DNS выхода: правило сменилось — не отдать внутренний адрес вместо публичного.
    const key = `${outlet.name}${servers.length > 0 ? ' dns ' : ' '}${name}`;
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.ips;

    const running = this.inflight.get(key);
    if (running) return running;
    const job = this.lookup(outlet, name, servers).then((r) => {
      if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
      const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, r.ttl));
      this.cache.set(key, { ips: r.ips, until: Date.now() + ttl * 1000 });
      return r.ips;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private readonly system = new DnsResolver({ timeout: DOH_TIMEOUT_MS, tries: 2 });

  private async lookup(outlet: Outlet, name: string, servers: string[]): Promise<DohResult> {
    if (outlet.direct) {
      const records = await this.system.resolve4(name, { ttl: true });
      return { ips: records.map((r) => r.address), ttl: Math.min(...records.map((r) => r.ttl)) };
    }
    if (servers.length > 0) {
      try {
        const r = await this.viaOutletDns(outlet, name, servers);
        this.warned.delete(outlet.name);
        return r;
      } catch (error) {
        if (error instanceof ResolveError) throw error;
        if (!this.warned.has(outlet.name)) this.warn(`${errorText(error)} — «${name}» через DoH, как обычно`);
        this.warned.add(outlet.name);
      }
    }
    return dohLookup((server) => dialVia(outlet, server.ip, 443, DOH_TIMEOUT_MS), name, `через «${outlet.name}»`);
  }

  private async viaOutletDns(outlet: Outlet, name: string, servers: string[]): Promise<DohResult> {
    const errors: string[] = [];
    for (const ip of servers.slice(0, 2)) {
      try {
        return await tcpLookup(await dialVia(outlet, ip, 53, DOH_TIMEOUT_MS), name);
      } catch (error) {
        if (error instanceof ResolveError) throw error;
        errors.push(`${ip}: ${errorText(error)}`);
      }
    }
    throw new Error(`DNS выхода «${outlet.name}» не ответил (${errors.join('; ')})`);
  }
}
