import assert from 'node:assert/strict';
import test from 'node:test';
import { newOutlet, type Outlet } from '../src/outlets/outlet.ts';
import { Chooser } from '../src/select/chooser.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });

function outlet(name: string, priority: number, state: Outlet['state'], latencyMs: number | null = null): Outlet {
  const o = newOutlet({ name, kind: 'mihomo', bridge: null, protocol: 'wireguard', conf: '/x', env: null, dns: [], mtu: null, priority, enabled: true }, 1);
  o.state = state;
  o.latencyMs = latencyMs;
  return o;
}

const opts = { stickyMs: 3_600_000, connectTimeoutMs: 1000, onFailure: () => {}, log: quiet };

test('порядок: приоритет, при равном — задержка; мёртвые выпадают, пока есть живые', () => {
  const a = outlet('a', 10, 'alive', 120);
  const b = outlet('b', 10, 'alive', 40);
  const c = outlet('c', 20, 'alive', 5);
  const d = outlet('d', 1, 'dead');
  const u = outlet('u', 15, 'unknown');
  const chooser = new Chooser([a, b, c, d, u], opts);
  assert.deepEqual(chooser.order('x.com').map((o) => o.name), ['b', 'a', 'u', 'c']);
});

test('все мёртвые — пробуем всё равно, по приоритету', () => {
  const chooser = new Chooser([outlet('a', 10, 'dead'), outlet('b', 5, 'dead')], opts);
  assert.deepEqual(chooser.order('x.com').map((o) => o.name), ['b', 'a']);
});

test('прилипание: сайт идёт первым через свой выход, пока тот не умер и срок не вышел', () => {
  const a = outlet('a', 10, 'alive');
  const b = outlet('b', 20, 'alive');
  const chooser = new Chooser([a, b], opts);
  // Прилипание ставится при успешном соединении; здесь — напрямую в карту.
  (chooser as unknown as { sticky: Map<string, { name: string; until: number }> }).sticky.set('x.com', { name: 'b', until: Date.now() + 1000 });
  assert.deepEqual(chooser.order('x.com').map((o) => o.name), ['b', 'a']);
  assert.deepEqual(chooser.order('y.com').map((o) => o.name), ['a', 'b']);
  b.state = 'dead';
  assert.deepEqual(chooser.order('x.com').map((o) => o.name), ['a']);
  b.state = 'alive';
  assert.deepEqual(chooser.order('x.com', undefined, Date.now() + 5000).map((o) => o.name), ['a', 'b'], 'срок вышел');
  assert.equal(chooser.stickyCount(), 0);
});

test('нет выходов — соединение падает с понятной ошибкой, а не утекает', async () => {
  const chooser = new Chooser([], opts);
  await assert.rejects(chooser.connect('x.com', 443), /нет ни одного выхода/);
  const one = new Chooser([outlet('a', 1, 'alive')], opts);
  await assert.rejects(one.connect('x.com', 443, new Set(['a'])), /других выходов нет/);
});

test('страна выхода: просьба «RU» — только выходы России (и «по просьбе»); без просьбы «по просьбе» не виден; нет страны — отказ', async () => {
  const de = outlet('de', 10, 'alive');
  de.country = 'DE';
  const home = outlet('home', 1000, 'alive');
  home.country = 'RU';
  home.onRequest = true;
  const unknown = outlet('new', 5, 'alive');
  const chooser = new Chooser([de, home, unknown], opts);
  assert.deepEqual(chooser.order('gosuslugi.ru', 443, Date.now(), { country: 'RU' }).map((o) => o.name), ['home']);
  assert.deepEqual(chooser.order('instagram.com', 443).map((o) => o.name), ['new', 'de'], 'прямой «по просьбе» без просьбы не виден');
  assert.deepEqual(chooser.order('x.com', 443, Date.now(), { country: 'NL' }), []);
  await assert.rejects(chooser.connect('x.com', 443, new Set(), { country: 'NL' }), /нет выхода в стране NL/, 'не из другой страны: Госуслугам заграничный адрес хуже никакого');
});

test('прилипание — страна на весь сервис: упал свой выход — сначала другой той же страны; другие страны — за ней', async () => {
  const de1 = Object.assign(outlet('de1', 10, 'alive'), { country: 'DE' });
  const de2 = Object.assign(outlet('de2', 30, 'alive'), { country: 'DE' });
  const nl = Object.assign(outlet('nl', 1, 'alive'), { country: 'NL' });
  const opened: string[] = [];
  const chooser = new Chooser([de1, de2, nl], {
    ...opts,
    serviceOf: (h) => h.split('.').slice(-2).join('.'),
    dial: async (o) => { opened.push(o.name); if (o.name === 'nl') throw new Error('сброс'); return { destroy() {} } as never; },
  });
  // Первый раз сервис открылся через de1 (nl не смог) — сервис держится Германии.
  await chooser.connect('chatgpt.com', 443);
  assert.deepEqual(opened, ['nl', 'de1']);
  assert.deepEqual(chooser.order('cdn.chatgpt.com').map((o) => o.name), ['de1', 'de2', 'nl'], 'поддомен — тот же сервис');
  de1.state = 'dead';
  assert.deepEqual(chooser.order('chatgpt.com').map((o) => o.name), ['de2', 'nl'], 'другой выход той же страны — раньше более приоритетной чужой');
  assert.deepEqual(chooser.order('example.org').map((o) => o.name), ['nl', 'de2'], 'чужой сервис не прилип');
});

test('требования правил: только эти выходы (никогда прямой), не через страны, напрямую', () => {
  const de = Object.assign(outlet('de', 10, 'alive'), { country: 'DE' });
  const ru = Object.assign(outlet('ru', 5, 'alive'), { country: 'RU' });
  const home = Object.assign(outlet('home', 1, 'alive'), { country: 'RU', direct: true, onRequest: true });
  const chooser = new Chooser([de, ru, home], opts);
  assert.deepEqual(chooser.order('x', undefined, Date.now(), { only: ['de', 'home'] }).map((o) => o.name), ['de']);
  assert.deepEqual(chooser.order('x', undefined, Date.now(), { avoid: ['RU'] }).map((o) => o.name), ['de']);
  assert.deepEqual(chooser.order('x', undefined, Date.now(), { direct: true }).map((o) => o.name), ['home']);
  assert.deepEqual(chooser.order('x', undefined, Date.now(), { country: 'RU' }).map((o) => o.name), ['home', 'ru']);
  assert.deepEqual(chooser.order('x').map((o) => o.name), ['ru', 'de'], 'без требования прямой «по просьбе» не виден');
});
