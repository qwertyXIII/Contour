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

export function makeTunnelProbe(proxy: { host: string; port: number; user: string; token: string }): (name: string) => Promise<void> {
  const auth = Buffer.from(`${proxy.user}:${proxy.token}`).toString('base64');
  return (name) => new Promise<void>((resolve, reject) => {
    const raw = net.connect(proxy.port, proxy.host);
    const timer = setTimeout(() => { raw.destroy(); reject(new Error('через VPN тоже молчит')); }, TIMEOUT_MS);
    const fail = (e: Error): void => { clearTimeout(timer); raw.destroy(); reject(e); };
    raw.once('error', fail);
    raw.once('connect', () => {
      raw.write(`CONNECT ${name}:443 HTTP/1.1\r\nHost: ${name}:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    let head = '';
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > 4096) fail(new Error('прокси ответил непонятно')); return; }
      raw.off('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(head)) { fail(new Error(`прокси: ${head.split('\r\n')[0]}`)); return; }
      const secure = tls.connect({ socket: raw, servername: name, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] });
      secure.once('secureConnect', () => { clearTimeout(timer); secure.destroy(); resolve(); });
      secure.once('error', (e) => fail(e));
    };
    raw.on('data', onData);
  });
}
