import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import dnsPacket from 'dns-packet';
import { DEFAULTS } from '../src/config.ts';
import { GatewayClients, gatewayHook } from '../src/dns/gateway.ts';
import { resolvePacket } from '../src/dns/server.ts';
import { parseGateway } from '../src/gateway.ts';
import { ResolveError } from '../src/outlets/doh.ts';
import { freeAddress } from '../src/panel/state.ts';
import { allowCommands, deviceCommands, gatewayRuleset } from '../src/root/gateway.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });
const ask = (name: string, type: string, id = 7) => dnsPacket.encode({ id, type: 'query', flags: dnsPacket.RECURSION_DESIRED, questions: [{ name, type: type as 'A', class: 'IN' }] });
const ARP = 'IP address       HW type     Flags       HW address            Mask     Device\n192.168.0.21     0x1         0x2         aa:bb:cc:dd:ee:01     *        enp1s0\n192.168.0.105    0x1         0x2         7c:ec:b1:a1:d1:d2     *        enp1s0\n';

test('файл режимов: мусор отбрасывается, MAC — в нижний регистр', () => {
  assert.deepEqual(parseGateway('{"devices":{"AA:BB:CC:DD:EE:01":"blocked","zz":"all","aa:bb:cc:dd:ee:02":"everything","aa:bb:cc:dd:ee:03":"all"}}'),
    { devices: { 'aa:bb:cc:dd:ee:01': 'blocked', 'aa:bb:cc:dd:ee:03': 'all' } });
  assert.deepEqual(parseGateway('не json'), { devices: {} });
});

test('команды nft: наборы устройств целиком, адреса — со свежим сроком от часа', () => {
  assert.equal(deviceCommands({ devices: { 'aa:bb:cc:dd:ee:01': 'blocked' } }),
    'flush set ip contour_gw gw_blocked\nflush set ip contour_gw gw_all\nadd element ip contour_gw gw_blocked { aa:bb:cc:dd:ee:01 }\n');
  const allow = allowCommands(['142.250.74.46'], 60).split('\n');
  assert.equal(allow[0], 'add element ip contour_gw vpn_dst { 142.250.74.46 timeout 3600s }', 'TTL 60 с → час: приложения держат адрес дольше');
  assert.match(allow[1] as string, /^delete element/);
  assert.match(allowCommands(['1.1.1.1'], 100_000), /timeout 21600s/, 'не больше 6 часов');
  assert.throws(() => gatewayRuleset('enp1s0"; flush ruleset'), /странное/);
  assert.match(gatewayRuleset('enp1s0'), /ether saddr @gw_all ip daddr != @local_dst ct mark set 0x2c1/);
});

test('DNS шлюза: устройство — по MAC; заблокированное — настоящими адресами через туннель, сначала в набор', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-gw-'));
  const file = path.join(dir, 'gateway.json');
  const arp = path.join(dir, 'arp');
  writeFileSync(file, '{"devices":{"aa:bb:cc:dd:ee:01":"blocked"}}');
  writeFileSync(arp, ARP);
  const clients = new GatewayClients(file, arp);
  assert.equal(clients.isGateway('192.168.0.21'), true);
  assert.equal(clients.isGateway('192.168.0.105'), false, 'телевизор — не шлюз');

  const order: string[] = [];
  const hook = gatewayHook({
    clients,
    resolve: async (n) => {
      if (n === 'nowhere.example') throw new ResolveError('имени нет');
      if (n === 'down.example') throw new Error('туннель не ответил');
      order.push(`resolve ${n}`);
      return { ips: ['142.250.74.46', '142.250.74.78'], ttl: 900 };
    },
    allow: async (ips) => { order.push(`allow ${ips.join(',')}`); },
    log: quiet,
  });
  const lan = { ...DEFAULTS.lan, enabled: true };
  const deps = { lan, decide: async (n: string) => ({ tunnel: true, local: n === 'vpn.home' }), log: quiet, gateway: hook };

  const a = dnsPacket.decode((await resolvePacket(ask('www.youtube.com', 'A'), deps, '192.168.0.21')) as Buffer);
  assert.deepEqual(a.answers?.map((r) => (r as { data: string }).data), ['142.250.74.46', '142.250.74.78']);
  assert.equal((a.answers?.[0] as { ttl: number }).ttl, 300, 'срок ответа — не больше 5 минут');
  assert.deepEqual(order, ['resolve www.youtube.com', 'allow 142.250.74.46,142.250.74.78'], 'в набор — до ответа');

  await resolvePacket(ask('www.youtube.com', 'A', 8), deps, '192.168.0.21');
  assert.equal(order.filter((x) => x.startsWith('allow')).length, 1, 'те же адреса снова в набор не шлём');

  const tv = dnsPacket.decode((await resolvePacket(ask('www.youtube.com', 'A'), deps, '192.168.0.105')) as Buffer);
  assert.equal((tv.answers?.[0] as { data: string }).data, lan.address, 'не шлюз — наш адрес, как раньше');
  const panel = dnsPacket.decode((await resolvePacket(ask('vpn.home', 'A'), deps, '192.168.0.21')) as Buffer);
  assert.equal((panel.answers?.[0] as { data: string }).data, lan.address, 'панель — наш адрес и шлюзу');
  const aaaa = dnsPacket.decode((await resolvePacket(ask('www.youtube.com', 'AAAA'), deps, '192.168.0.21')) as Buffer);
  assert.deepEqual(aaaa.answers, [], 'AAAA — пусто и шлюзу: IPv6 мимо нас');
  const none = dnsPacket.decode((await resolvePacket(ask('nowhere.example', 'A'), deps, '192.168.0.21')) as Buffer);
  assert.deepEqual(none.answers, [], 'имени нет — пусто, а не наш адрес');
  const down = dnsPacket.decode((await resolvePacket(ask('down.example', 'A'), deps, '192.168.0.21')) as Buffer);
  assert.equal((down.answers?.[0] as { data: string }).data, lan.address, 'туннель не ответил — наш адрес: сайт откроется по SNI');
});

test('отметка в панели — ещё не шлюз: настоящие адреса — только тому, кто на деле ходит через сервер', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-gw-'));
  const file = path.join(dir, 'gateway.json');
  const arp = path.join(dir, 'arp');
  writeFileSync(file, '{"devices":{"aa:bb:cc:dd:ee:01":"blocked"}}');
  writeFileSync(arp, ARP);
  let seen: string[] = [];
  const clients = new GatewayClients(file, arp, async () => seen);
  assert.equal(clients.isGateway('192.168.0.21'), false, 'до ответа помощника — не шлюз');
  await new Promise((r) => setImmediate(r));
  assert.equal(clients.isGateway('192.168.0.21'), false, 'отмечен, но маршрутизатор на нём — роутер');
  seen = ['aa:bb:cc:dd:ee:01'];
  const later = Date.now() + 11_000;
  clients.isGateway('192.168.0.21', later);
  await new Promise((r) => setImmediate(r));
  assert.equal(clients.isGateway('192.168.0.21', later + 1), true);
  const broken = new GatewayClients(file, arp, async () => { throw new Error('неизвестная команда'); });
  broken.isGateway('192.168.0.21');
  await new Promise((r) => setImmediate(r));
  assert.equal(broken.isGateway('192.168.0.21'), false, 'помощник старый или молчит — как раньше, наш адрес');
});

test('подсказка адреса для шлюза: вне пула DHCP, не занятый', () => {
  const arp = new Map([['192.168.0.20', 'x'], ['192.168.0.21', 'y']]);
  assert.equal(freeAddress('192.168.0.50', arp), '192.168.0.22');
});
