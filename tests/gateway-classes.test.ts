import assert from 'node:assert/strict';
import test from 'node:test';
import dnsPacket from 'dns-packet';
import { DEFAULTS, parseConfig } from '../src/config.ts';
import { allowRequest, gatewayHook } from '../src/dns/gateway.ts';
import { resolvePacket } from '../src/dns/server.ts';
import { allowCommands, assignSlots, checkClasses, classCommands, directSlots } from '../src/root/gateway-classes.ts';
import { desiredRoutes, liveVia, memberPaths, parseLanDefault, parseUpBridges, planRoutes, routeArgs, routeKeys, type SlotClass } from '../src/root/gateway-routes.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });
const ask = (name: string, type: string, id = 7) => dnsPacket.encode({ id, type: 'query', flags: dnsPacket.RECURSION_DESIRED, questions: [{ name, type: type as 'A', class: 'IN' }] });
const CONFIG = parseConfig(`
outlets:
  - { name: de1, kind: netns, bridge: 9, protocol: wireguard, conf: /x/de1.conf }
  - { name: de2, kind: netns, bridge: 7, protocol: wireguard, conf: /x/de2.conf }
  - { name: nl, kind: netns, bridge: 8, protocol: openvpn, conf: /x/nl.ovpn }
  - { name: link, kind: mihomo, protocol: link, conf: /x/link.link }
`);

test('объявление классов: страна, «только через» с корпоративной подсетью; ограда частных — кроме «только»', () => {
  const ok = checkClasses([
    { name: 'country-de', outlets: ['de1', 'de2'], country: 'DE' },
    { name: 'only-corp', outlets: ['nl'], only: true, nets: ['172.16.42.7/24', '10.0.0.0/8'] },
    { name: 'ru', outlets: ['home'], nets: ['91.108.4.0/22'] },
  ], 'home');
  assert.deepEqual(ok[1], { name: 'only-corp', outlets: ['nl'], only: true, nets: ['172.16.42.0/24', '10.0.0.0/8'] }, 'подсеть — с обнулённой хост-частью');
  assert.equal(ok[0]?.only, false);
  const bad = (raw: unknown, re: RegExp, why?: string): void => assert.throws(() => checkClasses(raw, 'home'), re, why);
  bad([{ name: 'tunnel', outlets: [] }], /встроенный/, '«tunnel» и «direct» — не классы');
  bad([{ name: 'a', outlets: ['de1'] }, { name: 'a', outlets: ['nl'] }], /дважды/, 'имя — одно');
  bad([{ name: 'a', outlets: ['de1'], nets: ['172.16.42.0/24'] }], /частная подсеть/, 'ограда частных — везде, кроме «только через»');
  bad([{ name: 'a', outlets: ['nl', 'home'], only: true }], /прямого выхода/, '«только через выходы» — никогда напрямую');
  bad([{ name: 'a', outlets: ['nl'], only: true, nets: ['127.0.0.0/8'] }], /служебная/);
  bad([{ name: 'a', outlets: ['nl'], only: true, nets: ['10.0.0.0/8'] }, { name: 'b', outlets: ['de1'], only: true, nets: ['10.5.0.0/16'] }], /пересекается/, 'одна подсеть — один класс');
  bad([{ name: 'a', outlets: ['de1'], country: 'de' }], /страна/);
  bad([{ name: 'A B', outlets: [] }], /имя класса/);
  bad(Array.from({ length: 33 }, (_, i) => ({ name: `c${i}`, outlets: [] })), /до 32/);
});

test('слоты: знакомому — прежний, новому — свободный и не только что освобождённый', () => {
  const declared = checkClasses([{ name: 'a', outlets: ['de1'] }, { name: 'b', outlets: ['nl'] }], 'home');
  const first = assignSlots([], declared);
  assert.deepEqual(first.classes.map((c) => [c.name, c.slot]), [['a', 0], ['b', 1]]);
  assert.deepEqual(first.fresh, [0, 1]);
  const next = assignSlots(first.classes, checkClasses([{ name: 'b', outlets: ['nl', 'de1'] }, { name: 'c', outlets: [] }], 'home'));
  assert.deepEqual(next.classes.map((c) => [c.name, c.slot]), [['b', 1], ['c', 2]], 'метка живых соединений «a» не поведёт в таблицу «c»');
  assert.deepEqual(next.fresh, [2]);
  assert.deepEqual(next.freed, [0]);
});

test('nft классов: наборы и цепочка выбора заново, адрес сильнее подсети, снятый — прочь без ошибки', () => {
  const classes: SlotClass[] = [
    { name: 'de', outlets: ['de1'], only: false, nets: [], slot: 0 },
    { name: 'corp', outlets: ['nl'], only: true, nets: ['172.16.42.0/24'], slot: 3 },
    { name: 'ru', outlets: ['home'], only: false, nets: [], slot: 4 },
  ];
  assert.deepEqual(directSlots(classes, CONFIG), [4], 'к роутеру — только класс с прямым выходом');
  const text = classCommands(classes, [4], [3], [1]);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], 'flush chain ip contour_gw gw_pick');
  assert.ok(lines.includes('flush set ip contour_gw gc3_dst'), 'новому классу — набор адресов с нуля');
  assert.ok(!lines.includes('flush set ip contour_gw gc0_dst'), 'знакомому — адреса остаются');
  assert.ok(lines.includes('add element ip contour_gw gc3_net { 172.16.42.0/24 }'));
  assert.deepEqual(lines.filter((l) => /gc1_/.test(l)), [
    'add set ip contour_gw gc1_dst { type ipv4_addr; flags timeout; }', 'delete set ip contour_gw gc1_dst',
    'add set ip contour_gw gc1_net { type ipv4_addr; flags interval; auto-merge; }', 'delete set ip contour_gw gc1_net',
  ]);
  assert.ok(lines.includes('add element ip contour_gw direct_marks { 0x2c2, 0x2d4 }'));
  const pick = lines.filter((l) => l.startsWith('add rule')).map((l) => l.replace('add rule ip contour_gw gw_pick ', ''));
  assert.deepEqual(pick, [
    'ip daddr @infra_dst return',
    'ip daddr @vpn_dst ct mark set 0x2c1 return',
    'ip daddr @gc0_dst ct mark set 0x2d0 return',
    'ip daddr @gc3_dst ct mark set 0x2d3 return',
    'ip daddr @gc4_dst ct mark set 0x2d4 return',
    'ip daddr @gc0_net ct mark set 0x2d0 return',
    'ip daddr @gc3_net ct mark set 0x2d3 return',
    'ip daddr @gc4_net ct mark set 0x2d4 return',
    'ip daddr @vpn_net ct mark set 0x2c1 return',
  ]);
  const allow = allowCommands(['142.250.74.46'], 60, 'gc0_dst', ['vpn_dst', 'gc3_dst']).trim().split('\n');
  assert.equal(allow[0], 'add element ip contour_gw gc0_dst { 142.250.74.46 timeout 3600s }');
  assert.deepEqual(allow.slice(3), [
    'add element ip contour_gw vpn_dst { 142.250.74.46 }', 'delete element ip contour_gw vpn_dst { 142.250.74.46 }',
    'add element ip contour_gw gc3_dst { 142.250.74.46 }', 'delete element ip contour_gw gc3_dst { 142.250.74.46 }',
  ], 'адрес — ровно в одном наборе «через …»');
});

test('маршруты класса: по месту в списке, лёгший — пропущен, в конце «недоступно»; прямой — через роутер', () => {
  const lan = { dev: 'enp1s0', via: '192.168.0.1' };
  const de = memberPaths(['de1', 'de2'], CONFIG, false);
  assert.deepEqual(de, [{ bridge: 9 }, { bridge: 7 }]);
  assert.deepEqual(desiredRoutes(de, new Set([7, 9]), lan), ['unicast|default|10.201.9.2|ctv9|1', 'unicast|default|10.201.7.2|ctv7|2', 'unreachable|default|||65535']);
  assert.deepEqual(desiredRoutes(de, new Set([7]), lan), ['unicast|default|10.201.7.2|ctv7|2', 'unreachable|default|||65535'], 'упал первый — второй той же страны');
  assert.deepEqual(desiredRoutes(de, new Set([8]), lan), ['unreachable|default|||65535'], 'нет ни одного — недоступно, не NL и не напрямую');
  assert.equal(liveVia(['de1', 'de2'], de, new Set([7]), lan), 'de2');
  assert.equal(liveVia(['de1', 'de2'], de, new Set(), lan), null);
  assert.deepEqual(memberPaths(['link', 'nope', 'home'], CONFIG, false), [null, null, 'direct'], 'mihomo ядро не поведёт; прямой выход — путь');
  assert.deepEqual(memberPaths(['home'], CONFIG, true), [null], '«только через» — никогда напрямую');
  assert.deepEqual(desiredRoutes(['direct'], new Set(), lan), ['unicast|default|192.168.0.1|enp1s0|1', 'unreachable|default|||65535']);
  assert.equal(memberPaths(['home'], parseConfig('direct: { enabled: false }'), false)[0], null, 'прямой выход выключен — пути нет');
  assert.equal(DEFAULTS.direct.name, 'home');
});

test('сверка таблицы: разбор `ip -j route`, сначала добавить, потом убрать', () => {
  const current = routeKeys('[{"dst":"default","gateway":"10.201.9.2","dev":"ctv9","metric":1,"flags":[]},{"type":"unreachable","dst":"default","metric":65535,"flags":[]},{"dst":"1.2.3.0/24","dev":"ctv9","flags":[]}]');
  assert.deepEqual(current, ['unicast|default|10.201.9.2|ctv9|1', 'unreachable|default|||65535', 'unicast|1.2.3.0/24||ctv9|0']);
  const plan = planRoutes(current, ['unicast|default|10.201.7.2|ctv7|2', 'unreachable|default|||65535']);
  assert.deepEqual(plan.add, ['unicast|default|10.201.7.2|ctv7|2']);
  assert.deepEqual(plan.del, ['unicast|default|10.201.9.2|ctv9|1', 'unicast|1.2.3.0/24||ctv9|0'], 'чужое в таблице класса — тоже прочь');
  assert.deepEqual(routeArgs('unicast|default|10.201.7.2|ctv7|2', 2703, 'replace'), ['route', 'replace', 'default', 'via', '10.201.7.2', 'dev', 'ctv7', 'metric', '2', 'table', '2703']);
  assert.deepEqual(routeArgs('unreachable|default|||65535', 2703, 'del'), ['route', 'del', 'unreachable', 'default', 'metric', '65535', 'table', '2703']);
  assert.deepEqual(routeKeys(''), []);
});

test('мосты и роутер из `ip -j`: мост поднят, только если на нём свой адрес', () => {
  const up = parseUpBridges(JSON.stringify([
    { ifindex: 2, ifname: 'enp1s0', flags: ['UP'], addr_info: [{ local: '192.168.0.50' }] },
    { ifindex: 7, ifname: 'ctv9', flags: ['BROADCAST', 'UP', 'LOWER_UP'], addr_info: [{ local: '10.201.9.1' }] },
    { ifindex: 8, ifname: 'ctv7', flags: ['BROADCAST'], addr_info: [{ local: '10.201.7.1' }] },
    { ifindex: 9, ifname: 'ctv8', flags: ['UP'], addr_info: [] },
  ]));
  assert.deepEqual([...up], [[9, 7]], 'ctv7 выключен, у ctv8 ещё нет адреса — маршрут через них не встанет');
  assert.deepEqual(parseUpBridges('мусор'), new Map());
  assert.deepEqual(parseLanDefault('[{"dst":"default","gateway":"192.168.0.1","dev":"enp1s0","metric":100},{"dst":"default","gateway":"10.0.0.1","dev":"wg0","metric":50}]'), { dev: 'wg0', via: '10.0.0.1' });
  assert.equal(parseLanDefault('[]'), null);
});

test('DNS шлюза: «куда» внедряется — класс в свой набор до ответа, AAAA пусто, «напрямую» — обычный DNS, сбой — наш адрес', async () => {
  const order: string[] = [];
  let failAllow = false;
  const hook = gatewayHook({
    clients: { isGateway: () => true },
    resolve: async (n, route) => { order.push(`resolve ${n} ${route}`); return { ips: ['142.250.74.46'], ttl: 900 }; },
    allow: async (ips, _ttl, route) => {
      if (failAllow) throw new Error('класса «de» нет');
      order.push(`allow ${ips.join(',')} ${route}`);
    },
    route: (n, d) => (n.endsWith('openai.com') ? 'de' : n === 'gosuslugi.ru' ? 'direct' : d.tunnel ? 'tunnel' : null),
    log: quiet,
  });
  const lan = { ...DEFAULTS.lan, enabled: true };
  const deps = { lan, decide: async (n: string) => ({ tunnel: n === 'youtube.com' || n === 'gosuslugi.ru' }), log: quiet, gateway: hook };

  const a = dnsPacket.decode((await resolvePacket(ask('chatgpt.openai.com', 'A'), deps, '192.168.0.21')) as Buffer);
  assert.deepEqual(a.answers?.map((r) => (r as { data: string }).data), ['142.250.74.46'], 'не в списке заблокированного, но класс — настоящие адреса');
  assert.deepEqual(order, ['resolve chatgpt.openai.com de', 'allow 142.250.74.46 de'], 'в набор класса — до ответа');
  const aaaa = dnsPacket.decode((await resolvePacket(ask('chatgpt.openai.com', 'AAAA'), deps, '192.168.0.21')) as Buffer);
  assert.deepEqual(aaaa.answers, [], 'AAAA — пусто: по IPv6 устройство ушло бы мимо класса');

  await resolvePacket(ask('youtube.com', 'A'), deps, '192.168.0.21');
  assert.equal(order.at(-1), 'allow 142.250.74.46 tunnel', 'тот же адрес в другой класс — сразу, не через 10 минут');
  await resolvePacket(ask('youtube.com', 'A', 9), deps, '192.168.0.21');
  assert.equal(order.filter((x) => x === 'allow 142.250.74.46 tunnel').length, 1, 'туда же — не чаще раза в 10 минут');

  assert.equal(await hook.answer(dnsPacket.decode(ask('gosuslugi.ru', 'A')), 'gosuslugi.ru', { tunnel: true }), 'upstream', '«напрямую» сильнее списка — ответ обычного DNS');
  assert.equal(await hook.answer(dnsPacket.decode(ask('example.org', 'A')), 'example.org', { tunnel: false }), null, 'нет решения — как всем');

  failAllow = true;
  const own = dnsPacket.decode((await resolvePacket(ask('api.openai.com', 'A'), deps, '192.168.0.21')) as Buffer);
  assert.equal((own.answers?.[0] as { data: string }).data, lan.address, 'помощник не положил в класс — наш адрес (SNI), а не настоящие мимо класса');
});

test('запрос помощнику: «как сейчас» — старой командой, класс — новой', () => {
  assert.deepEqual(allowRequest(['1.1.1.1'], 60, 'tunnel'), { cmd: 'gateway.allow', ips: ['1.1.1.1'], ttl: 60 });
  assert.deepEqual(allowRequest(['1.1.1.1'], 60, 'country-de'), { cmd: 'gateway.route', ips: ['1.1.1.1'], ttl: 60, route: 'country-de' });
});
