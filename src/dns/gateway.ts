import { statSync } from 'node:fs';
import type { Packet } from 'dns-packet';
import { arpTable } from '../arp.ts';
import { GATEWAY_FILE, readGateway, ROUTE_DIRECT, ROUTE_TUNNEL, type GatewayRoute, type GatewayState } from '../gateway.ts';
import { errorText, type Logger } from '../log.ts';
import { ResolveError, type DohResult } from '../outlets/doh.ts';
import type { RootRequest } from '../root/protocol.ts';
import { respond, type Decision, type GatewayHook } from './server.ts';

/**
 * DNS для устройств-шлюзов (`src/gateway.ts`).
 *
 * Шлюз узнаём по MAC из таблицы соседей: адрес у такого устройства задан
 * вручную, но список режимов — по MAC. ⚠️ И только если устройство на деле
 * шлёт пакеты через сервер (`gateway.seen` у помощника): отметка в панели без
 * маршрутизатора `.50` на самом устройстве — не шлюз. Отдай мы такому настоящие
 * адреса, его пакеты ушли бы мимо нас прямо в блокировку (живьём 2026-10-02:
 * телефон с отметкой, но на DHCP, потерял бы и сайты, и игру). Помощник
 * не ответил — значит, не шлюз: наш адрес, как раньше. На заблокированное имя такому
 * устройству — не наш адрес, а настоящие, разрешённые через туннель, и
 * ответ уходит только после того, как помощник положил их в набор «через VPN»:
 * иначе первые пакеты успели бы уйти напрямую, и соединение так бы и осталось
 * на прямом пути (путь решает первый пакет).
 *
 * Не вышло (туннель не ответил, помощник молчит или не знает класса) —
 * устройство получит наш адрес, как все: сайты по SNI-входу всё равно откроются.
 *
 * Куда имени — решает внедряемая функция `route` (движок правил): класс
 * маршрута, `tunnel` («как сейчас»), `direct` или null — «как всем». Без неё —
 * как было: заблокированное — через туннели, остальное — как всем.
 * Адреса класса кладутся в его набор, и ответ уходит только после этого — как
 * с «как сейчас». «Напрямую» — настоящие адреса обычного DNS, в наборы ничего:
 * как сейчас у незаблокированного.
 */

const RECHECK_MS = 5_000;
/** Кто на деле ходит через сервер — спрашиваем помощника не чаще. */
const SEEN_MS = 10_000;
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
  private readonly seenSource: (() => Promise<string[]>) | null;
  private seen = new Set<string>();
  private seenAt = 0;
  private seenBusy = false;

  /** `seenSource` — кто из устройств на деле шлёт пакеты через сервер; null — не проверять (тесты). */
  constructor(file = GATEWAY_FILE, arpFile?: string, seenSource: (() => Promise<string[]>) | null = null) {
    this.file = file;
    this.arpFile = arpFile;
    this.seenSource = seenSource;
  }

  /** Спросить помощника в фоне; до ответа — «не шлюз» (наш адрес), это безопасно. */
  private isSeen(mac: string, now: number): boolean {
    if (!this.seenSource) return true;
    if (!this.seenBusy && now - this.seenAt >= SEEN_MS) {
      this.seenBusy = true;
      this.seenSource()
        .then((list) => { this.seen = new Set(list); })
        .catch(() => { this.seen = new Set(); })
        .finally(() => { this.seenAt = Date.now(); this.seenBusy = false; });
    }
    return this.seen.has(mac);
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
    return mac !== undefined && mac in this.state.devices && this.isSeen(mac, now);
  }
}

/** Куда имени для устройства-шлюза: класс, `tunnel`, `direct`; null — «как всем» (наш адрес или обычный DNS). */
export type RouteFor = (name: string, decision: Decision) => GatewayRoute | null | Promise<GatewayRoute | null>;

/**
 * Как до движка правил: заблокированное (списки, самообучение, ручное «через
 * VPN») — «как сейчас», остальное — как всем. Движку правил — запасным путём:
 * своё правило не нашлось → `defaultRoute`. ⚠️ «Не совпало» — null, а не
 * `direct`: у шлюза умолчание задаёт режим устройства (`blocked` — напрямую,
 * `all` — через VPN), и `direct` на каждое имя лишь тратил бы запросы.
 */
export const defaultRoute: RouteFor = (_name, decision) => (decision.tunnel ? ROUTE_TUNNEL : null);

/**
 * Запрос помощнику: «как сейчас» — старой командой `gateway.allow` (её знает и
 * помощник до классов), класс — `gateway.route` (старый помощник ответит
 * «неизвестная команда» — и устройство получит наш адрес, а не чужой путь).
 */
export function allowRequest(ips: string[], ttl: number, route: GatewayRoute): RootRequest {
  return route === ROUTE_TUNNEL ? { cmd: 'gateway.allow', ips, ttl } : { cmd: 'gateway.route', ips, ttl, route };
}

export type GatewayAnswerDeps = {
  clients: Pick<GatewayClients, 'isGateway'>;
  /** Адреса имени через туннель; `route` — куда пойдут пакеты (чтобы спросить через выход той же страны: CDN рядом с выходом). */
  resolve: (name: string, route: GatewayRoute) => Promise<DohResult>;
  /** Положить адреса в набор класса `route` (помощник от root). */
  allow: (ips: string[], ttl: number, route: GatewayRoute) => Promise<void>;
  /** Куда имени; нет — `defaultRoute`. */
  route?: RouteFor;
  log: Logger;
};

export function gatewayHook(deps: GatewayAnswerDeps): GatewayHook {
  const routeFor = deps.route ?? defaultRoute;
  /** Адрес → куда положен и когда: тот же адрес туда же — не чаще ALLOW_AGAIN_MS, в другой класс — сразу. */
  const allowedAt = new Map<string, { route: GatewayRoute; at: number }>();
  let warnedAt = 0;
  const warn = (text: string): void => {
    if (Date.now() - warnedAt < WARN_EVERY_MS) return;
    warnedAt = Date.now();
    deps.log.warn(`шлюз: ${text}`);
  };
  return {
    isGateway: (client) => deps.clients.isGateway(client),
    async answer(query: Packet, name: string, decision: Decision) {
      let picked: GatewayRoute | null;
      try {
        picked = await routeFor(name, decision);
      } catch (error) {
        warn(`${name} — куда вести, не решено: ${errorText(error)}; ответил как всем`);
        return null;
      }
      const route = picked;
      if (route === null) return null;
      if (route === ROUTE_DIRECT) return 'upstream';
      const q = query.questions?.[0];
      // AAAA, HTTPS — пусто: устройство ушло бы по IPv6 или по подсказке мимо класса.
      if (q?.type !== 'A') return respond(query, []);
      try {
        const r = await deps.resolve(name, route);
        const now = Date.now();
        const fresh = r.ips.filter((ip) => {
          const was = allowedAt.get(ip);
          return was === undefined || was.route !== route || now - was.at >= ALLOW_AGAIN_MS;
        });
        if (fresh.length > 0) {
          await deps.allow(fresh, r.ttl, route);
          if (allowedAt.size > 20_000) allowedAt.clear();
          for (const ip of fresh) allowedAt.set(ip, { route, at: now });
        }
        return respond(query, r.ips.map((ip) => ({ type: 'A' as const, name: q.name, class: 'IN' as const, ttl: Math.min(r.ttl, ANSWER_TTL_MAX_S), data: ip })));
      } catch (error) {
        // Имени нет или нет IPv4 — это ответ: пусто, а не наш адрес (по нему сайта всё равно нет).
        if (error instanceof ResolveError) return respond(query, []);
        // Наш адрес, а не настоящие мимо класса: по SNI сайт поведёт сам Contour.
        warn(`${name} — ${errorText(error)}; ответил нашим адресом`);
        return 'own';
      }
    },
  };
}
