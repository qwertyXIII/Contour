import type { Router } from 'express';
import { z } from 'zod';
import { shareLinks } from '../share/links.ts';
import type { Share } from '../share/index.ts';
import { countryGroup, countryNode, countryTitle } from '../share/rules.ts';
import { deviceCountries, shareWho } from '../share/store.ts';
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
  country: z.object({ on: z.boolean() }),
  site: z.object({ name: z.string().min(3).max(253), on: z.boolean() }),
};

const ZERO = { up: 0, down: 0 };

/**
 * Страны для панели: где есть выход, и те, что уже открыты телефонам (выход
 * пропал — страну всё равно видно, и её можно закрыть). У каждой — чем
 * выпускать (живой выход этой страны: прямой или туннель) и сколько сайтов в
 * её списке.
 */
function countriesView(share: Share): unknown[] {
  const devices = share.store.devices().map((x) => ({ name: x.name, countries: deviceCountries(x, share.allowed) }));
  const codes = [...new Set([...share.countries(), ...devices.flatMap((x) => x.countries)])].sort();
  return codes.map((code) => {
    const exit = share.outlets.filter((o) => o.country === code && o.state !== 'standby')
      .sort((a, b) => Number(b.state === 'alive') - Number(a.state === 'alive') || a.priority - b.priority)[0];
    const list = share.rules.countryNames(code);
    return {
      code, title: countryTitle(code), group: countryGroup(code), node: countryNode(code),
      exit: exit ? { name: exit.name, direct: exit.direct, alive: exit.state === 'alive', ip: exit.externalIp } : null,
      phones: devices.filter((x) => x.countries.includes(code)).map((x) => x.name), common: list.common, own: list.own,
    };
  });
}

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
      return {
        id: x.id, name: x.name, enabled: x.enabled, created: x.created, countries: deviceCountries(x, d.share!.allowed), trace: Boolean(x.trace),
        today: today[who] ?? ZERO, rate: rates[who] ?? ZERO, lastSeen: seen[who] ?? null,
      };
    });
    res.json({ ok: true, data: { enabled: true, running: edge.running(), domain: store.settings().domain, ports, devices, countries: countriesView(d.share) } });
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
    const links = shareLinks(x, store.settings(), d.share!.allowed);
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

  // Запись сайтов телефона для разбора (share/trace.ts): 3 дня, в папке журналов.
  router.post('/share/devices/:id/trace', (req, res) => {
    const id = ID.safeParse(req.params.id);
    const b = parse(schemas.country, req, res);
    if (!b || off(res)) return;
    if (!id.success) { fail(res, 400, 'VALIDATION', 'неверное устройство'); return; }
    try {
      d.share!.store.setTrace(id.data, b.on);
      d.log.info(`панель: раздача — устройство ${id.data}: запись сайтов ${b.on ? 'включена' : 'выключена'}`);
      res.json({ ok: true, data: null });
    } catch (error) {
      fail(res, 404, 'NOT_FOUND', (error as Error).message);
    }
  });

  // Открыть телефону страну можно, только где есть выход; закрыть — любую.
  router.post('/share/devices/:id/countries/:code', (req, res) => {
    const id = ID.safeParse(req.params.id);
    const code = CODE.safeParse(String(req.params.code).toUpperCase());
    const b = parse(schemas.country, req, res);
    if (!b || off(res)) return;
    if (!id.success || !code.success) { fail(res, 400, 'VALIDATION', 'неверное устройство или страна'); return; }
    if (b.on && !d.share!.countries().includes(code.data)) { fail(res, 409, 'NO_EXIT', `выхода в стране ${countryTitle(code.data)} нет — открыть её некуда`); return; }
    try {
      const x = d.share!.store.setCountry(id.data, code.data, b.on);
      d.log.info(`панель: раздача — «${x.name}» ${b.on ? 'открыта' : 'закрыта'} страна ${code.data}`);
      res.json({ ok: true, data: { countries: deviceCountries(x, d.share!.allowed) } });
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
