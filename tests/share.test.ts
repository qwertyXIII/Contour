import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { parseConfig } from '../src/config.ts';
import { Consumers } from '../src/consumers.ts';
import { PRIVATE_V4 } from '../src/inlets/fence.ts';
import { Sites } from '../src/panel/sites.ts';
import { buildEdgeConfig } from '../src/share/edge-config.ts';
import { shareLinks } from '../src/share/links.ts';
import { RuleBook } from '../src/rules/book.ts';
import { RuleSet } from '../src/rules/engine.ts';
import { phonePlan } from '../src/share/plan.ts';
import { shadowrocketConf } from '../src/share/rules.ts';
import { answer } from '../src/share/server.ts';
import { ShareStore, type ShareDevice } from '../src/share/store.ts';
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
  const base = { devices: store.devices(), wsPath: '/s-1', listen: '127.0.0.1', port: 18300, proxy: { host: '127.0.0.1', port: 3128 }, probeUrl: 'http://cp.cloudflare.com/generate_204', controller: '127.0.0.1:19091', secret: 's' };
  const doc = parse(buildEdgeConfig({ ...base, udp: [], countries: [] })) as {
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
  const fence = PRIVATE_V4.map(([net, bits]) => `IP-CIDR,${net}/${bits},REJECT,no-resolve`);
  assert.deepEqual(doc.rules, [...fence, 'NETWORK,udp,REJECT', `IN-USER,${a.id},via-${a.id}`, 'MATCH,REJECT'], 'ядерных выходов нет — UDP отвергается');
  assert.ok(!doc.rules.some((r) => r.includes('DIRECT')));

  // UDP — прямо в SOCKS ядерных выходов, группой «первый живой»; имена — DoH через неё же.
  const sock = (name: string, n: number) => ({ name, socks: { host: `10.201.${n}.2`, port: 1080, user: name, pass: `p${n}` } });
  const withUdp = parse(buildEdgeConfig({ ...base, udp: [sock('corp_ext', 2), sock('ext', 1)], countries: [] })) as {
    proxies: Array<{ name: string; type: string; server: string; udp?: boolean }>;
    'proxy-groups': Array<{ name: string; type: string; proxies: string[] }>;
    dns: { nameserver: string[] };
    rules: string[];
  };
  assert.deepEqual(withUdp.proxies.filter((p) => p.type === 'socks5').map((p) => [p.name, p.server, p.udp]), [['udp-corp_ext', '10.201.2.2', true], ['udp-ext', '10.201.1.2', true]]);
  assert.deepEqual(withUdp['proxy-groups'][0], { name: 'udp', type: 'fallback', proxies: ['udp-corp_ext', 'udp-ext'], url: 'http://cp.cloudflare.com/generate_204', interval: 60, lazy: false });
  assert.ok(withUdp.dns.nameserver.every((n) => n.endsWith('#udp')), 'имена для UDP — через выход, не DNS провайдера дома');
  assert.ok(withUdp.rules.indexOf('NETWORK,udp,udp') > withUdp.rules.indexOf(fence.at(-1) as string), 'ограда — раньше UDP: Contour этот путь не видит');
});

test('ограда SOCKS внутри namespace — те же сети, что у Contour', () => {
  const script = readFileSync(new URL('../deploy/contour-netns.sh', import.meta.url), 'utf8');
  const m = /^FENCE_V4="([^"]+)"/m.exec(script);
  assert.deepEqual(m?.[1]?.split(' '), PRIVATE_V4.map(([net, bits]) => `${net}/${bits}`));
  assert.match(script, /^    udp: true$/m);
});

/** Книга правил на папке DNS — как у живого Contour, со встроенными источниками. */
function bookOn(dns: string, opts: { own?: string[]; subnets?: string[]; countries?: string[]; countrySites?: () => Record<string, string[]>; country?: string[] } = {}): RuleBook {
  const book = new RuleBook({
    sites: new Sites({ dnsDir: dns, own: opts.own ?? [] }), subnets: () => opts.subnets ?? [], countries: () => opts.countries ?? [],
    directCountry: () => 'RU', countrySites: opts.countrySites ?? (() => ({})), dir: path.join(dns, 'rules'), log: quiet,
  });
  // Готовый список страны — подставной, без скачивания.
  (book as unknown as { countryList: (c: string) => string[] }).countryList = (c) => (c === 'RU' ? opts.country ?? [] : []);
  book.rebuild();
  return book;
}

test('правила телефона из движка: исключения строками наверху, наборы по действию, подсети — no-resolve, группы стран', () => {
  const dns = tmp('contour-dns-');
  writeFileSync(path.join(dns, 'blocked-domains.lst'), 'instagram.com\nwww.instagram.com\nx.com\ncdn.x.com\n');
  writeFileSync(path.join(dns, 'overrides.json'), JSON.stringify({ 'x.com': 'direct', 'chatgpt.com': 'tunnel', 'music.youtube.com': 'direct' }));
  writeFileSync(path.join(dns, 'dns-learned.json'), JSON.stringify({ 'linkedin.com': { via: 'tunnel', why: 'x', until: Date.now() + 60_000 } }));
  const book = bookOn(dns, { own: ['youtube.com', 'googlevideo.com'], subnets: ['91.108.4.0/22'], countries: ['RU'], country: ['gosuslugi.ru'] });
  const plan = phonePlan(book.rules(), ['RU', 'DE']);
  assert.deepEqual(plan.tunnel, ['chatgpt.com', 'googlevideo.com', 'instagram.com', 'linkedin.com', 'youtube.com']);
  assert.deepEqual(plan.exceptions.map((e) => [e.name, e.policy.kind]), [['music.youtube.com', 'direct']], 'поддомен напрямую внутри «через VPN» — строкой наверх');
  assert.deepEqual(plan.direct, ['x.com'], 'ручное «напрямую» сильнее общего списка');
  const conf = shadowrocketConf({ base: 'https://c.example.ru/list/T', device: 'iPhone', plan, countries: ['RU', 'DE'] });
  const rules = conf.slice(conf.indexOf('[Rule]')).split('\n').filter(Boolean);
  assert.deepEqual(rules, [
    '[Rule]',
    'DOMAIN-KEYWORD,netseer-ipaddr-assoc,REJECT',
    'DOMAIN-SUFFIX,music.youtube.com,DIRECT',
    'DOMAIN-SET,https://c.example.ru/list/T/domains.list,Contour',
    'DOMAIN-SET,https://c.example.ru/list/T/direct.list,DIRECT',
    'IP-CIDR,91.108.4.0/22,Contour,no-resolve',
    'DOMAIN-SET,https://c.example.ru/list/T/country-ru.list,Россия',
    'GEOIP,RU,Россия',
    'GEOIP,DE,Германия',
    'FINAL,DIRECT',
  ], 'узлы — по имени, а не «выбранный на главной»; пустой список страны не зовём');
  assert.match(conf, /^\[Proxy Group\]\nРоссия = select,DIRECT,Contour-RU\nГермания = select,DIRECT,Contour-DE$/m, 'там — напрямую, уехал — через выход в стране: группа названием страны');
  assert.match(conf, /^update-url = https:\/\/c\.example\.ru\/list\/T\/contour\.conf$/m);
  assert.match(conf, /^block-quic = all-proxy$/m);
  assert.match(conf, /^dns-direct-fallback-proxy = false$/m, 'прямой сайт не уходит через Contour, если имя не разрешилось');
  assert.deepEqual(phonePlan(book.rules(), []).country, {}, 'страна не открыта телефону — её сайты напрямую, как раньше');
  book.stop();
});

test('план телефона: точное имя — строкой; запрет — набором; «только через выходы» и «не через» — тоже через Contour', () => {
  const rules = new RuleSet([{ layer: 'manual', source: 'мои', entries: [
    { match: { kind: 'domain', name: 'ads.example', exact: false }, action: { target: { kind: 'reject' } } },
    { match: { kind: 'domain', name: 'www.example.org', exact: true }, action: { target: { kind: 'reject' } } },
    { match: { kind: 'domain', name: 'openai.com', exact: false }, action: { target: { kind: 'avoid', countries: ['RU'] }, fastest: true } },
    { match: { kind: 'cidr', net: (172 * 2 ** 24) + (16 << 16) + (253 << 8), bits: 24 }, action: { target: { kind: 'only', outlets: ['corp'] } } },
  ] }]);
  const plan = phonePlan(rules, []);
  assert.deepEqual(plan.reject, ['ads.example']);
  assert.deepEqual(plan.exceptions.map((e) => [e.name, e.exact]), [['www.example.org', true]]);
  assert.deepEqual(plan.tunnel, ['openai.com']);
  assert.deepEqual(plan.nets.map((n) => [n.cidr, n.policy.kind]), [['172.16.42.0/24', 'contour']], 'корпоративная сеть с телефона — через Contour, там правило');
  const conf = shadowrocketConf({ base: 'B', device: 'x', plan, countries: [] });
  assert.match(conf, /^DOMAIN,www\.example\.org,REJECT$/m);
  assert.match(conf, /^DOMAIN-SET,B\/reject\.list,REJECT$/m);
});

test('ссылка на правила: по токену включённого устройства и только с адресом; чужое — одинаковый «нет»', () => {
  const dns = tmp('contour-dns-');
  writeFileSync(path.join(dns, 'blocked-domains.lst'), 'instagram.com\n');
  const store = new ShareStore(tmp('contour-share-'));
  const book = bookOn(dns, { own: ['youtube.com'], subnets: ['91.108.4.0/22'], countries: ['RU'], country: ['gosuslugi.ru', 'www.gosuslugi.ru'], countrySites: () => store.settings().countrySites });
  const opts = { store, rules: () => book.rules(), allowed: null };
  const d = store.add('iPhone');
  const conf = `/list/${d.list}/contour.conf`;
  assert.equal(answer(conf, opts), null, 'адреса нет — телефону нечего дать');
  store.setDomain('c.example.ru');
  const a = answer(`${conf}?x=1`, opts);
  assert.match(a?.body ?? '', /IP-CIDR,91\.108\.4\.0\/22,Contour,no-resolve/);
  assert.doesNotMatch(a?.body ?? '', /Proxy Group|GEOIP/, 'у нового телефона стран нет — и групп нет');
  assert.equal(answer(`/list/${d.list}/domains.list`, opts)?.body, '# Contour: сайты через VPN, 2\n.instagram.com\n.youtube.com\n');
  store.setCountrySite('RU', 'alfabank.ru', true);
  book.rebuild();
  assert.equal(answer(`/list/${d.list}/country-ru.list`, opts), null, 'страна не открыта телефону — и списка нет');
  store.setCountry(d.id, 'RU', true);
  assert.equal(answer(`/list/${d.list}/country-ru.list`, opts)?.body, '# Contour: сайты только с адресом RU, 2\n.alfabank.ru\n.gosuslugi.ru\n', 'готовый список и свой из панели');
  assert.match(answer(conf, opts)?.body ?? '', /^Россия = select,DIRECT,Contour-RU$/m);
  assert.equal(answer(`/list/${d.list}/country-ru.list`, { ...opts, allowed: ['DE'] }), null, 'share.countries сужает');
  assert.equal(answer(`/list/${'A'.repeat(32)}/contour.conf`, opts), null);
  assert.equal(answer(`/list/${d.list}/other`, opts), null);
  store.setEnabled(d.id, false);
  assert.equal(answer(conf, opts), null);
  book.stop();
});

test('подписка: серверы телефона в base64 — Contour и открытые страны; название в заголовке', () => {
  const store = new ShareStore(tmp('contour-share-'));
  const rules = (): RuleSet => new RuleSet([]);
  const d = store.add('iPhone');
  store.setDomain('c.example.ru');
  const names = (): string[] => Buffer.from(answer(`/list/${d.list}/servers`, { store, rules, allowed: null })?.body ?? '', 'base64').toString().trim().split('\n').map((l) => decodeURIComponent(new URL(l).hash.slice(1)));
  assert.deepEqual(names(), ['Contour']);
  store.setCountry(d.id, 'RU', true);
  store.setCountry(d.id, 'DE', true);
  assert.deepEqual(names(), ['Contour', 'Contour-DE', 'Contour-RU']);
  const ru = store.devices()[0]?.exits.RU;
  store.setCountry(d.id, 'RU', false);
  assert.deepEqual(names(), ['Contour', 'Contour-DE']);
  store.setCountry(d.id, 'RU', true);
  assert.equal(store.devices()[0]?.exits.RU, ru, 'закрыл и открыл — ключ тот же, сервер в телефоне работает');
  const h = answer(`/list/${d.list}/servers`, { store, rules, allowed: null })?.headers ?? {};
  assert.equal(Buffer.from((h['profile-title'] ?? '').replace(/^base64:/, ''), 'base64').toString(), 'Contour');
  assert.throws(() => store.setCountry(d.id, 'ru1', true), /две латинские буквы/);
});

test('ссылки для телефона: подписка одним QR; vless через WebSocket и TLS на 443, HTTP/1.1; сервер на страну; QR — картинкой с белой подложкой', () => {
  const store = new ShareStore(tmp('contour-share-'));
  const d = store.setCountry(store.add('iPhone').id, 'RU', true);
  assert.equal(shareLinks(d, store.settings(), null), null);
  const links = shareLinks(d, store.setDomain('c.example.ru'), null);
  assert.deepEqual(links?.nodes.map((n) => [n.name, n.country]), [['Contour', null], ['Contour-RU', 'RU']]);
  assert.equal(links?.subscription.url, `https://c.example.ru/list/${d.list}/servers#Contour`);
  assert.equal(links?.subscription.open, `shadowrocket://add/https://c.example.ru/list/${d.list}/servers#Contour`);
  assert.deepEqual(shareLinks(d, store.settings(), ['DE'])?.nodes.map((n) => n.name), ['Contour'], 'share.countries сужает');
  assert.notEqual(new URL(links?.nodes[1]?.server ?? '').username, d.uuid, 'у сервера страны свой ключ');
  assert.equal(new URL(links?.nodes[1]?.server ?? '').hash, '#Contour-RU', 'имя сервера — то, по которому его зовут правила');
  const u = new URL(links?.nodes[0]?.server ?? '');
  assert.equal(u.protocol, 'vless:');
  assert.equal(u.username, d.uuid);
  assert.equal(u.host, 'c.example.ru:443');
  assert.deepEqual(Object.fromEntries(u.searchParams), { encryption: 'none', security: 'tls', sni: 'c.example.ru', alpn: 'http/1.1', type: 'ws', host: 'c.example.ru', path: store.settings().path });
  assert.equal(links?.open, `shadowrocket://config/add/https://c.example.ru/list/${d.list}/contour.conf`);
  const svg = Buffer.from((links?.nodes[0]?.qr ?? '').replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString();
  assert.match(svg, /^<svg[^>]*><rect width="100%" height="100%" fill="#fff"\/>/);
});

test('настройки: раздел share — умолчания и неизвестное поле', () => {
  assert.deepEqual(parseConfig('outlets: []').share, { enabled: true, listen: '127.0.0.1', port: 18300, listPort: 18091, controller: '127.0.0.1:19091', dir: '/var/lib/contour/share', countries: null });
  assert.equal(parseConfig('share: {enabled: false}').share.enabled, false);
  assert.throws(() => parseConfig('share: {domain: x}'), /share: неизвестное поле «domain»/);
});

test('страны: прежний файл сохраняет выданные страны; край ведёт сервер страны в прокси с заголовком, UDP — в выходы страны', () => {
  const dir = tmp('contour-share-');
  const fresh = new ShareStore(dir).add('iPad');
  assert.deepEqual([fresh.countries, fresh.exits], [[], {}], 'у нового — никаких стран: домашний адрес без спроса не уходит');
  // Файл прежней версии: ключ «Contour-RU» выдан, списка открытых стран ещё нет.
  const ru = '11111111-2222-4333-8444-555555555555';
  const file = path.join(dir, 'share.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { devices: Array<Record<string, unknown>> };
  raw.devices = [{ id: 'aaaaaaaa', name: 'iPhone', uuid: '99999999-2222-4333-8444-555555555555', exits: { RU: ru }, list: 'L'.repeat(32), enabled: true, created: 1 }];
  writeFileSync(file, JSON.stringify(raw));
  const store = new ShareStore(dir);
  const a = store.devices()[0] as ShareDevice;
  assert.deepEqual(a.countries, ['RU'], 'выданный сервер страны не пропадает');
  assert.equal(new ShareStore(dir).devices()[0]?.exits.RU, ru, 'ключ страны не меняется между запусками');
  const other = store.add('Друг');

  const home = { name: 'home', direct: true, socks: { host: '', port: 0, user: '', pass: '' } };
  const de = { name: 'corp_ext', socks: { host: '10.201.2.2', port: 1080, user: 'corp_ext', pass: 'p' } };
  const doc = parse(buildEdgeConfig({ devices: store.devices(), wsPath: '/s', listen: '127.0.0.1', port: 18300, proxy: { host: '127.0.0.1', port: 3128 }, udp: [de], countries: [{ code: 'RU', udp: [home] }], probeUrl: 'http://x/', controller: 'c', secret: 's' })) as {
    listeners: Array<{ users: Array<{ username: string; uuid: string }> }>;
    proxies: Array<{ name: string; type: string; headers?: Record<string, string> }>;
    'proxy-groups': Array<{ name: string; proxies: string[] }>;
    rules: string[];
  };
  assert.deepEqual(doc.listeners[0]?.users, [{ username: a.id, uuid: a.uuid }, { username: `${a.id}.ru`, uuid: ru }, { username: other.id, uuid: other.uuid }], 'другу Россия не открыта — и сервера страны у него нет');
  assert.ok(!doc.rules.some((x) => x.includes(`${other.id}.ru`)));
  assert.deepEqual(doc.proxies.find((p) => p.name === `via-${a.id}-ru`)?.headers, { 'contour-exit': 'RU' });
  assert.deepEqual(doc['proxy-groups'].map((g) => [g.name, g.proxies]), [['udp', ['udp-corp_ext']], ['udp-RU', ['DIRECT']]], 'прямой выход для UDP — DIRECT с края');
  const r = doc.rules;
  assert.ok(r.indexOf(`AND,((NETWORK,udp),(IN-USER,${a.id}.ru)),udp-RU`) < r.indexOf('NETWORK,udp,udp'), 'UDP страны — раньше обычного');
  assert.ok(r.indexOf(`IN-USER,${a.id}.ru,via-${a.id}-ru`) < r.indexOf(`IN-USER,${a.id},via-${a.id}`));
  assert.ok(r.indexOf('IP-CIDR,127.0.0.0/8,REJECT,no-resolve') < r.indexOf(`AND,((NETWORK,udp),(IN-USER,${a.id}.ru)),udp-RU`), 'ограда — до DIRECT');
});

test('край: подсеть правила «только через эти выходы» — TCP в прокси, UDP — отказ; остальная частная сеть — отказ', () => {
  const store = new ShareStore(tmp('contour-share-'));
  store.add('iPhone');
  const doc = parse(buildEdgeConfig({ devices: store.devices(), wsPath: '/s', listen: '127.0.0.1', port: 18300, proxy: { host: '127.0.0.1', port: 3128 }, udp: [], countries: [], probeUrl: 'http://x/', controller: 'c', secret: 's', allowTcp: ['172.16.42.0/24'] })) as { rules: string[] };
  assert.ok(doc.rules.includes('AND,((NETWORK,udp),(IP-CIDR,172.16.42.0/24,no-resolve)),REJECT'));
  assert.ok(doc.rules.includes('AND,((IP-CIDR,172.16.0.0/12,no-resolve),(NOT,((IP-CIDR,172.16.42.0/24,no-resolve)))),REJECT'));
  assert.ok(doc.rules.includes('IP-CIDR,10.0.0.0/8,REJECT,no-resolve'));
  assert.ok(!doc.rules.includes('IP-CIDR,172.16.0.0/12,REJECT,no-resolve'));
});
