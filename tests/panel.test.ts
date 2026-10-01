import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Overrides, writeOverride } from '../src/dns/overrides.ts';
import { describeLink, parseLink } from '../src/outlets/links.ts';
import { Auth, hashPassword } from '../src/panel/auth.ts';
import { readArp } from '../src/panel/devices.ts';
import { addOutlet, freeBridge, readOutlets, removeOutlet, setOutletField } from '../src/root/config-edit.ts';
import { checkOvpn } from '../src/root/ovpn-check.ts';
import { Meter } from '../src/stats/meter.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });
const tmp = (): string => mkdtempSync(path.join(tmpdir(), 'contour-'));

test('ссылки: vless + reality, vmess, trojan, ss (оба вида), hysteria2', () => {
  const v = parseLink('vless://11111111-2222-3333-4444-555555555555@nl.example.org:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=PUBKEY&sid=ab12&type=tcp&flow=xtls-rprx-vision#NL');
  assert.equal(v.type, 'vless');
  assert.equal(v.server, 'nl.example.org');
  assert.equal(v.port, 443);
  assert.equal(v.flow, 'xtls-rprx-vision');
  assert.deepEqual(v['reality-opts'], { 'public-key': 'PUBKEY', 'short-id': 'ab12' });
  assert.equal(v.servername, 'www.microsoft.com');
  assert.match(describeLink(v), /VLESS, nl\.example\.org:443, Reality/);
  assert.doesNotMatch(describeLink(v), /11111111/);

  const vm = parseLink(`vmess://${Buffer.from(JSON.stringify({ v: '2', add: 'de.example.org', port: '8443', id: 'uuid-1', aid: '0', net: 'ws', path: '/ws', host: 'cdn.example.org', tls: 'tls' })).toString('base64')}`);
  assert.equal(vm.type, 'vmess');
  assert.equal(vm.port, 8443);
  assert.deepEqual(vm['ws-opts'], { path: '/ws', headers: { Host: 'cdn.example.org' } });
  assert.equal(vm.tls, true);

  const t = parseLink('trojan://secret@tr.example.org:443?sni=tr.example.org&type=grpc&serviceName=svc#x');
  assert.equal(t.password, 'secret');
  assert.deepEqual(t['grpc-opts'], { 'grpc-service-name': 'svc' });

  const ss1 = parseLink(`ss://${Buffer.from('aes-256-gcm:pw').toString('base64')}@ss.example.org:8388#a`);
  const ss2 = parseLink(`ss://${Buffer.from('chacha20-ietf-poly1305:pw2@1.2.3.4:443').toString('base64')}#b`);
  assert.deepEqual([ss1.cipher, ss1.password, ss1.server, ss1.port], ['aes-256-gcm', 'pw', 'ss.example.org', 8388]);
  assert.deepEqual([ss2.cipher, ss2.password, ss2.server, ss2.port], ['chacha20-ietf-poly1305', 'pw2', '1.2.3.4', 443]);

  const hy = parseLink('hysteria2://pass@hy.example.org:4443?sni=hy.example.org&insecure=1&obfs=salamander&obfs-password=o');
  assert.deepEqual([hy.type, hy.password, hy['skip-cert-verify'], hy.obfs], ['hysteria2', 'pass', true, 'salamander']);

  assert.throws(() => parseLink('vless://@x:1'), /uuid/);
  assert.throws(() => parseLink('vless://u@x:443?security=reality'), /pbk/);
  assert.throws(() => parseLink('wireguard://x'), /не поддерживается/);
});

test('.ovpn: обычный клиент проходит, скрипты и файлы — нет', () => {
  const ok = 'client\ndev tun\nproto udp\nremote vpn.example.org 1194\nredirect-gateway def1\n<ca>\nup this-is-inside-a-block\n</ca>\n';
  assert.equal(checkOvpn(ok), 'OpenVPN, vpn.example.org:1194');
  assert.throws(() => checkOvpn('client\nremote a 1\nup /tmp/x.sh\n'), /«up»/);
  assert.throws(() => checkOvpn('client\nremote a 1\nplugin /x.so\n'), /«plugin»/);
  assert.throws(() => checkOvpn('client\nremote a 1\nlog /etc/passwd\n'), /«log»/);
  assert.throws(() => checkOvpn('client\nremote a 1\nauth-user-pass\n'), /логин/);
  assert.throws(() => checkOvpn('client\ndev tun\n'), /remote/);
  assert.throws(() => checkOvpn('client\nremote a 1\n<ca>\nxx\n'), /не закрыт/);
});

test('.ovpn с логином: голая auth-user-pass — с полями логина, путь к файлу — никогда', () => {
  // Как у профиля провайдера: Windows-директивы, протокол tcp-client, порт в строке remote.
  const text = 'client\ndev tun\nproto tcp-client\nremote vpn.example.org 443\nroute-method exe\nauth-user-pass\n<ca>\nx\n</ca>\n';
  assert.throws(() => checkOvpn(text), /впиши их в поля/);
  assert.equal(checkOvpn(text, true), 'OpenVPN, vpn.example.org:443');
  assert.throws(() => checkOvpn('client\nremote a 1\nauth-user-pass /etc/shadow\n', true), /путём к файлу/);
});

test('правка contour.yaml: добавить, поменять, удалить — комментарии целы, мусор не пишется', () => {
  const file = path.join(tmp(), 'contour.yaml');
  writeFileSync(file, '# мои настройки\nhttp:\n  port: 3128  # вход\noutlets:\n  - name: ext\n    kind: netns\n    bridge: 1\n    protocol: amneziawg\n    conf: /k/ext.conf\n');
  assert.equal(freeBridge(readOutlets(file)), 2);
  addOutlet(file, { name: 'nl', kind: 'mihomo', protocol: 'link', conf: '/k/nl.link', priority: 20, enabled: true });
  setOutletField(file, 'ext', 'priority', 5);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /# мои настройки/);
  assert.match(text, /# вход/);
  assert.deepEqual(readOutlets(file).map((o) => [o.name, o.priority]), [['ext', 5], ['nl', 20]]);
  assert.throws(() => addOutlet(file, { name: 'nl', kind: 'mihomo', protocol: 'link', conf: '/x' }), /уже есть/);
  assert.throws(() => addOutlet(file, { name: 'bad', kind: 'netns', protocol: 'link', conf: '/x', bridge: 3 }), /protocol/);
  assert.equal(readOutlets(file).length, 2, 'сломанная запись не записалась');
  removeOutlet(file, 'nl');
  assert.deepEqual(readOutlets(file).map((o) => o.name), ['ext']);
  assert.match(readFileSync(`${file}.bak`, 'utf8'), /nl/);
});

test('ручные решения: запись панелью, чтение DNS, ближайшее к имени сильнее', () => {
  const dir = tmp();
  const o = new Overrides(dir);
  assert.equal(o.match('www.instagram.com'), null);
  writeOverride(dir, 'https://Instagram.com/explore', 'tunnel');
  writeOverride(dir, 'cdn.instagram.com', 'direct');
  const fresh = new Overrides(dir);
  assert.equal(fresh.match('www.instagram.com'), 'tunnel');
  assert.equal(fresh.match('a.cdn.instagram.com'), 'direct');
  writeOverride(dir, 'instagram.com', null);
  assert.equal(new Overrides(dir).match('www.instagram.com'), null);
  assert.throws(() => writeOverride(dir, 'not a site', 'tunnel'), /не имя сайта/);
});

test('пароль: scrypt-хеш, верный пускает, неверный — нет; сессия переживает перезапуск', async () => {
  const dir = tmp();
  const file = path.join(dir, 'panel.json');
  writeFileSync(file, JSON.stringify(await hashPassword('correct horse')));
  const auth = new Auth(file, dir);
  assert.equal(await auth.check('correct horse'), true);
  assert.equal(await auth.check('wrong'), false);
  const id = auth.open();
  assert.equal(auth.valid(id), true);
  assert.doesNotMatch(readFileSync(path.join(dir, 'sessions.json'), 'utf8'), new RegExp(id), 'на диске не сам идентификатор');
  assert.equal(new Auth(file, dir).valid(id), true, 'после «перезапуска»');
  auth.close(id);
  assert.equal(new Auth(file, dir).valid(id), false);
  assert.equal(new Auth(path.join(dir, 'nope.json'), dir).configured(), false);
});

test('таблица соседей: адрес → MAC, неполные строки — прочь', () => {
  const arp = readArp('IP address       HW type     Flags       HW address            Mask     Device\n192.168.0.105    0x1         0x2         7c:ec:b1:a1:d1:d2     *        enp1s0\n192.168.0.50     0x1         0x0         00:00:00:00:00:00     *        enp1s0\n');
  assert.deepEqual([...arp], [['192.168.0.105', '7c:ec:b1:a1:d1:d2']]);
});

test('счётчик: итоги дня, сайты, скорость по завершённым секундам', async () => {
  const m = new Meter({ dir: tmp(), log: quiet });
  m.add('lan:192.168.0.105', 'ext', 'rr1.googlevideo.com', 100, 5_000);
  m.add('alter', 'ext', 'x.com', 10, 200);
  const today = m.todayTotals();
  assert.deepEqual(today.who['lan:192.168.0.105'], { up: 100, down: 5_000 });
  assert.deepEqual(today.outlet.ext, { up: 110, down: 5_200 });
  assert.equal(m.topHosts()[0]?.host, 'rr1.googlevideo.com');
  await new Promise((r) => setTimeout(r, 1_100));
  assert.ok((m.rates().who['lan:192.168.0.105']?.down ?? 0) > 0, 'прошлая секунда видна в скорости');
});
