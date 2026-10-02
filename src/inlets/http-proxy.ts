import http from 'node:http';
import type { Socket } from 'node:net';
import type { Consumers } from '../consumers.ts';
import { errorText, type Logger } from '../log.ts';
import type { Outlet } from '../outlets/outlet.ts';
import type { Chooser, ExitNeed } from '../select/chooser.ts';
import type { Meter } from '../stats/meter.ts';
import { checkDestination } from './fence.ts';
import { MAX_ATTEMPTS, relay, type RelayDeps, type Target } from './relay.ts';

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
 *
 * Заголовок `Contour-Exit: RU` — «выпусти в этой стране» (край раздачи ставит
 * его второму серверу телефона, «Contour-RU»). Сайту он не уходит.
 */

export const EXIT_HEADER = 'contour-exit';

/** Страна из `Contour-Exit`; нет или мусор — без требования. */
export function exitNeed(value: string | string[] | undefined): ExitNeed {
  const v = (Array.isArray(value) ? value[0] : value)?.trim().toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) ? { country: v } : {};
}

export type HttpInletOptions = {
  listen: string;
  port: number;
  chooser: Chooser;
  consumers: Consumers;
  log: Logger;
  meter?: Meter;
  ports?: RelayDeps['ports'];
};

type Deps = RelayDeps;

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

// ─── CONNECT: туннель с повтором по выходам (relay.ts) ──────────────────────

function serveConnect(client: Socket, head: Buffer, who: string, target: Target, deps: Deps): void {
  relay(client, head, who, target, deps, {
    onEstablished: () => { client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: contour\r\n\r\n'); },
    onFail: (text) => refuse(client, 502, text),
  });
}

// ─── Проброс http: запрос целиком, повтор для запросов без тела ────────────

function serveForward(req: http.IncomingMessage, res: http.ServerResponse, who: string, target: URL, deps: Deps, need: ExitNeed): void {
  const { chooser, consumers, log, meter } = deps;
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
  delete headers[EXIT_HEADER];
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
      ({ socket, outlet } = await chooser.connect(host, port, exclude, need));
    } catch (error) {
      fail(errorText(error));
      return;
    }
    let answered = false;
    const out = http.request({ createConnection: () => socket, host, port, method: req.method, path: `${target.pathname}${target.search}`, headers }, (answer) => {
      answered = true;
      answer.on('data', (chunk: Buffer) => { down += chunk.length; meter?.add(who, outlet.name, host, 0, chunk.length); });
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
  const deps: Deps = { chooser, consumers, log, meter: opts.meter, ports: opts.ports };
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
    serveConnect(socket, head, who, { ...target, need: exitNeed(req.headers[EXIT_HEADER]) }, deps);
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
    serveForward(req, res, who, target, deps, exitNeed(req.headers[EXIT_HEADER]));
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
