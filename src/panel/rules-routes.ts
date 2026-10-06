import type { Router as Express } from 'express';
import { z } from 'zod';
import { formatCidr } from '../cidr.ts';
import { outletCountries, type Outlet } from '../outlets/outlet.ts';
import type { RuleBook } from '../rules/book.ts';
import type { InternalHint } from '../rules/hints.ts';
import type { RuleList, RuleLists } from '../rules/lists.ts';
import type { Router } from '../rules/need.ts';
import type { ExitNeed } from '../select/chooser.ts';
import { countryTitle } from '../share/rules.ts';
import { fail, parse } from './respond.ts';
import type { RoutesDeps } from './routes.ts';

/**
 * Правила в панели: проверка «куда пойдёт сайт», свои списки (по ссылке, файлом,
 * руками) с назначением, встроенные источники числами. Списки правит только
 * Contour — процесс DNS получает набор файлом (`rules/book.ts`).
 */

/**
 * Что нужно панели от правил; `order` — какие выходы выбор попробует для этого
 * требования; `hints` — внутренние адреса от DNS выхода, которых нет в правилах,
 * `applyHint` — дописать подсеть подсказки в её список.
 */
export type PanelRules = {
  book: RuleBook; lists: RuleLists; route: Router; order: (host: string, need: ExitNeed) => Outlet[];
  hints?: () => InternalHint[]; applyHint?: (name: string) => RuleList;
};

const ID = z.string().regex(/^[0-9a-f]{8}$/, 'неверный список');
const CODE = z.string().regex(/^[A-Z]{2}$/, 'страна — две буквы');
const NAME = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['direct', 'tunnel', 'reject']) }),
  z.object({ kind: z.literal('country'), country: CODE }),
  z.object({ kind: z.literal('avoid'), countries: z.array(CODE).min(1).max(20) }),
  z.object({ kind: z.literal('only'), outlets: z.array(NAME).min(1).max(20) }),
]);
const action = z.object({ target, fastest: z.boolean().optional() });
const format = z.enum(['auto', 'plain', 'clash', 'shadowrocket', 'v2fly', 'contour']);

const schemas = {
  add: z.object({ title: z.string().min(1).max(60), kind: z.enum(['url', 'file', 'manual']), url: z.string().max(2048).optional(), text: z.string().max(5 * 1024 * 1024).optional(), format, action }),
  hint: z.object({ name: z.string().min(1).max(253) }),
  update: z.object({ title: z.string().min(1).max(60).optional(), enabled: z.boolean().optional(), format: format.optional(), action: action.optional(), text: z.string().max(5 * 1024 * 1024).optional() }),
};

/** Сколько правил у каждого источника набора — для панели. */
function sourcesView(book: RuleBook): Array<{ source: string; layer: string; count: number }> {
  const counts = new Map<string, { source: string; layer: string; count: number }>();
  for (const { layer, source } of book.rules().entries()) {
    const k = `${layer}:${source}`;
    const c = counts.get(k) ?? { source, layer, count: 0 };
    c.count += 1;
    counts.set(k, c);
  }
  return [...counts.values()];
}

export function rulesRoutes(router: Express, d: RoutesDeps): void {
  const off = (res: Parameters<typeof fail>[0]): boolean => {
    if (d.rules) return false;
    fail(res, 409, 'OFF', 'правил нет');
    return true;
  };

  router.get('/rules', (_req, res) => {
    if (off(res)) return;
    const { book, lists } = d.rules!;
    const countries = outletCountries(d.outlets).map((code) => ({ code, title: countryTitle(code) }));
    const outlets = d.outlets.filter((o) => !o.direct).map((o) => ({ name: o.name, country: o.country }));
    res.json({ ok: true, data: { lists: lists.all(), sources: sourcesView(book), size: book.rules().size, countries, outlets, allowNets: book.rules().onlyNets().map((n) => formatCidr(n)), hints: d.rules!.hints?.() ?? [] } });
  });

  // Подсказка «добавь подсеть»: внутренний адрес от DNS выхода — в список, чьё правило взяло имя.
  router.post('/rules/hints', (req, res) => {
    const b = parse(schemas.hint, req, res);
    if (!b || off(res)) return;
    if (!d.rules!.applyHint) { fail(res, 409, 'OFF', 'подсказок нет'); return; }
    try {
      const list = d.rules!.applyHint(b.name);
      d.log.info(`панель: правила — подсеть для «${b.name}» дописана в «${list.title}»`);
      res.json({ ok: true, data: list });
    } catch (error) {
      fail(res, 400, 'VALIDATION', (error as Error).message);
    }
  });

  // Куда пойдёт сайт: какое правило его берёт и какие выходы выбор попробует.
  router.get('/rules/check', (req, res) => {
    if (off(res)) return;
    const host = String(req.query.host ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/:?#]/)[0] ?? '';
    if (!host || host.length > 253) { fail(res, 400, 'VALIDATION', 'нужно имя сайта или адрес'); return; }
    const { book, route, order } = d.rules!;
    const decision = book.rules().decide(host);
    const routed = route(host);
    const outlets = routed.reject ? [] : order(host, routed.need).slice(0, 4).map((o) => ({ name: o.name, country: o.country, direct: o.direct, state: o.state }));
    const matchText = decision ? (decision.match.kind === 'cidr' ? formatCidr(decision.match) : decision.match.name) : null;
    res.json({ ok: true, data: { host, decision: decision ? { ...decision, matchText } : null, routed, outlets } });
  });

  router.post('/rules/lists', async (req, res) => {
    const b = parse(schemas.add, req, res);
    if (!b || off(res)) return;
    try {
      const list = await d.rules!.lists.add(b);
      d.log.info(`панель: правила — список «${list.title}» (${list.kind})`);
      res.json({ ok: true, data: list });
    } catch (error) {
      fail(res, 400, 'VALIDATION', (error as Error).message);
    }
  });

  router.post('/rules/lists/:id', (req, res) => {
    const id = ID.safeParse(req.params.id);
    const b = parse(schemas.update, req, res);
    if (!b || off(res)) return;
    if (!id.success) { fail(res, 400, 'VALIDATION', 'неверный список'); return; }
    try {
      res.json({ ok: true, data: d.rules!.lists.update(id.data, b) });
    } catch (error) {
      fail(res, 400, 'VALIDATION', (error as Error).message);
    }
  });

  router.post('/rules/lists/:id/refresh', async (req, res) => {
    const id = ID.safeParse(req.params.id);
    if (!id.success) { fail(res, 400, 'VALIDATION', 'неверный список'); return; }
    if (off(res)) return;
    try {
      res.json({ ok: true, data: await d.rules!.lists.refresh(id.data) });
    } catch (error) {
      fail(res, 400, 'VALIDATION', (error as Error).message);
    }
  });

  router.get('/rules/lists/:id/text', (req, res) => {
    const id = ID.safeParse(req.params.id);
    if (!id.success) { fail(res, 400, 'VALIDATION', 'неверный список'); return; }
    if (off(res)) return;
    res.json({ ok: true, data: { text: d.rules!.lists.text(id.data) } });
  });

  router.delete('/rules/lists/:id', (req, res) => {
    const id = ID.safeParse(req.params.id);
    if (!id.success) { fail(res, 400, 'VALIDATION', 'неверный список'); return; }
    if (off(res)) return;
    try {
      d.rules!.lists.remove(id.data);
      d.log.info(`панель: правила — список ${id.data} удалён`);
      res.json({ ok: true, data: null });
    } catch (error) {
      fail(res, 404, 'NOT_FOUND', (error as Error).message);
    }
  });
}
