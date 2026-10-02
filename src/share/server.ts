import http from 'node:http';
import type { Logger } from '../log.ts';
import type { RuleSet } from '../rules/engine.ts';
import { shareServers, SUBSCRIPTION_NAME, subscriptionBody } from './links.ts';
import { phonePlan } from './plan.ts';
import { domainSetText, shadowrocketConf } from './rules.ts';
import { deviceCountries, type ShareStore } from './store.ts';

/**
 * Правила раздачи по ссылке — отдельный маленький сервер на `127.0.0.1`, не
 * панель: снаружи nginx отдаёт сюда только `/list/`, и всё, что здесь есть, —
 * два файла по токену устройства. Панель с паролем наружу не выходит.
 *
 * `/list/<токен>/servers` — подписка (серверы телефона), `/list/<токен>/contour.conf` —
 * конфиг Shadowrocket, к нему наборы: `domains.list` — через Contour,
 * `direct.list` — напрямую, `reject.list` — отказ, `country-xx.list` — в группу
 * страны (страна должна быть открыта телефону). Чужой токен, выключенное устройство, адрес не
 * задан — один и тот же 404: по ответу не понять, есть ли такой токен.
 */

const ROUTE = /^\/list\/([A-Za-z0-9_-]{16,64})\/(servers|contour\.conf|domains\.list|direct\.list|reject\.list|country-([a-z]{2})\.list)$/;
/** Как часто клиенту перечитывать подписку, часов (заголовок клиентов Clash и v2ray; Shadowrocket — своя настройка). */
const SUBSCRIPTION_HOURS = 12;

/** `allowed` — `share.countries`: какие страны раздавать (null — все); `rules` — набор правил движка, текущий. */
export type ShareServerOptions = { listen: string; port: number; store: ShareStore; rules: () => RuleSet; allowed: readonly string[] | null; log: Logger };
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
    const title = `base64:${Buffer.from(SUBSCRIPTION_NAME).toString('base64')}`;
    return { body: subscriptionBody(servers), device: device.name, file: 'подписку', headers: { 'profile-title': title, 'profile-update-interval': String(SUBSCRIPTION_HOURS) } };
  }
  const plan = phonePlan(opts.rules(), countries);
  const file = (names: string[], what: string, title: string): Answer => ({ body: domainSetText(names, what), device: device.name, file: title });
  if (m[2] === 'domains.list') return file(plan.tunnel, 'сайты через VPN', 'список сайтов');
  if (m[2] === 'direct.list') return file(plan.direct, 'сайты напрямую', 'список «напрямую»');
  if (m[2] === 'reject.list') return file(plan.reject, 'отказ', 'список отказов');
  if (m[3]) {
    const code = m[3].toUpperCase();
    if (!countries.includes(code)) return null;
    return file(plan.country[code] ?? [], `сайты только с адресом ${code}`, `список ${code}`);
  }
  const base = `https://${settings.domain}/list/${device.list}`;
  return { body: shadowrocketConf({ base, device: device.name, plan, countries }), device: device.name, file: 'конфиг' };
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
