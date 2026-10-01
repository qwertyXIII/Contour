import http from 'node:http';
import type { Socket } from 'node:net';
import type { Consumers } from '../consumers.ts';
import { errorText, type Logger } from '../log.ts';
import type { Chooser } from '../select/chooser.ts';
import { checkDestination } from './fence.ts';

/**
 * Вход для программ машины: HTTP-прокси с токенами.
 *
 * `CONNECT host:port` — туннель байт в байт (так ходит всё по https);
 * `GET http://host/…` — обычный проброс для http. Без верного
 * `Proxy-Authorization` — 407: на машине живут чужие приложения, и прокси
 * без входа был бы бесплатным туннелем для любого из них.
 *
 * Клиент получает `200 Connection Established` только когда соединение
 * через выход уже есть — повтор по выходам (`Chooser`) для него невидим.
 */

export type HttpInletOptions = {
  listen: string;
  port: number;
  chooser: Chooser;
  consumers: Consumers;
  log: Logger;
};

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  407: 'Proxy Authentication Required',
  502: 'Bad Gateway',
};

/** Сырой ответ в сокет CONNECT и конец соединения. */
function refuse(socket: Socket, status: number, body = '', headers: Record<string, string> = {}): void {
  const text = STATUS_TEXT[status] ?? 'Error';
  const payload = body ? `${body}\n` : '';
  const head = [
    `HTTP/1.1 ${status} ${text}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(payload)}`,
    'Connection: close',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  socket.end(`${head.join('\r\n')}\r\n\r\n${payload}`);
}

const AUTH_HEADERS = { 'Proxy-Authenticate': 'Basic realm="contour"' };

/** `host:port` из строки CONNECT, в том числе `[::1]:443`. */
export function parseAuthority(value: string | undefined): { host: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(value ?? '');
  if (!m) return null;
  return { host: (m[1] ?? m[2]) as string, port: Number(m[3]) };
}

export function startHttpInlet(opts: HttpInletOptions): Promise<http.Server> {
  const { chooser, consumers, log } = opts;
  const server = http.createServer();
  // Туннели живут долго (докачка на часы) — таймаут соединения без дела не нужен.
  server.timeout = 0;
  server.keepAliveTimeout = 65_000;

  server.on('connect', (req, socket: Socket, head) => {
    const who = consumers.authorize(req.headers['proxy-authorization']);
    if (!who) { refuse(socket, 407, 'нужен токен', AUTH_HEADERS); return; }
    const target = parseAuthority(req.url);
    if (!target) { refuse(socket, 400, 'CONNECT host:port'); return; }
    const fence = checkDestination(target.host, target.port);
    if (!fence.ok) {
      log.warn(`${who}: отказ ограды — ${fence.reason}`);
      refuse(socket, 403, fence.reason);
      return;
    }
    socket.on('error', () => { /* клиент оборвал — ниже закроем выход */ });

    void chooser.connect(target.host, target.port).then(({ socket: upstream, outlet, failed }) => {
      if (socket.destroyed) { upstream.destroy(); return; }
      if (failed.length > 0) log.info(`${who}: ${target.host}:${target.port} через «${outlet.name}» после отказа ${failed.join(', ')}`);
      socket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: contour\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      socket.setTimeout(0);
      pipeBoth(socket, upstream, (up, down) => {
        consumers.account(who, up, down);
        log.debug(`${who}: ${target.host}:${target.port} через «${outlet.name}» — ↑${up} ↓${down}`);
      });
    }, (error: unknown) => {
      const text = errorText(error);
      log.warn(`${who}: ${target.host}:${target.port} — ${text}`);
      refuse(socket, 502, text);
    });
  });

  server.on('request', (req, res) => {
    const url = req.url ?? '';
    if (!/^https?:\/\//i.test(url)) {
      // Запрос к самому прокси, а не через него.
      res.writeHead(url === '/' ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(url === '/' ? 'contour\n' : 'не найдено\n');
      return;
    }
    const who = consumers.authorize(req.headers['proxy-authorization']);
    if (!who) {
      res.writeHead(407, { ...AUTH_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('нужен токен\n');
      return;
    }
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      res.writeHead(400); res.end('плохой адрес\n'); return;
    }
    if (target.protocol !== 'http:') { res.writeHead(400); res.end('через проброс только http; для https — CONNECT\n'); return; }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = Number(target.port) || 80;
    const fence = checkDestination(host, port);
    if (!fence.ok) {
      log.warn(`${who}: отказ ограды — ${fence.reason}`);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${fence.reason}\n`);
      return;
    }

    void chooser.connect(host, port).then(({ socket: upstream, outlet }) => {
      const headers = { ...req.headers };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      headers.connection = 'close';
      headers.host = target.host;
      let up = 0;
      let down = 0;
      req.on('data', (chunk: Buffer) => { up += chunk.length; });
      const out = http.request({
        createConnection: () => upstream,
        host,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      }, (answer) => {
        answer.on('data', (chunk: Buffer) => { down += chunk.length; });
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      out.on('error', (error) => {
        log.warn(`${who}: ${host}:${port} через «${outlet.name}» — ${error.message}`);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`${error.message}\n`);
      });
      res.on('close', () => {
        upstream.destroy();
        consumers.account(who, up, down);
      });
      req.pipe(out);
    }, (error: unknown) => {
      const text = errorText(error);
      log.warn(`${who}: ${host}:${port} — ${text}`);
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${text}\n`);
    });
  });

  server.on('clientError', (error: NodeJS.ErrnoException, socket: Socket) => {
    if (error.code !== 'ECONNRESET' && socket.writable) refuse(socket, 400, 'плохой запрос');
    else socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.listen, () => {
      server.off('error', reject);
      log.info(`вход HTTP-прокси слушает ${opts.listen}:${opts.port}`);
      resolve(server);
    });
  });
}

/** Два сокета навстречу, со счётом байт и закрытием второго вслед за первым. */
function pipeBoth(client: Socket, upstream: Socket, done: (up: number, down: number) => void): void {
  let up = 0;
  let down = 0;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    client.destroy();
    upstream.destroy();
    done(up, down);
  };
  client.on('data', (chunk: Buffer) => { up += chunk.length; });
  upstream.on('data', (chunk: Buffer) => { down += chunk.length; });
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('close', finish);
  upstream.on('close', finish);
  upstream.on('error', finish);
  client.on('error', finish);
}
