import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

/**
 * Открывается ли имя через туннель — рукопожатие TLS через HTTP-прокси Contour.
 *
 * Нужна самообучению, чтобы отличить блокировку от закрытого порта: многие
 * серверы на :443 просто молчат (сервер точного времени, почта), и без этой
 * проверки они уехали бы в VPN, а устройство потеряло бы их совсем. Через VPN
 * уводим только то, что через VPN действительно открывается.
 *
 * Токен — строка `contour-dns:…` в файле токенов Contour (её добавляет install.sh).
 */

const TIMEOUT_MS = 6_000;

export function readToken(tokensFile: string, name = 'contour-dns'): string | null {
  try {
    const line = readFileSync(tokensFile, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}:`));
    return line ? line.slice(name.length + 1).trim() : null;
  } catch {
    return null;
  }
}

export type ProxyAuth = { host: string; port: number; user: string; token: string };

/**
 * Сокет к `host:port` через HTTP-прокси Contour (CONNECT с токеном) — то же, что
 * делает любая программа. `exit` — страна выхода (`Contour-Exit`): ответ DNS для
 * класса «через страну» — от резолвера рядом с выходом этой страны.
 */
export function connectVia(proxy: ProxyAuth, host: string, port: number, timeoutMs = TIMEOUT_MS, exit?: string): Promise<net.Socket> {
  const auth = Buffer.from(`${proxy.user}:${proxy.token}`).toString('base64');
  const country = exit && /^[A-Z]{2}$/.test(exit) ? `Contour-Exit: ${exit}\r\n` : '';
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxy.port, proxy.host);
    const timer = setTimeout(() => fail(new Error('через VPN тоже молчит')), timeoutMs);
    function fail(e: Error): void { clearTimeout(timer); raw.destroy(); reject(e); }
    raw.once('error', fail);
    raw.once('connect', () => {
      raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${auth}\r\n${country}\r\n`);
    });
    let head = '';
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > 4096) fail(new Error('прокси ответил непонятно')); return; }
      raw.off('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(head)) { fail(new Error(`прокси: ${head.split('\r\n')[0]}`)); return; }
      clearTimeout(timer);
      raw.off('error', fail);
      resolve(raw);
    };
    raw.on('data', onData);
  });
}

export function makeTunnelProbe(proxy: ProxyAuth): (name: string) => Promise<void> {
  return async (name) => {
    const raw = await connectVia(proxy, name, 443);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { secure.destroy(); reject(new Error('через VPN тоже молчит')); }, TIMEOUT_MS);
      const secure = tls.connect({ socket: raw, servername: name, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] });
      secure.once('secureConnect', () => { clearTimeout(timer); secure.destroy(); resolve(); });
      secure.once('error', (e) => { clearTimeout(timer); secure.destroy(); reject(e); });
    });
  };
}
