import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'yaml';
import { buildMihomoConfig } from '../src/outlets/mihomo-config.ts';
import { newOutlet, type MihomoOutlet } from '../src/outlets/outlet.ts';
import { parseWgConf } from '../src/outlets/profile.ts';
import type { OutletConfig } from '../src/config.ts';

const PRIV = 'cHJpdmF0ZS1rZXktZm9yLXRlc3RzLW9ubHktMDAwMDA=';
const PUB = 'cHVibGljLWtleS1mb3ItdGVzdHMtb25seS0wMDAwMDA=';

function outlet(name: string, protocol: 'amneziawg' | 'wireguard', port: number, conf: string): MihomoOutlet {
  const config: OutletConfig = { name, kind: 'mihomo', bridge: null, protocol, conf: '/x', env: null, dns: [], mtu: null, priority: 10, enabled: true };
  return { outlet: newOutlet(config, port), config, profile: parseWgConf(conf) };
}

const AWG = `[Interface]\nPrivateKey = ${PRIV}\nAddress = 10.8.1.2/32\nDNS = 1.1.1.1\nJc = 4\nJmin = 40\nJmax = 70\nS1 = 15\nS2 = 90\nH1 = 1\nH2 = 2\nH3 = 3\nH4 = 4\nI1 = <b 0xf6ab><r 10>\n[Peer]\nPublicKey = ${PUB}\nEndpoint = vpn.example.org:51820\nAllowedIPs = 0.0.0.0/0\n`;

test('каждый выход — proxy wireguard и свой SOCKS-вход с паролем, остальное отвергается', () => {
  const a = outlet('ext', 'amneziawg', 10800, AWG);
  const b = outlet('plain', 'wireguard', 10801, AWG);
  const doc = parse(buildMihomoConfig({ outlets: [a, b], controller: '127.0.0.1:19090', secret: 's3cret' })) as Record<string, any>;

  assert.equal(doc['external-controller'], '127.0.0.1:19090');
  assert.equal(doc.secret, 's3cret');
  assert.deepEqual(doc.rules, ['MATCH,REJECT']);
  assert.equal(doc['geo-auto-update'], false);
  assert.equal(doc['mixed-port'], undefined);
  assert.equal(doc.port, undefined);

  assert.equal(doc.listeners.length, 2);
  assert.deepEqual(doc.listeners[0], {
    name: 'in-ext', type: 'socks', listen: '127.0.0.1', port: 10800, proxy: 'ext', udp: false,
    users: [{ username: 'ext', password: a.outlet.socks.pass }],
  });

  const ext = doc.proxies[0];
  assert.equal(ext.type, 'wireguard');
  assert.equal(ext.ip, '10.8.1.2');
  assert.equal(ext.server, 'vpn.example.org');
  assert.equal(ext.port, 51820);
  assert.equal(ext['remote-dns-resolve'], true);
  assert.deepEqual(ext.dns, ['1.1.1.1', '8.8.8.8'], 'резолвер профиля плюс публичные, без повтора');
  assert.deepEqual(ext['amnezia-wg-option'], { jc: 4, jmin: 40, jmax: 70, s1: 15, s2: 90, h1: 1, h2: 2, h3: 3, h4: 4, i1: '<b 0xf6ab><r 10>' });

  // Протокол wireguard: параметры Amnezia из файла игнорируются.
  assert.equal(doc.proxies[1]['amnezia-wg-option'], undefined);
});

test('резолверы: из профиля плюс публичные без повторов; список в настройках выхода — вместо', () => {
  const a = outlet('a', 'wireguard', 1, AWG.replace('DNS = 1.1.1.1', 'DNS = 10.10.8.15, 8.8.8.8'));
  const b = outlet('b', 'wireguard', 2, AWG);
  b.config.dns = ['9.9.9.9'];
  const doc = parse(buildMihomoConfig({ outlets: [a, b], controller: 'c', secret: 's' })) as Record<string, any>;
  assert.deepEqual(doc.proxies[0].dns, ['10.10.8.15', '8.8.8.8', '1.1.1.1']);
  assert.deepEqual(doc.proxies[1].dns, ['9.9.9.9']);
});

test('MTU: из настроек выхода, иначе из профиля, иначе безопасные 1280', () => {
  const fromConfig = outlet('a', 'wireguard', 1, AWG);
  fromConfig.config.mtu = 1360;
  const fromProfile = outlet('b', 'wireguard', 2, AWG.replace('[Peer]', 'MTU = 1376\n[Peer]'));
  const fallback = outlet('c', 'wireguard', 3, AWG);
  const doc = parse(buildMihomoConfig({ outlets: [fromConfig, fromProfile, fallback], controller: 'c', secret: 's' })) as Record<string, any>;
  assert.equal(doc.proxies[0].mtu, 1360);
  assert.equal(doc.proxies[1].mtu, 1376);
  assert.equal(doc.proxies[2].mtu, 1280);
});

test('пароль SOCKS у каждого выхода свой и длинный', () => {
  const a = outlet('a', 'wireguard', 1, AWG);
  const b = outlet('b', 'wireguard', 2, AWG);
  assert.notEqual(a.outlet.socks.pass, b.outlet.socks.pass);
  assert.ok(a.outlet.socks.pass.length >= 32);
});
