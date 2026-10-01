import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { parseConfig } from '../src/config.ts';
import { Consumers } from '../src/consumers.ts';
import { Sites } from '../src/panel/sites.ts';
import { buildEdgeConfig } from '../src/share/edge-config.ts';
import { shareLinks } from '../src/share/links.ts';
import { ShareRules, shareDomains, shadowrocketConf } from '../src/share/rules.ts';
import { answer } from '../src/share/server.ts';
import { ShareStore } from '../src/share/store.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });
const tmp = (p: string): string => mkdtempSync(path.join(tmpdir(), p));
const basic = (name: string, token: string): string => `Basic ${Buffer.from(`${name}:${token}`).toString('base64')}`;

test('устройства раздачи: путь постоянный, у каждого свой ключ и свой токен правил', () => {
  const dir = tmp('contour-share-');
  const store = new ShareStore(dir);
  const wsPath = store.settings().path;
  assert.match(wsPath, /^\/s-[0-9a-f]{24}$/);
  const a = store.add('iPhone');
  const b = store.add('  iPad  ');
  assert.equal(b.name, 'iPad');
  assert.notEqual(a.uuid, b.uuid);
  assert.notEqual(a.list, a.uuid, 'токен правил — не ключ VLESS: ссылка попадает в журнал nginx');
  const again = new ShareStore(dir);
  assert.equal(again.settings().path, wsPath, 'путь не меняется между запусками — иначе отвяжутся все телефоны');
  assert.equal(again.byList(a.list)?.id, a.id);
  assert.equal(again.byList('x'.repeat(a.list.length)), null);
  again.setEnabled(a.id, false);
  assert.equal(again.byList(a.list), null, 'выключенному — правил нет');
  assert.deepEqual([...again.proxyTokens().keys()], [`share.${b.id}`]);
  assert.throws(() => again.add('   '), /имя/);
  assert.equal(again.setDomain('https://Contour.Example.RU/').domain, 'contour.example.ru');
  assert.throws(() => again.setDomain('не домен'), /не имя сайта/);
});

test('прокси: устройство раздачи входит своим ключом, а строка share.* в файле токенов не действует', () => {
  const dir = tmp('contour-share-');
  const tokens = path.join(dir, 'tokens');
  writeFileSync(tokens, 'share.dead:aaaaaaaaaaaaaaaaaaaaaaaa\nalter:bbbbbbbbbbbbbbbbbbbbbbbb\n');
  const consumers = new Consumers(tokens, quiet);
  consumers.load();
  const store = new ShareStore(dir);
  const d = store.add('iPhone');
  consumers.useShare(() => store.proxyTokens());
  assert.equal(consumers.authorize(basic(`share.${d.id}`, d.uuid)), `share.${d.id}`);
  assert.equal(consumers.authorize(basic('share.dead', 'aaaaaaaaaaaaaaaaaaaaaaaa')), null);
  assert.equal(consumers.authorize(basic('alter', 'bbbbbbbbbbbbbbbbbbbbbbbb')), 'alter');
  store.setEnabled(d.id, false);
  assert.equal(consumers.authorize(basic(`share.${d.id}`, d.uuid)), null, 'выключил — прокси не пускает сразу');
});

test('край: вход VLESS по WebSocket, каждое устройство — в прокси Contour под своим именем, без DIRECT', () => {
  const store = new ShareStore(tmp('contour-share-'));
  const a = store.add('iPhone');
  const off = store.add('старый');
  store.setEnabled(off.id, false);
  const doc = parse(buildEdgeConfig({ devices: store.devices(), wsPath: '/s-1', listen: '127.0.0.1', port: 18300, proxy: { host: '127.0.0.1', port: 3128 }, controller: '127.0.0.1:19091', secret: 's' })) as {
    listeners: Array<{ type: string; listen: string; 'ws-path': string; 'allow-insecure': boolean; users: Array<{ username: string; uuid: string }> }>;
    proxies: Array<{ name: string; type: string; username: string; password: string }>;
    rules: string[];
  };
  assert.equal(doc.listeners[0]?.type, 'vless');
  assert.equal(doc.listeners[0]?.listen, '127.0.0.1');
  assert.equal(doc.listeners[0]?.['ws-path'], '/s-1');
  assert.equal(doc.listeners[0]?.['allow-insecure'], true, 'без него mihomo 1.19 вход без TLS не открывает; TLS снимает nginx');
  assert.deepEqual(doc.listeners[0]?.users, [{ username: a.id, uuid: a.uuid }], 'выключенного нет');
  assert.deepEqual(doc.proxies.map((p) => [p.type, p.username, p.password]), [['http', `share.${a.id}`, a.uuid]]);
  assert.deepEqual(doc.rules, ['NETWORK,udp,REJECT', `IN-USER,${a.id},via-${a.id}`, 'MATCH,REJECT']);
  assert.ok(!doc.rules.some((r) => r.includes('DIRECT')));
});

test('правила: ручное «напрямую» первым и вычищено из списка, поддомены схлопнуты, подсети — no-resolve', () => {
  const d = shareDomains({
    own: ['youtube.com', 'googlevideo.com'],
    common: ['instagram.com', 'www.instagram.com', 'x.com', 'cdn.x.com'],
    learned: ['linkedin.com'],
    overrides: { 'x.com': 'direct', 'chatgpt.com': 'tunnel', 'music.youtube.com': 'direct' },
  });
  assert.deepEqual(d.tunnel, ['chatgpt.com', 'googlevideo.com', 'instagram.com', 'linkedin.com', 'youtube.com']);
  assert.deepEqual(d.direct, ['music.youtube.com', 'x.com']);
  const conf = shadowrocketConf({ base: 'https://c.example.ru/list/T', device: 'iPhone', direct: d.direct, nets: ['91.108.4.0/22'] });
  const rules = conf.slice(conf.indexOf('[Rule]')).split('\n').filter(Boolean);
  assert.deepEqual(rules, [
    '[Rule]',
    'DOMAIN-SUFFIX,music.youtube.com,DIRECT',
    'DOMAIN-SUFFIX,x.com,DIRECT',
    'DOMAIN-SET,https://c.example.ru/list/T/domains.list,PROXY',
    'IP-CIDR,91.108.4.0/22,PROXY,no-resolve',
    'FINAL,DIRECT',
  ]);
  assert.match(conf, /^update-url = https:\/\/c\.example\.ru\/list\/T\/contour\.conf$/m);
  assert.match(conf, /^block-quic = all-proxy$/m);
});

test('ссылка на правила: по токену включённого устройства и только с адресом; чужое — одинаковый «нет»', () => {
  const dns = tmp('contour-dns-');
  writeFileSync(path.join(dns, 'blocked-domains.lst'), 'instagram.com\n');
  writeFileSync(path.join(dns, 'gateway-subnets.lst'), '91.108.4.0/22\n104.16.0.0/13\n10.0.0.0/8\n');
  const rules = new ShareRules({ sites: new Sites({ dnsDir: dns, own: ['youtube.com'] }), dnsDir: dns, skip: ['104.16.0.0/13'] });
  const store = new ShareStore(tmp('contour-share-'));
  const d = store.add('iPhone');
  const conf = `/list/${d.list}/contour.conf`;
  assert.equal(answer(conf, { store, rules }), null, 'адреса нет — телефону нечего дать');
  store.setDomain('c.example.ru');
  const a = answer(`${conf}?x=1`, { store, rules });
  assert.match(a?.body ?? '', /IP-CIDR,91\.108\.4\.0\/22,PROXY,no-resolve/);
  assert.doesNotMatch(a?.body ?? '', /104\.16|10\.0\.0/, 'без Cloudflare и частных — как у шлюза');
  assert.equal(answer(`/list/${d.list}/domains.list`, { store, rules })?.body, '# Contour: сайты через VPN, 2\n.instagram.com\n.youtube.com\n');
  assert.equal(answer(`/list/${'A'.repeat(32)}/contour.conf`, { store, rules }), null);
  assert.equal(answer(`/list/${d.list}/other`, { store, rules }), null);
  store.setEnabled(d.id, false);
  assert.equal(answer(conf, { store, rules }), null);
});

test('ссылки для телефона: vless через WebSocket и TLS на 443, HTTP/1.1; QR — картинкой с белой подложкой', () => {
  const store = new ShareStore(tmp('contour-share-'));
  const d = store.add('iPhone');
  assert.equal(shareLinks(d, store.settings()), null);
  const links = shareLinks(d, store.setDomain('c.example.ru'));
  const u = new URL(links?.server ?? '');
  assert.equal(u.protocol, 'vless:');
  assert.equal(u.username, d.uuid);
  assert.equal(u.host, 'c.example.ru:443');
  assert.deepEqual(Object.fromEntries(u.searchParams), { encryption: 'none', security: 'tls', sni: 'c.example.ru', alpn: 'http/1.1', type: 'ws', host: 'c.example.ru', path: store.settings().path });
  assert.equal(links?.open, `shadowrocket://config/add/https://c.example.ru/list/${d.list}/contour.conf`);
  const svg = Buffer.from((links?.qr ?? '').replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString();
  assert.match(svg, /^<svg[^>]*><rect width="100%" height="100%" fill="#fff"\/>/);
});

test('настройки: раздел share — умолчания и неизвестное поле', () => {
  assert.deepEqual(parseConfig('outlets: []').share, { enabled: true, listen: '127.0.0.1', port: 18300, listPort: 18091, controller: '127.0.0.1:19091', dir: '/var/lib/contour/share' });
  assert.equal(parseConfig('share: {enabled: false}').share.enabled, false);
  assert.throws(() => parseConfig('share: {domain: x}'), /share: неизвестное поле «domain»/);
});
