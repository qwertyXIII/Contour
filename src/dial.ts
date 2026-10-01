import type { Socket } from 'node:net';
import socks from 'socks';
import type { Outlet } from './outlets/outlet.ts';

const { SocksClient } = socks;

/**
 * Соединение с `host:port` через выход — SOCKS5 CONNECT к его локальному входу.
 *
 * Имя уходит в SOCKS как имя (а не адрес): разрешать его будет дальний конец
 * туннеля — см. `remote-dns-resolve` в конфиге mihomo.
 */
export async function dialVia(outlet: Outlet, host: string, port: number, timeoutMs: number): Promise<Socket> {
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: outlet.socks.host,
      port: outlet.socks.port,
      type: 5,
      userId: outlet.socks.user,
      password: outlet.socks.pass,
    },
    command: 'connect',
    destination: { host, port },
    timeout: timeoutMs,
  });
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);
  return socket;
}
