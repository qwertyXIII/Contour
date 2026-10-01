import http from 'node:http';
import type { Socket } from 'node:net';
import type { Consumers } from '../consumers.ts';
import { errorText, type Logger } from '../log.ts';
import type { Outlet } from '../outlets/outlet.ts';
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
 * ⚠️ mihomo отвечает SOCKS «успех» ДО того, как соединился с сайтом (замечено
 * на живом запуске 2026-10-01: отказ резолвера приходил уже после «успеха»
 * как молчаливое закрытие). Поэтому повтор через другой выход устроен не на
 * соединении, а **с проигрыванием**: пока от сайта не пришло ни байта, байты
 * клиента копятся в буфере; выход закрылся молча — соединяемся через следующий
 * и проигрываем буфер. Для TLS это ровно ClientHello, клиент ничего не замечает.
 */

export type HttpInletOptions = {
  listen: string;
  port: number;
  chooser: Chooser;
  consumers: Consumers;
  log: Logger;
};

type Target = { host: string; port: number };
type Deps = { chooser: Chooser; consumers: Consumers; log: Logger };

/** Сколько байт клиента держим для проигрывания; больше — повтор уже невозможен. */
const REPLAY_CAP = 256 * 1024;
/** Сколько выходов перебираем на одно соединение. */
const MAX_ATTEMPTS = 4;

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
export function parseAuthority(value: string | undefined): Target | null {
  const m = /^(?:\[([^\]]+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(value ?? '');
  if (!m) return null;
  return { host: (m[1] ?? m[2]) as string, port: Number(m[3]) };
}

// ─── CONNECT: туннель с повтором по выходам ────────────────────────────────

function serveConnect(client: Socket, head: Buffer, who: string, target: Target, deps: Deps): void {
  const { chooser, consumers, log } = deps;
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
    socket.on('data', (chunk: Buffer) => {
      if (replayable) { replayable = false; buffered = []; }
      down += chunk.length;
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
        client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: contour\r\n\r\n');
      }
    } catch (error) {
      const text = errorText(error);
      log.warn(`${where} — ${text}`);
      if (!established) refuse(client, 502, text);
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
    if (upstream && !upstream.write(chunk)) client.pause();
  });
  client.on('drain', () => upstream?.resume());
  client.on('close', finish);
  client.on('error', finish);

  void next(null, '');
}

// ─── Проброс http: запрос целиком, повтор для запросов без тела ────────────

function serveForward(req: http.IncomingMessage, res: http.ServerResponse, who: string, target: URL, deps: Deps): void {
  const { chooser, consumers, log } = deps;
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port) || 80;
  const where = `${who}: ${host}:${port}`;
  const exclude = new Set<string>();
  const retriable = req.method === 'GET' || req.method === 'HEAD';
  let attempts = 0;
  let up = 0;
  let down = 0;
  req.on('data', (chunk: Buffer) => { up += chunk.length; });

  const headers = { ...req.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  headers.connection = 'close';
  headers.host = target.host;

  const fail = (text: string): void => {
    log.warn(`${where} — ${text}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`${text}\n`);
  };

  const attempt = async (): Promise<void> => {
    attempts += 1;
    let socket: Socket;
    let outlet: Outlet;
    try {
      ({ socket, outlet } = await chooser.connect(host, port, exclude));
    } catch (error) {
      fail(errorText(error));
      return;
    }
    let answered = false;
    const out = http.request({ createConnection: () => socket, host, port, method: req.method, path: `${target.pathname}${target.search}`, headers }, (answer) => {
      answered = true;
      answer.on('data', (chunk: Buffer) => { down += chunk.length; });
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    out.on('error', (error) => {
      if (!answered && retriable && attempts < MAX_ATTEMPTS && !res.destroyed) {
        exclude.add(outlet.name);
        chooser.noteFailure(outlet, error.message);
        log.info(`${where} — «${outlet.name}» ${error.message}, повтор`);
        void attempt();
        return;
      }
      fail(`через «${outlet.name}»: ${error.message}`);
    });
    res.on('close', () => socket.destroy());
    if (retriable) out.end();
    else req.pipe(out);
  };

  res.on('close', () => consumers.account(who, up, down));
  void attempt();
}

// ─── Сервер ────────────────────────────────────────────────────────────────

export function startHttpInlet(opts: HttpInletOptions): Promise<http.Server> {
  const { chooser, consumers, log } = opts;
  const deps: Deps = { chooser, consumers, log };
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
    serveConnect(socket, head, who, target, deps);
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
    const fence = checkDestination(target.hostname.replace(/^\[|\]$/g, ''), Number(target.port) || 80);
    if (!fence.ok) {
      log.warn(`${who}: отказ ограды — ${fence.reason}`);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${fence.reason}\n`);
      return;
    }
    serveForward(req, res, who, target, deps);
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
