import type { Router } from 'express';
import { z } from 'zod';
import { shareLinks } from '../share/links.ts';
import { countryGroup, countryNode } from '../share/rules.ts';
import { shareWho } from '../share/store.ts';
import { fail, parse } from './respond.ts';
import type { RoutesDeps } from './routes.ts';

/**
 * Раздача в панели: адрес снаружи, устройства, ссылки для телефона.
 *
 * Список устройств — без тайн: ключ VLESS и токен правил уходят только по
 * отдельному запросу «показать подключение» (`/links`). Панель открывают по
 * http внутри дома, и опрос раз в 10 с не должен каждый раз нести ключи по Wi-Fi.
 */

const ID = z.string().regex(/^[0-9a-f]{8}$/, 'неверное устройство');
const CODE = z.string().regex(/^[A-Z]{2}$/, 'страна — две буквы');

const schemas = {
  settings: z.object({ domain: z.string().max(253) }),
  device: z.object({ name: z.string().min(1, 'нужно имя').max(40) }),
  enable: z.object({ enabled: z.boolean() }),
  site: z.object({ name: z.string().min(3).max(253), on: z.boolean() }),
};

const ZERO = { up: 0, down: 0 };

export function shareRoutes(router: Router, d: RoutesDeps): void {
  const off = (res: Parameters<typeof fail>[0]): boolean => {
    if (d.share) return false;
    fail(res, 409, 'OFF', 'раздача выключена в настройках (share.enabled)');
    return true;
  };

  router.get('/share', (_req, res) => {
    if (!d.share) { res.json({ ok: true, data: { enabled: false } }); return; }
    const { store, edge, ports } = d.share;
    const today = d.meter.todayTotals().who;
    const rates = d.meter.rates().who;
    const seen = d.meter.lastSeen();
    const devices = store.devices().map((x) => {
      const who = shareWho(x.id);
      return { id: x.id, name: x.name, enabled: x.enabled, created: x.created, today: today[who] ?? ZERO, rate: rates[who] ?? ZERO, lastSeen: seen[who] ?? null };
    });
    // Страны: чем выпускать (живой выход этой страны — прямой дома или туннель) и сколько сайтов в списке.
    const countries = d.share.rules.countries.map((code) => {
      const exit = d.share!.outlets.filter((o) => o.country === code && o.state !== 'standby').sort((a, b) => Number(b.state === 'alive') - Number(a.state === 'alive') || a.priority - b.priority)[0];
      const list = d.share!.rules.countryNames(code);
      return { code, group: countryGroup(code), node: countryNode(code), exit: exit ? { name: exit.name, direct: exit.direct, alive: exit.state === 'alive', ip: exit.externalIp } : null, common: list.common, own: list.own };
    });
    res.json({ ok: true, data: { enabled: true, running: edge.running(), domain: store.settings().domain, ports, devices, countries } });
  });

  router.post('/share/countries/:code/sites', (req, res) => {
    const code = CODE.safeParse(String(req.params.code).toUpperCase());
    const b = parse(schemas.site, req, res);
    if (!b || off(res)) return;
    if (!code.success) { fail(res, 400, 'VALIDATION', 'страна — две буквы'); return; }
    try {
      const own = d.share!.store.setCountrySite(code.data, b.name, b.on);
      d.log.info(`панель: «${b.name}» — ${b.on ? `только с адресом ${code.data}` : `снят из списка ${code.data}`}`);
      res.json({ ok: true, data: { own } });
    } catch (error) {
      fail(res, 400, 'VALIDATION', (error as Error).message);
    }
  });

  router.post('/share/settings', (req, res) => {
    const b = parse(schemas.settings, req, res);
    if (!b || off(res)) return;
    try {
      const s = d.share!.store.setDomain(b.domain);
      d.log.info(`панель: адрес раздачи — ${s.domain ?? 'снят'}`);
      res.json({ ok: true, data: { domain: s.domain } });
    } catch (error) {
      fail(res, 400, 'VALIDATION', (error as Error).message);
    }
  });

  router.post('/share/devices', (req, res) => {
    const b = parse(schemas.device, req, res);
    if (!b || off(res)) return;
    try {
      const x = d.share!.store.add(b.name);
      d.log.info(`панель: раздача — новое устройство «${x.name}»`);
      res.json({ ok: true, data: { id: x.id } });
    } catch (error) {
      fail(res, 400, 'VALIDATION', (error as Error).message);
    }
  });

  router.get('/share/devices/:id/links', (req, res) => {
    const id = ID.safeParse(req.params.id);
    if (!id.success) { fail(res, 400, 'VALIDATION', 'неверное устройство'); return; }
    if (off(res)) return;
    const { store } = d.share!;
    const x = store.devices().find((v) => v.id === id.data);
    if (!x) { fail(res, 404, 'NOT_FOUND', 'такого устройства нет'); return; }
    const links = shareLinks(x, store.settings());
    if (!links) { fail(res, 409, 'NO_DOMAIN', 'сначала задай адрес снаружи — без него телефону некуда подключаться'); return; }
    res.json({ ok: true, data: { name: x.name, ...links } });
  });

  router.post('/share/devices/:id/enable', (req, res) => {
    const id = ID.safeParse(req.params.id);
    const b = parse(schemas.enable, req, res);
    if (!b || off(res)) return;
    if (!id.success) { fail(res, 400, 'VALIDATION', 'неверное устройство'); return; }
    try {
      d.share!.store.setEnabled(id.data, b.enabled);
      d.log.info(`панель: раздача — устройство ${id.data} ${b.enabled ? 'включено' : 'выключено'}`);
      res.json({ ok: true, data: null });
    } catch (error) {
      fail(res, 404, 'NOT_FOUND', (error as Error).message);
    }
  });

  router.delete('/share/devices/:id', (req, res) => {
    const id = ID.safeParse(req.params.id);
    if (!id.success) { fail(res, 400, 'VALIDATION', 'неверное устройство'); return; }
    if (off(res)) return;
    try {
      d.share!.store.remove(id.data);
      d.log.info(`панель: раздача — устройство ${id.data} удалено`);
      res.json({ ok: true, data: null });
    } catch (error) {
      fail(res, 404, 'NOT_FOUND', (error as Error).message);
    }
  });
}
