import type { Socket } from 'node:net';
import type { Consumers } from '../consumers.ts';
import { errorText, type Logger } from '../log.ts';
import type { Outlet } from '../outlets/outlet.ts';
import type { Chooser } from '../select/chooser.ts';
import type { Meter } from '../stats/meter.ts';

/**
 * Поток байт клиента через выход — с повтором и проигрыванием.
 *
 * ⚠️ mihomo отвечает SOCKS «успех» ДО того, как соединился с сайтом (замечено
 * на живом запуске 2026-10-01: отказ приходил уже после «успеха» как
 * молчаливое закрытие). Поэтому повтор через другой выход устроен не на
 * соединении, а **с проигрыванием**: пока от сайта не пришло ни байта, байты
 * клиента копятся в буфере; выход закрылся молча — соединяемся через
 * следующий и проигрываем буфер. Для TLS это ровно ClientHello.
 *
 * Общий для входов: HTTP CONNECT отвечает клиенту «200» в `onEstablished`,
 * SNI-вход ничего не отвечает — клиент и так ждёт ответа сайта.
 */

export type Target = { host: string; port: number };
export type RelayDeps = { chooser: Chooser; consumers: Consumers; log: Logger; meter?: Meter };
export type RelayHooks = {
  /** Первый выход открылся — один раз. */
  onEstablished: () => void;
  /** Ни один выход не открылся, пока клиенту ещё ничего не ответили. */
  onFail: (text: string) => void;
};

/** Сколько байт клиента держим для проигрывания; больше — повтор уже невозможен. */
const REPLAY_CAP = 256 * 1024;
/** Сколько выходов перебираем на одно соединение. */
export const MAX_ATTEMPTS = 4;

export function relay(client: Socket, head: Buffer, who: string, target: Target, deps: RelayDeps, hooks: RelayHooks): void {
  const { chooser, consumers, log, meter } = deps;
  const where = `${who}: ${target.host}:${target.port}`;
  const exclude = new Set<string>();
  let buffered: Buffer[] = head.length > 0 ? [head] : [];
  let bufferedBytes = head.length;
  let replayable = true;
  let attempts = 0;
  let established = false;
  let finished = false;
  let upstream: Socket | null = null;
  let outletName = '';
  let up = 0;
  let down = 0;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    client.destroy();
    upstream?.destroy();
    consumers.account(who, up, down);
    log.debug(`${where} через «${outletName}» — ↑${up} ↓${down}`);
  };

  const attach = (socket: Socket, outlet: Outlet): void => {
    upstream = socket;
    outletName = outlet.name;
    for (const chunk of buffered) socket.write(chunk);
    // Проигранное считаем один раз — на первом выходе, не на каждом повторе.
    if (attempts === 1) meter?.add(who, outlet.name, target.host, bufferedBytes, 0);
    socket.on('data', (chunk: Buffer) => {
      if (replayable) { replayable = false; buffered = []; }
      down += chunk.length;
      meter?.add(who, outlet.name, target.host, 0, chunk.length);
      if (!client.write(chunk)) socket.pause();
    });
    socket.on('drain', () => client.resume());
    socket.on('error', () => { /* закрытие ниже решит, повторять ли */ });
    socket.on('close', () => {
      if (finished || socket !== upstream) return;
      upstream = null;
      if (replayable && !client.destroyed && attempts < MAX_ATTEMPTS) {
        void next(outlet, 'закрыл соединение, не ответив');
      } else {
        finish();
      }
    });
  };

  const next = async (failed: Outlet | null, why: string): Promise<void> => {
    if (failed) {
      exclude.add(failed.name);
      chooser.noteFailure(failed, why);
    }
    attempts += 1;
    try {
      const { socket, outlet, failed: skipped } = await chooser.connect(target.host, target.port, exclude);
      if (client.destroyed) { socket.destroy(); return; }
      if (failed) log.info(`${where} — «${failed.name}» ${why}, повтор через «${outlet.name}»`);
      else if (skipped.length > 0) log.info(`${where} через «${outlet.name}» после отказа ${skipped.join(', ')}`);
      attach(socket, outlet);
      if (!established) {
        established = true;
        hooks.onEstablished();
      }
    } catch (error) {
      const text = errorText(error);
      log.warn(`${where} — ${text}`);
      if (!established) hooks.onFail(text);
      else finish();
    }
  };

  client.setTimeout(0);
  client.on('data', (chunk: Buffer) => {
    up += chunk.length;
    if (replayable) {
      bufferedBytes += chunk.length;
      if (bufferedBytes > REPLAY_CAP) { replayable = false; buffered = []; }
      else buffered.push(chunk);
    }
    if (upstream) meter?.add(who, outletName, target.host, chunk.length, 0);
    if (upstream && !upstream.write(chunk)) client.pause();
  });
  client.on('drain', () => upstream?.resume());
  client.on('close', finish);
  client.on('error', finish);

  void next(null, '');
}
