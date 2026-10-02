import net, { type Socket } from 'node:net';
import socks from 'socks';
import type { Outlet } from './outlets/outlet.ts';

const { SocksClient } = socks;

/**
 * Соединение с `host:port` через выход — SOCKS5 CONNECT к его локальному входу.
 *
 * Имя уходит в SOCKS как имя (а не адрес): разрешать его будет дальний конец
 * туннеля — см. `remote-dns-resolve` в конфиге mihomo.
 *
 * Прямой выход (`outlet.direct`) — обычное соединение отсюда. Ограду он проходит
 * та же: адрес сверяет `connect.ts` до этого вызова.
 */
export async function dialVia(outlet: Outlet, host: string, port: number, timeoutMs: number): Promise<Socket> {
  if (outlet.direct) return dialDirect(host, port, timeoutMs);
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

function dialDirect(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`нет соединения за ${timeoutMs / 1000} с`)); }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      resolve(socket);
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
