import assert from 'node:assert/strict';
import test from 'node:test';
import { newOutlet, type Outlet } from '../src/outlets/outlet.ts';
import { Chooser } from '../src/select/chooser.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });

function outlet(name: string, priority: number, state: Outlet['state'], latencyMs: number | null = null): Outlet {
  const o = newOutlet({ name, kind: 'mihomo', protocol: 'wireguard', conf: '/x', env: null, priority, enabled: true }, 1);
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
  assert.deepEqual(chooser.order('x.com', Date.now() + 5000).map((o) => o.name), ['a', 'b'], 'срок вышел');
  assert.equal(chooser.stickyCount(), 0);
});

test('нет выходов — соединение падает с понятной ошибкой, а не утекает', async () => {
  const chooser = new Chooser([], opts);
  await assert.rejects(chooser.connect('x.com', 443), /нет ни одного выхода/);
});
