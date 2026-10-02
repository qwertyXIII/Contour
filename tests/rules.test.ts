import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseCidr } from '../src/cidr.ts';
import { RuleBook } from '../src/rules/book.ts';
import { CompiledRules } from '../src/rules/compiled.ts';
import { ipv4ToInt, RuleSet, type RuleSource } from '../src/rules/engine.ts';
import { siteOf as domainService } from '../src/rules/service-index.ts';
import { routeFor } from '../src/rules/need.ts';
import type { Action, Entry } from '../src/rules/types.ts';
import { Sites } from '../src/panel/sites.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });
const tmp = (p: string): string => mkdtempSync(path.join(tmpdir(), p));
const act = (target: Action['target'], fastest?: boolean): Action => ({ target, ...(fastest ? { fastest } : {}) });
const name = (n: string, a: Action, exact = false): Entry => ({ match: { kind: 'domain', name: n, exact }, action: a });
const net = (c: string, a: Action): Entry => ({ match: { kind: 'cidr', ...(parseCidr(c) as { net: number; bits: number }) }, action: a });
const DIRECT = act({ kind: 'direct' });
const TUNNEL = act({ kind: 'tunnel' });

test('правила: ручное сильнее загруженного, загруженное — выученного; внутри слоя точное сильнее широкого', () => {
  const sources: RuleSource[] = [
    { layer: 'learned', source: 'выученное', entries: [name('a.example.com', TUNNEL)] },
    { layer: 'loaded', source: 'список', entries: [name('a.example.com', act({ kind: 'country', country: 'DE' })), name('example.com', TUNNEL), name('www.example.com', act({ kind: 'reject' }), true)] },
    { layer: 'manual', source: 'ручное', entries: [name('example.com', DIRECT)] },
  ];
  const r = new RuleSet(sources);
  assert.equal(r.decide('b.a.example.com')?.source, 'ручное', 'ручное широкое перебивает загруженное точное');
  const loaded = new RuleSet(sources.slice(0, 2));
  assert.deepEqual(loaded.decide('x.a.example.com')?.action, act({ kind: 'country', country: 'DE' }), 'длинный суффикс сильнее короткого');
  assert.equal(loaded.decide('www.example.com')?.action.target.kind, 'reject', 'имя целиком сильнее суффикса');
  assert.equal(loaded.decide('sub.www.example.com')?.action.target.kind, 'tunnel', 'точное — только само имя');
  assert.equal(loaded.decide('EXAMPLE.com.')?.source, 'список', 'регистр и точка в конце');
  assert.equal(new RuleSet([sources[0] as RuleSource]).decide('a.example.com')?.layer, 'learned');
  assert.equal(r.decide('example.org'), null, 'не совпало — решает вход');
});

test('правила: подсети — самый длинный префикс в слое; голый адрес — как подсеть', () => {
  const r = new RuleSet([{ layer: 'loaded', source: 'сети', entries: [net('172.16.0.0/12', act({ kind: 'reject' })), net('172.16.42.0/24', act({ kind: 'only', outlets: ['corp'] }))] }]);
  assert.equal(r.decide('172.16.42.10')?.action.target.kind, 'only');
  assert.equal(r.decide('172.17.0.1')?.action.target.kind, 'reject');
  assert.equal(r.decideIp(ipv4ToInt('8.8.8.8') as number), null);
  assert.deepEqual(r.onlyNets().map((x) => x.outlets), [['corp']]);
});

test('куда: правило → требование к выходу; просьба страны телефона сильнее, «запретить» и «только» — сильнее её', () => {
  const r = new RuleSet([{ layer: 'manual', source: 'мои', entries: [
    name('gosuslugi.ru', act({ kind: 'country', country: 'RU' })), name('openai.com', act({ kind: 'avoid', countries: ['RU'] }, true)),
    name('ads.example', act({ kind: 'reject' })), name('local.example', DIRECT), net('172.16.42.0/24', act({ kind: 'only', outlets: ['corp'] })),
  ] }]);
  assert.deepEqual(routeFor(r, 'www.gosuslugi.ru').need, { country: 'RU' });
  assert.deepEqual(routeFor(r, 'chat.openai.com').need, { avoid: ['RU'], fastest: true });
  assert.deepEqual(routeFor(r, 'local.example').need, { direct: true });
  assert.deepEqual(routeFor(r, 'example.org').need, {}, 'не совпало — туннели, как раньше');
  assert.deepEqual(routeFor(r, 'gosuslugi.ru', { country: 'DE' }).need, { country: 'DE' }, 'телефон сам выбрал страну');
  assert.equal(routeFor(r, 'ads.example', { country: 'DE' }).reject, true);
  const corp = routeFor(r, '172.16.42.7', { country: 'DE' });
  assert.deepEqual([corp.need, corp.fenceException], [{ only: ['corp'] }, true], 'корпоративная сеть — только своими туннелями, и только она проходит ограду');
  assert.equal(routeFor(r, '172.16.1.1').fenceException, false);
});

test('сервис: основной домен по публичным суффиксам, частные — тоже', () => {
  assert.equal(domainService('a.b.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(domainService('chatgpt.com'), 'chatgpt.com');
  assert.notEqual(domainService('x.github.io'), domainService('y.github.io'));
  assert.equal(domainService('1.2.3.4'), '1.2.3.4');
});

test('книга: встроенные источники с тем же поведением; набор для DNS — файлом; список страны — только где есть выход', () => {
  const dns = tmp('contour-dns-');
  writeFileSync(path.join(dns, 'blocked-domains.lst'), 'instagram.com\n');
  writeFileSync(path.join(dns, 'overrides.json'), JSON.stringify({ 'x.com': 'direct' }));
  const dir = path.join(dns, 'rules');
  let countries = ['DE'];
  const book = new RuleBook({
    sites: new Sites({ dnsDir: dns, own: ['youtube.com'] }), subnets: () => ['91.108.4.0/22'], countries: () => countries,
    directCountry: () => 'RU', countrySites: () => ({ RU: ['alfabank.ru'] }), dir, log: quiet,
  });
  book.rebuild();
  const r = book.rules();
  assert.equal(r.decide('x.com')?.action.target.kind, 'direct');
  assert.equal(r.decide('cdn.instagram.com')?.action.target.kind, 'tunnel');
  assert.equal(r.decide('youtube.com')?.source, 'свой список');
  assert.equal(r.decide('91.108.4.1')?.source, 'подсети сервисов');
  assert.equal(r.decide('alfabank.ru'), null, 'выхода в RU нет — «через Россию» не правило, а отказ; не включаем');
  countries = ['DE', 'RU'];
  book.rebuild();
  assert.deepEqual(book.rules().decide('alfabank.ru')?.action, act({ kind: 'country', country: 'RU' }));
  // DNS: «через страну прямого выхода» — настоящие адреса, «через туннель» — наш.
  const dnsRules = new CompiledRules(dir);
  assert.deepEqual(dnsRules.dnsVia('alfabank.ru'), { tunnel: false, source: 'свои сайты RU' });
  assert.equal(dnsRules.dnsVia('instagram.com')?.tunnel, true);
  assert.equal(dnsRules.dnsVia('example.org'), null);
  assert.equal(new CompiledRules(tmp('contour-none-')).dnsVia('instagram.com'), undefined, 'набора нет — DNS решает, как раньше');
  book.stop();
});

test('шлюз: классы из правил — страна с прямым её страны, «не через», «только» с частной подсетью, запрет; имя класса одно в обоих процессах', async () => {
  const { gatewayClasses, routeOf, routeCountry } = await import('../src/rules/gateway.ts');
  const { newOutlet } = await import('../src/outlets/outlet.ts');
  const o = (name: string, priority: number, country: string, direct = false) => Object.assign(newOutlet({ name, kind: 'netns', bridge: 1, protocol: 'wireguard', conf: '/x', env: null, dns: [], mtu: null, priority, enabled: true }, 1080), { country, direct });
  const outlets = [o('home', 1000, 'RU', true), o('de2', 20, 'DE'), o('de1', 10, 'DE'), o('ru1', 5, 'RU')];
  const r = new RuleSet([{ layer: 'manual', source: 'мои', entries: [
    name('gosuslugi.ru', act({ kind: 'country', country: 'RU' })), name('openai.com', act({ kind: 'avoid', countries: ['RU'] })),
    net('172.16.42.0/24', act({ kind: 'only', outlets: ['de1', 'home'] })), name('ads.example', act({ kind: 'reject' })), name('x.com', TUNNEL), name('y.com', DIRECT),
  ] }]);
  const { classes } = gatewayClasses(r, outlets);
  assert.deepEqual(classes.map((c) => [c.name, c.outlets, c.nets ?? []]), [
    ['avoid-ru', ['de1', 'de2'], []],
    ['country-ru', ['ru1', 'home'], []],
    ['only-de1-home', ['de1'], ['172.16.42.0/24']],
    ['reject', [], []],
  ], 'туннель и «напрямую» — как до движка, без классов; прямой — никогда в «только»');
  assert.equal(routeOf(act({ kind: 'country', country: 'RU' })), 'country-ru');
  assert.equal(routeCountry('country-ru'), 'RU');
  assert.equal(routeCountry('only-de1'), undefined);
});

test('вторая ограда: частный адрес — только через выход из правила «только через», прямой — никогда', async () => {
  const { makeDial } = await import('../src/outlets/connect.ts');
  const { newOutlet } = await import('../src/outlets/outlet.ts');
  const r = new RuleSet([{ layer: 'manual', source: 'корп', entries: [net('172.16.42.0/24', act({ kind: 'only', outlets: ['corp'] }))] }]);
  const allows = (ip: string, outlet: string): boolean => {
    const d = r.decide(ip);
    return d?.match.kind === 'cidr' && d.action.target.kind === 'only' && d.action.target.outlets.includes(outlet);
  };
  const dial = makeDial({ resolve: async (_o, h) => [h] }, 100, (ip, o) => !o.direct && allows(ip, o.name));
  const mk = (name: string) => newOutlet({ name, kind: 'netns', bridge: 1, protocol: 'wireguard', conf: '/x', env: null, dns: [], mtu: null, priority: 1, enabled: true }, 1);
  await assert.rejects(dial(mk('other'), '172.16.42.2', 22), /частный адрес/, 'чужой выход — ограда');
  await assert.rejects(dial(mk('corp'), '172.16.1.1', 22), /частный адрес/, 'не та подсеть — ограда');
  await assert.rejects(dial(mk('corp'), '172.16.42.2', 22), (e: Error) => !/частный адрес/.test(e.message), 'свой выход — ограда пропускает (дальше SOCKS, которого в проверке нет)');
});
