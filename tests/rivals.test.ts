import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig, type OutletConfig } from '../src/config.ts';
import { newOutlet, type Outlet } from '../src/outlets/outlet.ts';
import { Rivals } from '../src/outlets/rivals.ts';
import { keeper } from '../src/root/groups.ts';
import { Chooser } from '../src/select/chooser.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });

function setup(running: string[]) {
  const configs: OutletConfig[] = [
    { name: 'ovpn', kind: 'netns', bridge: 2, protocol: 'openvpn', conf: '/x', env: null, dns: [], mtu: null, priority: 5, enabled: true, group: 'acc' },
    { name: 'awg', kind: 'netns', bridge: 1, protocol: 'amneziawg', conf: '/x', env: null, dns: [], mtu: null, priority: 10, enabled: true, group: 'acc' },
    { name: 'solo', kind: 'netns', bridge: 3, protocol: 'wireguard', conf: '/x', env: null, dns: [], mtu: null, priority: 50, enabled: true, group: null },
  ];
  const outlets: Outlet[] = configs.map((c) => newOutlet(c, 1));
  const asked: string[] = [];
  const up = new Set(running);
  const rivals = new Rivals(outlets, configs, {
    log: quiet,
    activate: async (name) => { asked.push(name); for (const c of configs) if (c.group === 'acc') up.delete(c.name); up.add(name); },
    isRunning: async (name) => up.has(name),
    onActivated: () => {},
    failoverMs: 15_000,
    cooldownMs: 120_000,
  });
  const by = (n: string) => outlets.find((o) => o.name === n) as Outlet;
  return { rivals, outlets, asked, by };
}

test('кому работать в группе: работающий включённый остаётся, иначе — меньший приоритет', () => {
  assert.equal(keeper([{ name: 'ovpn', priority: 5, enabled: true, running: false }, { name: 'awg', priority: 10, enabled: true, running: true }]), 'awg');
  assert.equal(keeper([{ name: 'ovpn', priority: 5, enabled: true, running: false }, { name: 'awg', priority: 10, enabled: true, running: false }]), 'ovpn');
  assert.equal(keeper([{ name: 'ovpn', priority: 5, enabled: false, running: true }, { name: 'awg', priority: 10, enabled: true, running: false }]), 'awg', 'выключенный уступает');
  assert.equal(keeper([{ name: 'ovpn', priority: 5, enabled: false, running: true }]), null);
});

test('запуск: не поднятый соперник — запасной, выбор выхода его не видит; в группе никто не работает — поднять первого', async () => {
  const a = setup(['ovpn', 'solo']);
  await a.rivals.init();
  assert.equal(a.by('awg').state, 'standby');
  assert.equal(a.by('ovpn').state, 'unknown');
  assert.deepEqual(a.asked, []);
  const chooser = new Chooser(a.outlets, { stickyMs: 0, connectTimeoutMs: 1000, onFailure: () => {}, log: quiet });
  assert.deepEqual(chooser.order('x.com', 443).map((o) => o.name), ['ovpn', 'solo']);
  a.by('ovpn').state = 'dead';
  a.by('solo').state = 'dead';
  assert.deepEqual(chooser.order('x.com', 443).map((o) => o.name), ['ovpn', 'solo'], 'все мертвы — запасной всё равно не годится');

  const b = setup([]);
  await b.rivals.init();
  assert.deepEqual(b.asked, ['ovpn']);
  assert.equal(b.by('ovpn').state, 'unknown');
  assert.equal(b.by('awg').state, 'standby');
});

test('работающий не отвечает 15 с — поднять запасного; потом пауза, назад сам не возвращается', async () => {
  const a = setup(['ovpn']);
  await a.rivals.init();
  const t0 = Date.now() + 1_000_000; // далеко за любой прошлой паузой
  a.by('ovpn').state = 'dead';
  a.rivals.tick(t0);
  a.rivals.tick(t0 + 10_000);
  assert.deepEqual(a.asked, [], 'мёртв меньше 15 с — ждём: проверка могла моргнуть');
  a.rivals.tick(t0 + 16_000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.asked, ['awg']);
  assert.equal(a.by('ovpn').state, 'standby');
  assert.equal(a.by('awg').state, 'unknown');

  a.by('awg').state = 'dead';
  a.rivals.tick(t0 + 20_000);
  a.rivals.tick(t0 + 40_000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.asked, ['awg'], 'пауза после переключения');
  a.by('awg').state = 'alive';
  a.rivals.tick(t0 + 10_000_000);
  assert.deepEqual(a.asked, ['awg'], 'живой запасной остаётся — назад к основному сам не идём');
});

test('вручную: поднять запасного можно, работающего — нет', async () => {
  const a = setup(['ovpn']);
  await a.rivals.init();
  await assert.rejects(a.rivals.manual('ovpn'), /уже работает/);
  await assert.rejects(a.rivals.manual('solo'), /не в группе/);
  await a.rivals.manual('awg');
  assert.deepEqual(a.asked, ['awg']);
  assert.equal(a.by('ovpn').state, 'standby');
  assert.deepEqual(a.rivals.rivalsOf('awg'), { group: 'acc', rivals: ['ovpn'] });
});

test('настройки: группа — у ядерных выходов, имя — латиницей', () => {
  const c = parseConfig('outlets:\n  - {name: a, protocol: amneziawg, conf: /x, bridge: 1, group: acc}\n  - {name: b, protocol: openvpn, conf: /y, bridge: 2, group: acc}\n');
  assert.deepEqual(c.outlets.map((o) => o.group), ['acc', 'acc']);
  assert.throws(() => parseConfig('outlets:\n  - {name: m, kind: mihomo, protocol: link, conf: /x, group: acc}\n'), /только у ядерных/);
  assert.throws(() => parseConfig('outlets:\n  - {name: a, protocol: amneziawg, conf: /x, bridge: 1, group: Аккаунт}\n'), /group/);
});
