import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

/**
 * DNS, который выдал выходу его сервер (корпоративный VPN: `dhcp-option DNS`).
 * Пишет корневой скрипт подъёма OpenVPN (`deploy/contour-ovpn-up.sh`) при
 * подключении, по файлу на выход; Contour только читает. Нужен для имён правил
 * «только через этот выход»: внутри компании имя разрешается во внутренний
 * адрес, а публичный DNS даёт внешний вход, который чужим отвечает отказом
 * (живьём 2026-10-06: Confluence — 10.42.10.x изнутри, 503 снаружи).
 *
 * Нет файла — нет DNS: имена выхода разрешаются как всегда (DoH через выход).
 * Файл перечитывается не чаще раза в `ttlMs`: выход переподключился — новый DNS.
 */

export const OUTLET_DNS_DIR = '/run/contour/outlet-dns';
const MAX_SERVERS = 3;

export class OutletDns {
  private readonly cache = new Map<string, { at: number; servers: string[] }>();
  private readonly dir: string;
  private readonly ttlMs: number;

  constructor(dir = OUTLET_DNS_DIR, ttlMs = 10_000) {
    this.dir = dir;
    this.ttlMs = ttlMs;
  }

  /** Адреса DNS выхода; нет — пусто. */
  servers(outlet: string, now = Date.now()): string[] {
    const hit = this.cache.get(outlet);
    if (hit && now - hit.at < this.ttlMs) return hit.servers;
    const servers = this.read(outlet);
    this.cache.set(outlet, { at: now, servers });
    return servers;
  }

  private read(outlet: string): string[] {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(outlet)) return [];
    try {
      const lines = readFileSync(path.join(this.dir, outlet), 'utf8').split('\n').map((s) => s.trim());
      return [...new Set(lines.filter((s) => isIP(s) === 4))].slice(0, MAX_SERVERS);
    } catch {
      return [];
    }
  }
}
