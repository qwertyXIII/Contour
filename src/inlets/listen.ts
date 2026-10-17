import type net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorText, type Logger } from '../log.ts';

const RETRY_BIND_MS = 10_000;

/**
 * Слушать адрес, которого может ещё не быть, — повторяя. Второй адрес сервера
 * (`lan.address`) держит сторож `contour-addr`: при старте его может не быть,
 * а `dhcpcd` при потере аренды снимает его вовсе.
 */
export async function listenRetrying(server: net.Server, address: string, port: number, log: Logger, what: string): Promise<void> {
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, address, () => { server.off('error', reject); resolve(); });
      });
      log.info(`${what} слушает ${address}:${port}`);
      return;
    } catch (error) {
      log.error(`${what} ${address}:${port} не открылся: ${errorText(error)}; повтор через ${RETRY_BIND_MS / 1000} с`);
      await sleep(RETRY_BIND_MS);
    }
  }
}
