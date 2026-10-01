import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, parseConfig } from '../src/config.ts';

test('пустой файл — умолчания', () => {
  const c = parseConfig('');
  assert.deepEqual(c, DEFAULTS);
});

test('выход с минимумом полей получает умолчания, неизвестное поле — ошибка', () => {
  const c = parseConfig(`
outlets:
  - name: ext
    protocol: amneziawg
    bridge: 1
    conf: /etc/contour/keys/ext.conf
`);
  assert.deepEqual(c.outlets, [{ name: 'ext', kind: 'netns', bridge: 1, protocol: 'amneziawg', conf: '/etc/contour/keys/ext.conf', env: null, dns: [], mtu: null, priority: 100, enabled: true }]);
  assert.throws(() => parseConfig('outlets:\n  - name: ext\n    protocol: amneziawg\n    conf: /x\n    prioriti: 1\n'), /неизвестное поле «prioriti»/);
  assert.throws(() => parseConfig('htpp: {}\n'), /неизвестное поле «htpp»/);
});

test('имя выхода — латиница, дубли и чужой протокол — ошибка', () => {
  assert.throws(() => parseConfig('outlets:\n  - name: Выход\n    protocol: wireguard\n    conf: /x\n'), /name/);
  assert.throws(() => parseConfig('outlets:\n  - {name: a, kind: mihomo, protocol: wireguard, conf: /x}\n  - {name: a, kind: mihomo, protocol: wireguard, conf: /y}\n'), /дважды/);
  assert.throws(() => parseConfig('outlets:\n  - {name: a, kind: mihomo, protocol: openvpn, conf: /x}\n'), /protocol/);
  assert.throws(() => parseConfig('http:\n  port: 70000\n'), /http\.port/);
});

test('выход netns: номер моста обязателен и не повторяется', () => {
  assert.throws(() => parseConfig('outlets:\n  - {name: a, protocol: amneziawg, conf: /x}\n'), /bridge/);
  assert.throws(() => parseConfig('outlets:\n  - {name: a, protocol: amneziawg, conf: /x, bridge: 1}\n  - {name: b, protocol: wireguard, conf: /y, bridge: 1}\n'), /мост 1/);
  const c = parseConfig('outlets:\n  - {name: m, kind: mihomo, protocol: wireguard, conf: /x}\n');
  assert.equal(c.outlets[0]?.bridge, null);
});
