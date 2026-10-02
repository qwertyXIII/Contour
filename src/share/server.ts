import http from 'node:http';
import type { Logger } from '../log.ts';
import type { ShareRules } from './rules.ts';
import { domainSetText, shadowrocketConf } from './rules.ts';
import type { ShareStore } from './store.ts';

/**
 * Правила раздачи по ссылке — отдельный маленький сервер на `127.0.0.1`, не
 * панель: снаружи nginx отдаёт сюда только `/list/`, и всё, что здесь есть, —
 * два файла по токену устройства. Панель с паролем наружу не выходит.
 *
 * `/list/<токен>/contour.conf` — конфиг Shadowrocket, `/list/<токен>/domains.list` —
 * список сайтов к нему, `/list/<токен>/country-ru.list` — сайты «только с
 * российским адресом». Чужой токен, выключенное устройство, адрес не задан —
 * один и тот же 404: по ответу не понять, есть ли такой токен.
 */

const ROUTE = /^\/list\/([A-Za-z0-9_-]{16,64})\/(contour\.conf|domains\.list|country-([a-z]{2})\.list)$/;

export type ShareServerOptions = { listen: string; port: number; store: ShareStore; rules: ShareRules; log: Logger };

function send(res: http.ServerResponse, status: number, body: string, head: boolean): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(head ? undefined : body);
}

/** Тело ответа по пути, либо null — «не найдено». */
export function answer(url: string, opts: Pick<ShareServerOptions, 'store' | 'rules'>): { body: string; device: string; file: string } | null {
  const m = ROUTE.exec(url.split('?')[0] ?? '');
  if (!m) return null;
  const device = opts.store.byList(m[1] as string);
  const domain = opts.store.settings().domain;
  if (!device || !domain) return null;
  if (m[2] === 'domains.list') return { body: domainSetText(opts.rules.domains().tunnel), device: device.name, file: 'список сайтов' };
  if (m[3]) {
    const code = m[3].toUpperCase();
    if (!opts.rules.countries.includes(code)) return null;
    return { body: domainSetText(opts.rules.countryNames(code).names, `сайты только с адресом ${code}`), device: device.name, file: `список ${code}` };
  }
  const base = `https://${domain}/list/${device.list}`;
  const body = shadowrocketConf({ base, device: device.name, direct: opts.rules.domains().direct, nets: opts.rules.nets(), countries: opts.rules.countries });
  return { body, device: device.name, file: 'конфиг' };
}

export function startShareServer(opts: ShareServerOptions): http.Server {
  const server = http.createServer((req, res) => {
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) { send(res, 405, 'только GET\n', false); return; }
    const a = answer(req.url ?? '', opts);
    if (!a) { send(res, 404, 'не найдено\n', head); return; }
    opts.log.info(`раздача: «${a.device}» забрал ${a.file}`);
    send(res, 200, a.body, head);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.listen(opts.port, opts.listen, () => opts.log.info(`правила раздачи слушают ${opts.listen}:${opts.port}`));
  server.on('error', (e) => opts.log.error(`правила раздачи не открылись на ${opts.listen}:${opts.port}: ${e.message}`));
  return server;
}
