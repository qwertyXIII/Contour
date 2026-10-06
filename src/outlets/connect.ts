import type { Socket } from 'node:net';
import { dialVia } from '../dial.ts';
import { checkDestination } from '../inlets/fence.ts';
import type { Outlet } from './outlet.ts';
import type { Resolver } from './resolver.ts';

/**
 * Соединение через выход по имени: имя → адрес (DoH через этот же выход) →
 * ограда по адресу → SOCKS к адресу.
 *
 * Ограда здесь вторая: первая на входе смотрит на то, что просил клиент, а
 * эта — на то, во что имя разрешилось. Имя, которое указывает на `127.0.0.1`
 * или `192.168.x.x`, иначе было бы обходом первой.
 *
 * `allow(ip, outlet)` — единственное исключение: частный адрес из подсети
 * правила «только через эти выходы», и только через выход из этого правила
 * (корпоративная сеть — корпоративными туннелями, решение 2026-10-02).
 *
 * `blocked(outlet, host, ips)` — имя разрешилось только в закрытые адреса:
 * кому интересно (подсказка панели «добавь подсеть в правило»), тот узнает.
 */

export type Dial = (outlet: Outlet, host: string, port: number) => Promise<Socket>;

export class FenceError extends Error {}

export type FenceAllow = (ip: string, outlet: Outlet) => boolean;

export type Blocked = (outlet: Outlet, host: string, ips: string[]) => void;

export function makeDial(resolver: Pick<Resolver, 'resolve'>, timeoutMs: number, allow: FenceAllow = () => false, blocked: Blocked = () => {}): Dial {
  return async (outlet, host, port) => {
    const ips = await resolver.resolve(outlet, host);
    const allowed = ips.filter((ip) => checkDestination(ip, port).ok || allow(ip, outlet));
    if (allowed.length === 0) {
      blocked(outlet, host, ips);
      throw new FenceError(`«${host}» указывает на частный адрес (${ips.join(', ')}) — через «${outlet.name}» ограда его не пускает: нет подсети в правиле «только через»`);
    }
    let last: unknown = null;
    // Адресов несколько — пробуем по очереди, но не больше двух: третий редко спасает, а время идёт.
    for (const ip of allowed.slice(0, 2)) {
      try {
        return await dialVia(outlet, ip, port, timeoutMs);
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  };
}
