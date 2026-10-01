import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import type { Dial } from '../outlets/connect.ts';
import type { Outlet } from '../outlets/outlet.ts';
import { portsView, type PortProbe } from '../outlets/ports.ts';
import type { Rivals } from '../outlets/rivals.ts';
import { rootCall } from '../root/protocol.ts';
import type { Share } from '../share/index.ts';
import type { Meter } from '../stats/meter.ts';
import { requireAuth, sessionOf, type Auth } from './auth.ts';
import type { Devices } from './devices.ts';
import type { Sites } from './sites.ts';
import { speedTest, type SpeedResult } from './speedtest.ts';
import { fail, parse } from './respond.ts';
import { shareRoutes } from './share-routes.ts';
import type { PanelState } from './state.ts';

/**
 * API панели: `{ ok, data }` или `{ ok: false, error: { code, message } }`.
 * Вход каждого изменяющего запроса проверяется схемой zod до дела.
 */

export type RoutesDeps = {
  auth: Auth;
  state: PanelState;
  meter: Meter;
  devices: Devices;
  sites: Sites;
  outlets: Outlet[];
  dial: Dial;
  speeds: Map<string, SpeedResult>;
  ports: PortProbe;
  rivals: Rivals;
  /** Раздача; null — выключена в настройках. */
  share: Share | null;
  log: Logger;
};

const NAME = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'имя: латиница в нижнем регистре, цифры, «-», «_»');

const schemas = {
  login: z.object({ password: z.string().min(1).max(200) }),
  device: z.object({ name: z.string().max(40) }),
  site: z.object({ name: z.string().min(3).max(253), via: z.enum(['tunnel', 'direct', 'auto']) }),
  speed: z.object({ outlet: NAME }),
  ports: z.object({ outlet: NAME }),
  gateway: z.object({ mode: z.enum(['blocked', 'all']).nullable() }),
  group: z.object({ with: NAME.nullable() }),
  add: z.object({
    name: NAME,
    source: z.enum(['conf', 'link', 'subscription', 'ovpn']),
    text: z.string().min(1).max(200_000),
    priority: z.number().int().min(0).max(10_000).optional(),
    // Логин и пароль OpenVPN — дальше помощнику от root, в журналы не пишутся.
    auth: z.object({ user: z.string().min(1).max(256), pass: z.string().min(1).max(256) }).optional(),
  }),
  enable: z.object({ enabled: z.boolean() }),
  priority: z.object({ priority: z.number().int().min(0).max(10_000) }),
};

function authRoutes(router: Router, d: RoutesDeps): void {
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { ok: false, error: { code: 'RATE', message: 'слишком много попыток — подожди 15 минут' } } });
  router.get('/me', (req, res) => {
    res.json({ ok: true, data: { authed: d.auth.valid(sessionOf(req)), configured: d.auth.configured() } });
  });
  router.post('/login', limiter, async (req, res) => {
    const body = parse(schemas.login, req, res);
    if (!body) return;
    if (!(await d.auth.check(body.password))) {
      d.log.warn(`панель: неверный пароль с ${req.ip}`);
      fail(res, 401, 'AUTH', 'неверный пароль');
      return;
    }
    res.setHeader('Set-Cookie', d.auth.cookie(d.auth.open()));
    d.log.info(`панель: вход с ${req.ip}`);
    res.json({ ok: true });
  });
  router.post('/logout', (req, res) => {
    d.auth.close(sessionOf(req));
    res.setHeader('Set-Cookie', 'contour_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.json({ ok: true });
  });
}

function viewRoutes(router: Router, d: RoutesDeps): void {
  router.get('/state', async (_req, res) => { res.json({ ok: true, data: await d.state.overview() }); });
  router.get('/history', (_req, res) => { res.json({ ok: true, data: d.meter.points() }); });
  router.get('/journal', (_req, res) => { res.json({ ok: true, data: d.state.journal() }); });
  router.get('/sites', (_req, res) => {
    res.json({ ok: true, data: { ...d.sites.summary(), top: d.meter.topHosts(60) } });
  });
}

function actionRoutes(router: Router, d: RoutesDeps): void {
  router.post('/devices/:mac', (req, res) => {
    const body = parse(schemas.device, req, res);
    if (!body) return;
    try {
      d.devices.rename(String(req.params.mac), body.name);
      res.json({ ok: true });
    } catch (error) {
      fail(res, 400, 'VALIDATION', (error as Error).message);
    }
  });
  // Режим шлюза — у помощника от root: правила ядра и файл режимов только его.
  router.post('/devices/:mac/gateway', async (req, res) => {
    const body = parse(schemas.gateway, req, res);
    if (!body) return;
    const mac = String(req.params.mac).toLowerCase();
    try {
      await rootCall({ cmd: 'gateway.set', mac, mode: body.mode }, 30_000);
      d.log.info(`панель: шлюз для ${mac} — ${body.mode === 'blocked' ? 'только заблокированное' : body.mode === 'all' ? 'всё через VPN' : 'выключен'}`);
      res.json({ ok: true });
    } catch (error) {
      fail(res, 400, 'ROOT', (error as Error).message);
    }
  });
  router.post('/sites', (req, res) => {
    const body = parse(schemas.site, req, res);
    if (!body) return;
    try {
      res.json({ ok: true, data: d.sites.set(body.name, body.via) });
      d.log.info(`панель: «${body.name}» — ${body.via === 'tunnel' ? 'всегда через VPN' : body.via === 'direct' ? 'никогда через VPN' : 'решает автоматика'}`);
    } catch (error) {
      fail(res, 400, 'VALIDATION', (error as Error).message);
    }
  });
  router.post('/speedtest', async (req, res) => {
    const body = parse(schemas.speed, req, res);
    if (!body) return;
    const outlet = d.outlets.find((o) => o.name === body.outlet);
    if (!outlet) { fail(res, 404, 'NOT_FOUND', 'такого выхода нет или он выключен'); return; }
    try {
      const r = await speedTest(outlet, d.dial);
      d.speeds.set(outlet.name, r);
      d.log.info(`замер «${outlet.name}»: ${r.mbps} Мбит/с`);
      res.json({ ok: true, data: r });
    } catch (error) {
      fail(res, 502, 'SPEEDTEST', (error as Error).message);
    }
  });
  router.post('/ports', async (req, res) => {
    const body = parse(schemas.ports, req, res);
    if (!body) return;
    const outlet = d.outlets.find((o) => o.name === body.outlet);
    if (!outlet) { fail(res, 404, 'NOT_FOUND', 'такого выхода нет или он выключен'); return; }
    const r = await d.ports.run(outlet);
    if (!r) { fail(res, 502, 'PORTS', 'не проверить: проверочный сервер не отвечает через выход даже на 80 и 443 (или проверка уже идёт)'); return; }
    res.json({ ok: true, data: { ...portsView(r), summary: d.ports.summary(outlet) } });
  });
}

/** Выходы — через помощника от root. Ответ ошибки — его словами. */
function outletRoutes(router: Router, d: RoutesDeps): void {
  const call = async (res: Response, req: Parameters<typeof rootCall>[0]): Promise<void> => {
    try {
      res.json({ ok: true, data: await rootCall(req) });
      await d.state.rootStatus(true).catch(() => undefined);
    } catch (error) {
      fail(res, 400, 'ROOT', (error as Error).message);
    }
  };
  router.post('/outlets', async (req, res) => {
    const b = parse(schemas.add, req, res);
    if (b) await call(res, { cmd: 'outlet.add', name: b.name, source: b.source, text: b.text, priority: b.priority, auth: b.auth });
  });
  router.delete('/outlets/:name', async (req, res) => {
    const n = NAME.safeParse(req.params.name);
    if (!n.success) { fail(res, 400, 'VALIDATION', 'неверное имя'); return; }
    await call(res, { cmd: 'outlet.remove', name: n.data });
  });
  router.post('/outlets/:name/restart', async (req, res) => {
    const n = NAME.safeParse(req.params.name);
    if (!n.success) { fail(res, 400, 'VALIDATION', 'неверное имя'); return; }
    await call(res, { cmd: 'outlet.restart', name: n.data });
  });
  router.post('/outlets/:name/enable', async (req, res) => {
    const n = NAME.safeParse(req.params.name);
    const b = parse(schemas.enable, req, res);
    if (!b) return;
    if (!n.success) { fail(res, 400, 'VALIDATION', 'неверное имя'); return; }
    await call(res, { cmd: 'outlet.enable', name: n.data, enabled: b.enabled });
  });
  router.post('/outlets/:name/priority', async (req, res) => {
    const n = NAME.safeParse(req.params.name);
    const b = parse(schemas.priority, req, res);
    if (!b) return;
    if (!n.success) { fail(res, 400, 'VALIDATION', 'неверное имя'); return; }
    await call(res, { cmd: 'outlet.priority', name: n.data, priority: b.priority });
  });
  router.post('/outlets/:name/group', async (req, res) => {
    const n = NAME.safeParse(req.params.name);
    const b = parse(schemas.group, req, res);
    if (!b) return;
    if (!n.success) { fail(res, 400, 'VALIDATION', 'неверное имя'); return; }
    await call(res, { cmd: 'outlet.group', name: n.data, with: b.with });
  });
  // Поднять запасного вместо работающего — через Contour, не прямо помощнику: состояние выходов знает он.
  router.post('/outlets/:name/activate', async (req, res) => {
    const n = NAME.safeParse(req.params.name);
    if (!n.success) { fail(res, 400, 'VALIDATION', 'неверное имя'); return; }
    try {
      await d.rivals.manual(n.data);
      d.log.info(`панель: «${n.data}» — основной в своей группе`);
      res.json({ ok: true, data: null });
      await d.state.rootStatus(true).catch(() => undefined);
    } catch (error) {
      fail(res, 400, 'ROOT', (error as Error).message);
    }
  });
  router.post('/restart', async (_req, res) => { await call(res, { cmd: 'contour.restart' }); });
}

export function apiRouter(d: RoutesDeps): Router {
  const router = Router();
  authRoutes(router, d);
  router.use(requireAuth(d.auth));
  viewRoutes(router, d);
  actionRoutes(router, d);
  outletRoutes(router, d);
  shareRoutes(router, d);
  return router;
}
