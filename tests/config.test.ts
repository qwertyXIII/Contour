import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS, parseConfig } from '../src/config.ts';
import { prepareOutlets } from '../src/outlets/outlet.ts';

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
  assert.deepEqual(c.outlets, [{ name: 'ext', kind: 'netns', bridge: 1, protocol: 'amneziawg', conf: '/etc/contour/keys/ext.conf', env: null, dns: [], mtu: null, priority: 100, enabled: true, group: null, country: null }]);
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

test('прямой выход: по умолчанию есть и только по просьбе; страна — две буквы; имя не занято выходом', () => {
  assert.deepEqual(parseConfig('outlets: []').direct, { enabled: true, name: 'home', priority: 1000, onRequest: true, country: null });
  assert.equal(parseConfig('direct: {country: ru}').direct.country, 'RU');
  assert.equal(parseConfig('outlets:\n  - {name: nl, protocol: wireguard, bridge: 3, conf: /x, country: nl}\n').outlets[0]?.country, 'NL');
  assert.throws(() => parseConfig('direct: {country: Russia}'), /две латинские буквы/);
  assert.throws(() => parseConfig('outlets:\n  - {name: home, protocol: wireguard, bridge: 3, conf: /x}\n'), /уже имя выхода/);
  assert.deepEqual(parseConfig('share: {countries: [ru, RU, nl]}').share.countries, ['RU', 'NL']);
});

test('прямой выход: туннелей нет — он основной; есть — только по просьбе страны', () => {
  const alone = prepareOutlets(parseConfig('direct: {country: nl}'));
  assert.deepEqual(alone.outlets.map((o) => [o.name, o.direct, o.onRequest]), [['home', true, false]], 'сервер друга без VPN-выходов: иначе соединению некуда идти');
  const link = path.join(mkdtempSync(path.join(tmpdir(), 'contour-cfg-')), 'link');
  writeFileSync(link, 'vless://11111111-2222-4333-8444-555555555555@nl.example.org:443?security=tls&type=ws&path=%2Fs#nl\n');
  const both = prepareOutlets(parseConfig(`outlets:\n  - {name: nl, kind: mihomo, protocol: link, conf: ${link}}\n`));
  assert.deepEqual(both.outlets.map((o) => [o.name, o.onRequest]), [['home', true], ['nl', false]], 'прямой — первым, как раньше');
});
