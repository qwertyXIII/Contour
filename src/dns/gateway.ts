import { statSync } from 'node:fs';
import type { Packet } from 'dns-packet';
import { arpTable } from '../arp.ts';
import { GATEWAY_FILE, readGateway, type GatewayState } from '../gateway.ts';
import { errorText, type Logger } from '../log.ts';
import { ResolveError, type DohResult } from '../outlets/doh.ts';
import { respond, type GatewayHook } from './server.ts';

/**
 * DNS для устройств-шлюзов (`src/gateway.ts`).
 *
 * Шлюз узнаём по MAC из таблицы соседей: адрес у такого устройства задан
 * вручную, но список режимов — по MAC. На заблокированное имя такому
 * устройству — не наш адрес, а настоящие, разрешённые через туннель, и
 * ответ уходит только после того, как помощник положил их в набор «через VPN»:
 * иначе первые пакеты успели бы уйти напрямую, и соединение так бы и осталось
 * на прямом пути (путь решает первый пакет).
 *
 * Не вышло (туннель не ответил, помощник молчит) — null, и устройство получит
 * наш адрес, как все: сайты по SNI-входу всё равно откроются.
 */

const RECHECK_MS = 5_000;
/** Тот же адрес в набор не чаще: срок в наборе — от часа (`root/gateway.ts`). */
const ALLOW_AGAIN_MS = 10 * 60_000;
const ANSWER_TTL_MAX_S = 300;
const WARN_EVERY_MS = 60_000;

export class GatewayClients {
  private readonly file: string;
  private readonly arpFile: string | undefined;
  private state: GatewayState = { devices: {} };
  private mtime = -2;
  private checkedAt = 0;
  private arp = new Map<string, string>();
  private arpAt = 0;

  constructor(file = GATEWAY_FILE, arpFile?: string) {
    this.file = file;
    this.arpFile = arpFile;
  }

  private refresh(now: number): void {
    if (now - this.checkedAt < RECHECK_MS) return;
    this.checkedAt = now;
    let m = -1;
    try { m = statSync(this.file).mtimeMs; } catch { /* файла нет — шлюзов нет */ }
    if (m !== this.mtime) {
      this.mtime = m;
      this.state = readGateway(this.file);
    }
  }

  isGateway(ip: string, now = Date.now()): boolean {
    this.refresh(now);
    if (Object.keys(this.state.devices).length === 0) return false;
    if (now - this.arpAt >= RECHECK_MS || !this.arp.has(ip)) {
      this.arp = arpTable(this.arpFile);
      this.arpAt = now;
    }
    const mac = this.arp.get(ip);
    return mac !== undefined && mac in this.state.devices;
  }
}

export type GatewayAnswerDeps = {
  clients: Pick<GatewayClients, 'isGateway'>;
  resolve: (name: string) => Promise<DohResult>;
  /** Положить адреса в набор «через VPN» (помощник от root). */
  allow: (ips: string[], ttl: number) => Promise<void>;
  log: Logger;
};

export function gatewayHook(deps: GatewayAnswerDeps): GatewayHook {
  const allowedAt = new Map<string, number>();
  let warnedAt = 0;
  const warn = (text: string): void => {
    if (Date.now() - warnedAt < WARN_EVERY_MS) return;
    warnedAt = Date.now();
    deps.log.warn(`шлюз: ${text}`);
  };
  return {
    isGateway: (client) => deps.clients.isGateway(client),
    async answer(query: Packet, name: string) {
      const q = query.questions?.[0];
      if (q?.type !== 'A') return null; // AAAA, HTTPS — пусто, как у всех
      try {
        const r = await deps.resolve(name);
        const now = Date.now();
        const fresh = r.ips.filter((ip) => now - (allowedAt.get(ip) ?? 0) >= ALLOW_AGAIN_MS);
        if (fresh.length > 0) {
          await deps.allow(fresh, r.ttl);
          if (allowedAt.size > 20_000) allowedAt.clear();
          for (const ip of fresh) allowedAt.set(ip, now);
        }
        return respond(query, r.ips.map((ip) => ({ type: 'A' as const, name: q.name, class: 'IN' as const, ttl: Math.min(r.ttl, ANSWER_TTL_MAX_S), data: ip })));
      } catch (error) {
        // Имени нет или нет IPv4 — это ответ: пусто, а не наш адрес (по нему сайта всё равно нет).
        if (error instanceof ResolveError) return respond(query, []);
        warn(`${name} — ${errorText(error)}; ответил нашим адресом`);
        return null;
      }
    },
  };
}
