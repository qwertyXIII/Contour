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
    conf: /etc/contour/keys/ext.conf
`);
  assert.deepEqual(c.outlets, [{ name: 'ext', kind: 'mihomo', protocol: 'amneziawg', conf: '/etc/contour/keys/ext.conf', env: null, priority: 100, enabled: true }]);
  assert.throws(() => parseConfig('outlets:\n  - name: ext\n    protocol: amneziawg\n    conf: /x\n    prioriti: 1\n'), /неизвестное поле «prioriti»/);
  assert.throws(() => parseConfig('htpp: {}\n'), /неизвестное поле «htpp»/);
});

test('имя выхода — латиница, дубли и чужой протокол — ошибка', () => {
  assert.throws(() => parseConfig('outlets:\n  - name: Выход\n    protocol: wireguard\n    conf: /x\n'), /name/);
  assert.throws(() => parseConfig('outlets:\n  - {name: a, protocol: wireguard, conf: /x}\n  - {name: a, protocol: wireguard, conf: /y}\n'), /дважды/);
  assert.throws(() => parseConfig('outlets:\n  - {name: a, protocol: openvpn, conf: /x}\n'), /protocol/);
  assert.throws(() => parseConfig('http:\n  port: 70000\n'), /http\.port/);
});
