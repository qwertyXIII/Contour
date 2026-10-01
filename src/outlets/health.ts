import { isIP, type Socket } from 'node:net';
import { dialVia } from '../dial.ts';
import { errorText, type Logger } from '../log.ts';
import type { Outlet } from './outlet.ts';

/**
 * Живость выходов.
 *
 * Раз в `intervalMs` через каждый выход уходит маленький запрос по http
 * (`GET /generate_204`), и выход считается живым по ответу, а не по тому, что
 * туннель «поднят»: WireGuard не знает понятия «соединение», у него есть
 * только рукопожатие, которое могло быть пять минут назад.
 *
 * Мёртвым выход становится после двух отказов подряд, живым — после одного
 * успеха. Отказ соединения потребителя (`recheck`) не роняет выход сам по
 * себе — сайт мог просто не ответить, — а только зовёт внеочередную проверку.
 *
 * Раз в `ipIntervalMs` — внешний адрес выхода: главный ответ на вопрос
 * «а точно через VPN?».
 */

export type HealthOptions = {
  intervalMs: number;
  connectTimeoutMs: number;
  probeHost: string;
  probePath: string;
  ipHost: string;
  ipIntervalMs: number;
  log: Logger;
};

export type Health = {
  stop(): void;
  /** Внеочередная проверка — после отказа соединения через этот выход. */
  recheck(outlet: Outlet): void;
};

const DEAD_AFTER = 2;
const RESPONSE_TIMEOUT_MS = 8_000;

/** Один запрос по открытому сокету: строка статуса и тело (до конца соединения). */
export function httpOverSocket(socket: Socket, host: string, path: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('нет ответа')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { data += chunk; if (data.length > 65_536) socket.destroy(); });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('close', () => {
      clearTimeout(timer);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(data);
      if (!m) { reject(new Error('ответ не похож на HTTP')); return; }
      const split = data.indexOf('\r\n\r\n');
      resolve({ status: Number(m[1]), body: split >= 0 ? data.slice(split + 4) : '' });
    });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: contour\r\nConnection: close\r\n\r\n`);
  });
}

export function startHealth(outlets: Outlet[], opts: HealthOptions): Health {
  const busy = new Set<string>();
  const ipAt = new Map<string, number>();
  let stopped = false;

  const probe = async (outlet: Outlet): Promise<void> => {
    if (busy.has(outlet.name) || stopped) return;
    busy.add(outlet.name);
    const started = Date.now();
    try {
      const socket = await dialVia(outlet, opts.probeHost, 80, opts.connectTimeoutMs);
      const { status } = await httpOverSocket(socket, opts.probeHost, opts.probePath, RESPONSE_TIMEOUT_MS);
      if (status < 200 || status >= 400) throw new Error(`проверочный адрес ответил ${status}`);
      outlet.latencyMs = Date.now() - started;
      outlet.failures = 0;
      outlet.lastError = null;
      if (outlet.state !== 'alive') {
        opts.log.info(`выход «${outlet.name}» жив, ${outlet.latencyMs} мс`);
        outlet.state = 'alive';
        ipAt.delete(outlet.name);
      }
      opts.log.graph('outlet.latency_ms', outlet.latencyMs, { meta: { outlet: outlet.name } });
    } catch (error) {
      outlet.failures += 1;
      outlet.lastError = errorText(error);
      if (outlet.state !== 'dead' && outlet.failures >= DEAD_AFTER) {
        opts.log.warn(`выход «${outlet.name}» не отвечает: ${outlet.lastError}`);
        outlet.state = 'dead';
      }
    } finally {
      outlet.checkedAt = Date.now();
      busy.delete(outlet.name);
    }
    if (outlet.state === 'alive' && Date.now() - (ipAt.get(outlet.name) ?? 0) >= opts.ipIntervalMs) {
      ipAt.set(outlet.name, Date.now());
      await externalIp(outlet);
    }
  };

  const externalIp = async (outlet: Outlet): Promise<void> => {
    try {
      const socket = await dialVia(outlet, opts.ipHost, 80, opts.connectTimeoutMs);
      const { status, body } = await httpOverSocket(socket, opts.ipHost, '/', RESPONSE_TIMEOUT_MS);
      const ip = body.trim();
      if (status !== 200 || isIP(ip) === 0) throw new Error(`ответ ${status}: ${ip.slice(0, 40)}`);
      if (ip !== outlet.externalIp) {
        opts.log.info(`выход «${outlet.name}»: внешний адрес ${ip}`);
        outlet.externalIp = ip;
      }
    } catch (error) {
      opts.log.warn(`выход «${outlet.name}»: внешний адрес не узнать — ${errorText(error)}`);
    }
  };

  const tick = (): void => { for (const o of outlets) void probe(o); };
  tick();
  const timer = setInterval(tick, opts.intervalMs);
  timer.unref();

  return {
    stop() { stopped = true; clearInterval(timer); },
    recheck(outlet) { void probe(outlet); },
  };
}
