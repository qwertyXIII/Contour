import http from 'node:http';
import type { Logger } from '../log.ts';
import { shareServers, subscriptionBody } from './links.ts';
import type { ShareRules } from './rules.ts';
import { domainSetText, SHARE_NODE, shadowrocketConf } from './rules.ts';
import { deviceCountries, type ShareStore } from './store.ts';

/**
 * Правила раздачи по ссылке — отдельный маленький сервер на `127.0.0.1`, не
 * панель: снаружи nginx отдаёт сюда только `/list/`, и всё, что здесь есть, —
 * два файла по токену устройства. Панель с паролем наружу не выходит.
 *
 * `/list/<токен>/servers` — подписка (серверы телефона), `/list/<токен>/contour.conf` —
 * конфиг Shadowrocket, `/list/<токен>/domains.list` — список сайтов к нему,
 * `/list/<токен>/country-xx.list` — сайты «только с адресом страны» (страна
 * должна быть открыта телефону). Чужой токен, выключенное устройство, адрес не
 * задан — один и тот же 404: по ответу не понять, есть ли такой токен.
 */

const ROUTE = /^\/list\/([A-Za-z0-9_-]{16,64})\/(servers|contour\.conf|domains\.list|country-([a-z]{2})\.list)$/;
/** Как часто клиенту перечитывать подписку, часов (заголовок клиентов Clash и v2ray; Shadowrocket — своя настройка). */
const SUBSCRIPTION_HOURS = 12;

/** `allowed` — `share.countries`: какие страны раздавать (null — все). */
export type ShareServerOptions = { listen: string; port: number; store: ShareStore; rules: ShareRules; allowed: readonly string[] | null; log: Logger };
type Answer = { body: string; device: string; file: string; headers?: Record<string, string> };

function send(res: http.ServerResponse, status: number, a: Pick<Answer, 'body' | 'headers'>, head: boolean): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(a.body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...a.headers,
  });
  res.end(head ? undefined : a.body);
}

/** Тело ответа по пути, либо null — «не найдено». */
export function answer(url: string, opts: Pick<ShareServerOptions, 'store' | 'rules' | 'allowed'>): Answer | null {
  const m = ROUTE.exec(url.split('?')[0] ?? '');
  if (!m) return null;
  const device = opts.store.byList(m[1] as string);
  const settings = opts.store.settings();
  if (!device || !settings.domain) return null;
  const countries = deviceCountries(device, opts.allowed);
  if (m[2] === 'servers') {
    const servers = shareServers(device, settings, opts.allowed) ?? [];
    const title = `base64:${Buffer.from(SHARE_NODE).toString('base64')}`;
    return { body: subscriptionBody(servers), device: device.name, file: 'подписку', headers: { 'profile-title': title, 'profile-update-interval': String(SUBSCRIPTION_HOURS) } };
  }
  if (m[2] === 'domains.list') return { body: domainSetText(opts.rules.domains().tunnel), device: device.name, file: 'список сайтов' };
  if (m[3]) {
    const code = m[3].toUpperCase();
    if (!countries.includes(code)) return null;
    return { body: domainSetText(opts.rules.countryNames(code).names, `сайты только с адресом ${code}`), device: device.name, file: `список ${code}` };
  }
  const base = `https://${settings.domain}/list/${device.list}`;
  const sites = countries.map((code) => ({ code, sites: opts.rules.countryNames(code).names.length }));
  const body = shadowrocketConf({ base, device: device.name, direct: opts.rules.domains().direct, nets: opts.rules.nets(), countries: sites });
  return { body, device: device.name, file: 'конфиг' };
}

export function startShareServer(opts: ShareServerOptions): http.Server {
  const server = http.createServer((req, res) => {
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) { send(res, 405, { body: 'только GET\n' }, false); return; }
    const a = answer(req.url ?? '', opts);
    if (!a) { send(res, 404, { body: 'не найдено\n' }, head); return; }
    opts.log.info(`раздача: «${a.device}» забрал ${a.file}`);
    send(res, 200, a, head);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.listen(opts.port, opts.listen, () => opts.log.info(`правила раздачи слушают ${opts.listen}:${opts.port}`));
  server.on('error', (e) => opts.log.error(`правила раздачи не открылись на ${opts.listen}:${opts.port}: ${e.message}`));
  return server;
}
