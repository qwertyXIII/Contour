import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { decodeVpnLink, describeProfile, parseWgConf, readWgProfile } from '../src/outlets/profile.ts';

// Ключи выдуманные — base64 нужной длины, в них нет ничего настоящего.
const PRIV = 'cHJpdmF0ZS1rZXktZm9yLXRlc3RzLW9ubHktMDAwMDA=';
const PUB = 'cHVibGljLWtleS1mb3ItdGVzdHMtb25seS0wMDAwMDA=';

const FULL = `
[Interface]
PrivateKey = ${PRIV}
Address = 10.8.1.2/32, fd00::2/128
DNS = 1.1.1.1, example.search
MTU = 1280
Jc = 4
Jmin = 40
Jmax = 70
S1 = 15
S2 = 90
H1 = 1234567
H2 = 2345678
H3 = 3456789
H4 = 4567890

[Peer]
PublicKey = ${PUB}
PresharedKey = ${PUB}
Endpoint = vpn.example.org:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`;

test('полный конфиг awg: адреса, DNS без доменов поиска, параметры Amnezia', () => {
  const p = parseWgConf(FULL);
  assert.equal(p.privateKey, PRIV);
  assert.deepEqual(p.addresses, ['10.8.1.2/32', 'fd00::2/128']);
  assert.deepEqual(p.dns, ['1.1.1.1']);
  assert.equal(p.mtu, 1280);
  assert.equal(p.peer.host, 'vpn.example.org');
  assert.equal(p.peer.port, 51820);
  assert.equal(p.peer.keepalive, 25);
  assert.deepEqual(p.amnezia, { jc: '4', jmin: '40', jmax: '70', s1: '15', s2: '90', h1: '1234567', h2: '2345678', h3: '3456789', h4: '4567890' });
  assert.match(describeProfile(p), /AmneziaWG \(jc jmin jmax s1 s2 h1 h2 h3 h4\), vpn\.example\.org:51820/);
  assert.doesNotMatch(describeProfile(p), new RegExp(PRIV));
});

test('ядерный конфиг без Address — адрес и DNS приходят из .env, как у aiproxy', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-'));
  const conf = path.join(dir, 'ext.conf');
  const env = path.join(dir, 'ext.env');
  writeFileSync(conf, `[Interface]\nPrivateKey = ${PRIV}\nJc = 3\n[Peer]\nPublicKey = ${PUB}\nEndpoint = [2001:db8::1]:443\nAllowedIPs = 0.0.0.0/0\n`);
  writeFileSync(env, `# сгенерировано\nAWG_ADDRESS=10.8.1.5\nAWG_DNS=9.9.9.9\nAWG_ENDPOINT_HOST=x\n`);
  const p = readWgProfile(conf, env);
  assert.deepEqual(p.addresses, ['10.8.1.5/32']);
  assert.deepEqual(p.dns, ['9.9.9.9']);
  assert.equal(p.peer.host, '2001:db8::1');
  assert.equal(p.peer.port, 443);
  assert.equal(p.mtu, null);
});

test('без IPv4-адреса и со split-tunnel — отказ словами', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-'));
  const conf = path.join(dir, 'a.conf');
  writeFileSync(conf, `[Interface]\nPrivateKey = ${PRIV}\n[Peer]\nPublicKey = ${PUB}\nEndpoint = h:1\nAllowedIPs = 0.0.0.0/0\n`);
  assert.throws(() => readWgProfile(conf, null), /нет IPv4-адреса/);
  writeFileSync(conf, `[Interface]\nPrivateKey = ${PRIV}\nAddress = 10.0.0.2\n[Peer]\nPublicKey = ${PUB}\nEndpoint = h:1\nAllowedIPs = 10.0.0.0/8\n`);
  assert.throws(() => readWgProfile(conf, null), /split-tunnel/);
});

test('обязательные поля: без PrivateKey, Peer, Endpoint — ошибка', () => {
  assert.throws(() => parseWgConf(`[Peer]\nPublicKey = ${PUB}\n`), /PrivateKey/);
  assert.throws(() => parseWgConf(`[Interface]\nPrivateKey = ${PRIV}\n`), /\[Peer\]/);
  assert.throws(() => parseWgConf(`[Interface]\nPrivateKey = ${PRIV}\n[Peer]\nPublicKey = ${PUB}\nAllowedIPs = 0.0.0.0/0\n`), /Endpoint/);
});

test('ссылка vpn:// из Amnezia разворачивается в конфиг', () => {
  const inner = JSON.stringify({ config: FULL });
  const container = { containers: [{ container: 'amnezia-awg', awg: { last_config: inner } }], dns1: '1.0.0.1', description: 'тест', hostName: 'vpn.example.org' };
  const json = Buffer.from(JSON.stringify(container));
  const packed = Buffer.concat([Buffer.alloc(4), deflateSync(json)]);
  packed.writeUInt32BE(json.length, 0);
  const link = `vpn://${packed.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const decoded = decodeVpnLink(link);
  assert.equal(decoded.dns, '1.0.0.1');
  assert.equal(decoded.description, 'тест');
  assert.equal(parseWgConf(decoded.conf).peer.host, 'vpn.example.org');

  const dir = mkdtempSync(path.join(tmpdir(), 'contour-'));
  const file = path.join(dir, 'link.txt');
  writeFileSync(file, `${link}\n`);
  assert.equal(readWgProfile(file, null).peer.port, 51820);
});
