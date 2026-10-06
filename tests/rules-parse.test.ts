import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCidr } from '../src/cidr.ts';
import { countryCode, parseSection } from '../src/rules/contour-format.ts';
import { detectFormat, parseRuleList, type ParseResult } from '../src/rules/parse.ts';
import type { Action, Entry } from '../src/rules/types.ts';

const TUNNEL: Action = { target: { kind: 'tunnel' } };
const DE: Action = { target: { kind: 'country', country: 'DE' } };
const DIRECT: Action = { target: { kind: 'direct' } };
const REJECT: Action = { target: { kind: 'reject' } };

/** Записи коротко: `chatgpt.com`, `=openai.com` (только само), `1.2.3.0/24`; назначение — если не то, что ждали. */
function short(entries: Entry[], expected?: Action): string[] {
  return entries.map((e) => {
    const m = e.match.kind === 'cidr' ? formatCidr(e.match) : `${e.match.exact ? '=' : ''}${e.match.name}`;
    return expected && JSON.stringify(e.action) !== JSON.stringify(expected) ? `${m} → ${JSON.stringify(e.action.target)}` : m;
  });
}

const lines = (r: ParseResult, key: 'errors' | 'warnings') => r[key].map((n) => n.line);

test('простой текст: itdoginfo как есть — голое имя с поддоменами, подсети, комментарии', () => {
  // Russia/outside-raw.lst и Categories/geoblock.lst у itdoginfo/allow-domains (2026-10-02), вперемешку.
  const r = parseRuleList([
    '1018213540.rsc.cdn77.org',
    'avtodor-tr.ru',
    '# Telegram',
    '91.108.4.0/22',
    '149.154.167.99',
    '2001:67c:4e8::/48',
    '',
    '.instagram.com',
    '*.cdninstagram.com',
    '||fbcdn.net^',
    'full:www.example.com',
    'https://chatgpt.com/c/123',
    'пример.рф',
    'просто текст',
    '999.1.1.1/8',
  ].join('\n'), { action: DE });
  assert.equal(r.format, 'plain');
  assert.deepEqual(short(r.entries, DE), [
    '1018213540.rsc.cdn77.org', 'avtodor-tr.ru', '91.108.4.0/22', '149.154.167.99/32',
    'instagram.com', 'cdninstagram.com', 'fbcdn.net', '=www.example.com', 'chatgpt.com', 'xn--e1afmkfd.xn--p1ai',
  ]);
  assert.equal(r.skipped.IPv6, 1);
  assert.deepEqual(lines(r, 'errors'), [14, 15]);
  assert.equal(r.skipped['ошибка'], 2);
  assert.equal(r.errors[0]?.text, 'просто текст');
});

test('простой текст: обёртки dnsmasq, hosts, adblock', () => {
  const r = parseRuleList([
    'nftset=/bitrix.info/4#inet#fw4#vpn_domains',
    'server=/a.example/b.example/1.1.1.1',
    '0.0.0.0 ads.example.com',
    '127.0.0.1 localhost',
    '[Adblock Plus 2.0]',
    '! Title: filters',
    '@@||good.example^',
    'example.org##.banner',
  ].join('\n'));
  assert.equal(r.format, 'plain');
  assert.deepEqual(short(r.entries, TUNNEL), ['bitrix.info', 'a.example', 'b.example', 'ads.example.com']);
  assert.equal(r.skipped['hosts: местное имя'], 1);
  assert.equal(r.skipped['adblock: исключение'], 1);
  assert.equal(r.skipped['adblock: косметика'], 1);
  assert.equal(r.errors.length, 0);
});

test('частные подсети и местные имена — не в записях, а отдельно: исключение из ограды решает движок', () => {
  const r = parseRuleList('172.16.42.0/24\n10.1.2.3\n0.0.0.0/0\nbuilders.lan\nexample.com\n', { action: { target: { kind: 'only', outlets: ['corp_ext'] } } });
  assert.deepEqual(short(r.entries), ['example.com']);
  assert.deepEqual(r.fenced.map((f) => [f.line, short([f.entry])[0]]), [[1, '172.16.42.0/24'], [2, '10.1.2.3/32'], [3, '0.0.0.0/0'], [4, 'builders.lan']]);
  assert.match(r.fenced[0]?.reason ?? '', /172\.16\.0\.0\/12/);
  assert.deepEqual(r.fenced[0]?.entry.action, { target: { kind: 'only', outlets: ['corp_ext'] } }, 'назначение при записи сохраняется');
});

test('Clash: rule-provider с behavior domain — голое имя только само, `+.` — с поддоменами', () => {
  // MetaCubeX/meta-rules-dat, geo/geosite/openai.yaml.
  const r = parseRuleList([
    'payload:',
    '    - openaiapi-site.azureedge.net',
    "    - '+.chatgpt.com'",
    '    - "+.oaistatic.com"',
    '    - .crixet.com',
    '    - 91.108.4.0/22',
    '    - 2001:67c:4e8::/48',
  ].join('\n'));
  assert.equal(r.format, 'clash');
  assert.deepEqual(short(r.entries), ['=openaiapi-site.azureedge.net', 'chatgpt.com', 'oaistatic.com', 'crixet.com', '91.108.4.0/22']);
  assert.equal(r.skipped.IPv6, 1);
});

test('Clash: classical — DOMAIN точное, DOMAIN-SUFFIX, IP-CIDR с no-resolve; KEYWORD и ASN — честный пропуск', () => {
  // blackmatrix7/ios_rule_script, rule/Clash/OpenAI/OpenAI.yaml.
  const r = parseRuleList([
    '# NAME: OpenAI',
    'payload:',
    '  - DOMAIN,browser-intake-datadoghq.com',
    '  - DOMAIN-SUFFIX,chatgpt.com',
    '  - DOMAIN-KEYWORD,openai',
    '  - IP-CIDR,24.199.123.28/32,no-resolve',
    '  - IP-CIDR6,2606:4700::/32',
    '  - IP-ASN,20473',
    '  - DOMAIN-REGEX,^chat.*',
    '  - PROCESS-NAME,ChatGPT',
  ].join('\n'), { action: DE });
  assert.equal(r.format, 'clash');
  assert.deepEqual(short(r.entries, DE), ['=browser-intake-datadoghq.com', 'chatgpt.com', '24.199.123.28/32']);
  assert.deepEqual(r.skipped, { 'DOMAIN-KEYWORD': 1, IPv6: 1, 'IP-ASN': 1, 'DOMAIN-REGEX': 1, 'PROCESS-NAME': 1 });
});

test('Clash: конфиг — только `rules:`, политика строки задаёт назначение, GEOSITE — ссылка на v2fly', () => {
  const r = parseRuleList([
    'mixed-port: 7890',
    'proxies:',
    '  - name: node',
    '    type: ss',
    'rules:',
    '  - DOMAIN-SUFFIX,gosuslugi.ru,DIRECT',
    '  - DOMAIN,ads.example.com,REJECT',
    '  - DOMAIN-SUFFIX,openai.com,PROXY',
    '  - DOMAIN-SUFFIX,claude.ai,🚀 节点选择',
    '  - DOMAIN-SUFFIX,anthropic.com,🚀 节点选择',
    '  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    '  - GEOSITE,google@cn,PROXY',
    '  - AND,((DOMAIN,x.com),(NETWORK,UDP)),REJECT',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,PROXY',
  ].join('\n'), { action: DE });
  assert.equal(r.format, 'clash');
  assert.deepEqual(short(r.entries, DE), ['gosuslugi.ru → {"kind":"direct"}', '=ads.example.com → {"kind":"reject"}', 'openai.com', 'claude.ai', 'anthropic.com']);
  assert.deepEqual(r.fenced.map((f) => f.entry.action), [DIRECT], '«напрямую» в частную сеть — тоже за оградой');
  assert.deepEqual(r.includes, [{ ref: 'google', format: 'v2fly', action: DE, line: 12 }]);
  assert.equal(r.skipped['не правила'], 2, 'две строки под proxies; ключи верхнего уровня не в счёт');
  assert.deepEqual([r.skipped.AND, r.skipped.GEOIP, r.skipped.MATCH], [1, 1, 1]);
  assert.deepEqual(r.warnings.map((w) => [w.line, w.text]), [[9, '🚀 节点选择']], 'чужая группа — одно предупреждение на имя');
});

test('Clash: текстовый набор (.list) без YAML определяется по `+.`', () => {
  // MetaCubeX/meta-rules-dat, geo/geosite/openai.list.
  const r = parseRuleList('openaiapi-site.azureedge.net\n+.chatgpt.com\n+.oaistatic.com\n');
  assert.equal(r.format, 'clash');
  assert.deepEqual(short(r.entries), ['=openaiapi-site.azureedge.net', 'chatgpt.com', 'oaistatic.com']);
  // Список в одну строку: запятая внутри кавычек не делит правило.
  assert.deepEqual(short(parseRuleList("payload: ['+.a.com', 'DOMAIN,b.com', 1.2.3.0/24]\n").entries), ['a.com', '=b.com', '1.2.3.0/24']);
});

test('Shadowrocket: конфиг — только [Rule]; RULE-SET и DOMAIN-SET по адресу — ссылки с назначением строки', () => {
  // github.com/LOWERTOP/Shadowrocket, lazy.conf.
  const r = parseRuleList([
    '[General]',
    'bypass-system = true',
    'dns-server = system',
    '[Rule]',
    'RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/YouTube/YouTube.list,PROXY',
    'DOMAIN-SET,https://example.com/apple.list,DIRECT',
    'DOMAIN-SUFFIX,litix.io,PROXY',
    'DOMAIN-KEYWORD,openai,PROXY',
    'IP-CIDR,91.108.4.0/22,PROXY,no-resolve',
    'USER-AGENT,MicroMessenger*,DIRECT',
    'GEOIP,CN,DIRECT',
    'FINAL,PROXY',
    '[Host]',
    'localhost = 127.0.0.1',
  ].join('\n'), { action: DE });
  assert.equal(r.format, 'shadowrocket');
  assert.deepEqual(short(r.entries, DE), ['litix.io', '91.108.4.0/22']);
  assert.deepEqual(r.includes.map((i) => [i.format, i.action.target.kind, i.line]), [['shadowrocket', 'country', 5], ['shadowrocket', 'direct', 6]]);
  assert.equal(r.skipped['не правила'], 3);
  assert.deepEqual([r.skipped['DOMAIN-KEYWORD'], r.skipped['USER-AGENT'], r.skipped.GEOIP, r.skipped.FINAL], [1, 1, 1, 1]);
});

test('Shadowrocket: DOMAIN-SET — `.x` с поддоменами, голое — только само; определяется по точкам впереди', () => {
  // Loyalsoldier/surge-rules, release/proxy.txt: 26356 строк с точкой, 753 без.
  const text = '1password.drift.click\n3dns-1.adobe.com\n.1password.com\n.adobe.io\n.openai.com\n';
  assert.equal(detectFormat(text.split('\n')), 'shadowrocket');
  assert.deepEqual(short(parseRuleList(text).entries), ['=1password.drift.click', '=3dns-1.adobe.com', '1password.com', 'adobe.io', 'openai.com']);
  // Свой простой список с парой точек — по-прежнему простой текст: голое — с поддоменами.
  assert.equal(detectFormat('a.com\nb.com\n.c.com\n'.split('\n')), 'plain');
});

test('строки правил без обёртки (RULE-SET Shadowrocket, classical-текст Clash) — без политики, назначением загрузки', () => {
  // itdoginfo, Russia/outside-clashx.lst; Loyalsoldier, ruleset/telegramcidr.txt.
  const r = parseRuleList('DOMAIN-SUFFIX,avtodor-tr.ru\nDOMAIN-SUFFIX,bitrix.info\nIP-CIDR,91.105.192.0/23\nIP-CIDR6,2001:67c:4e8::/48\n', { action: { target: { kind: 'country', country: 'RU' } } });
  assert.equal(r.format, 'clash');
  assert.deepEqual(short(r.entries), ['avtodor-tr.ru', 'bitrix.info', '91.105.192.0/23']);
  assert.ok(r.entries.every((e) => e.action.target.kind === 'country'));
});

test('v2fly: data/openai как есть — full: точное, regexp — пропуск, атрибуты прочь, include — ссылка', () => {
  const r = parseRuleList([
    '# Main domain',
    'chatgpt.com',
    'oaistatic.com',
    'openai.com.cdn.cloudflare.net',
    'full:openaiapi-site.azureedge.net',
    'regexp:^chatgpt-async-webps-prod-\\S+-\\d+\\.webpubsub\\.azure\\.com$',
    'full:o33249.ingest.sentry.io @ads',
    'tiktokv.com @!cn',
    'keyword:openai',
    'include:anthropic',
    'chrome',
    'bad:thing',
  ].join('\n'), { action: DE });
  assert.equal(r.format, 'v2fly');
  assert.deepEqual(short(r.entries, DE), ['chatgpt.com', 'oaistatic.com', 'openai.com.cdn.cloudflare.net', '=openaiapi-site.azureedge.net', '=o33249.ingest.sentry.io', 'tiktokv.com', 'chrome']);
  assert.deepEqual(r.skipped, { 'regexp:': 1, 'keyword:': 1, 'ошибка': 1 });
  assert.deepEqual(r.includes, [{ ref: 'anthropic', format: 'v2fly', action: DE, line: 10 }]);
});

test('свой формат: разделы задают назначение, до первого — как при загрузке', () => {
  const r = parseRuleList([
    'example.org',
    '[только: corp_ext]',
    '172.16.42.0/24',
    '[через: DE, самый быстрый]',
    'openai.com',
    '[не через: RU, by]',
    'netflix.com',
    '[напрямую]',
    'gosuslugi.ru',
    '[запретить]  # реклама',
    'full:ads.example.com',
    '[через VPN]',
    'youtube.com',
    '[через: Нидерланды]',
    'spotify.com',
    '[via: uk, fastest]',
    'bbc.co.uk',
  ].join('\n'), { action: TUNNEL, countries: ['DE', 'RU', 'NL'], outlets: ['corp_ext', 'ext'] });
  assert.equal(r.format, 'contour');
  assert.deepEqual(r.entries.map((e) => [short([e])[0], e.action]), [
    ['example.org', TUNNEL],
    ['openai.com', { target: { kind: 'country', country: 'DE' }, fastest: true }],
    ['netflix.com', { target: { kind: 'avoid', countries: ['RU', 'BY'] } }],
    ['gosuslugi.ru', DIRECT],
    ['=ads.example.com', REJECT],
    ['youtube.com', TUNNEL],
    ['spotify.com', { target: { kind: 'country', country: 'NL' } }],
    ['bbc.co.uk', { target: { kind: 'country', country: 'GB' }, fastest: true }],
  ]);
  assert.deepEqual(r.fenced.map((f) => f.entry.action), [{ target: { kind: 'only', outlets: ['corp_ext'] } }]);
  assert.deepEqual(r.warnings.map((w) => [w.line, w.reason]), [[16, 'выхода в стране GB сейчас нет — эти строки будут получать отказ']]);
  assert.equal(r.errors.length, 0);
});

test('свой формат: непонятный раздел — ошибка с номером строки, строки под ним не берутся', () => {
  const r = parseRuleList('[через: DE]\na.com\n[через: DE, NL]\nb.com\nc.com\n[куда-нибудь]\nd.com\n[напрямую]\ne.com\n[только: Не Выход!]\n');
  assert.equal(r.format, 'contour');
  assert.deepEqual(short(r.entries), ['a.com', 'e.com']);
  assert.deepEqual(lines(r, 'errors'), [3, 6, 10]);
  assert.match(r.errors[0]?.reason ?? '', /одна страна/);
  assert.equal(r.skipped['под ошибочным разделом'], 3);
});

test('разделы своего формата по отдельности', () => {
  assert.deepEqual(parseSection('[через туннель, самый быстрый]'), { action: { target: { kind: 'tunnel' }, fastest: true } });
  assert.deepEqual(parseSection('[только: corp_ext, ext, ext]'), { action: { target: { kind: 'only', outlets: ['corp_ext', 'ext'] } } });
  // Как подписывает панель — так и должно читаться: переписал оттуда, а раздел ушёл в ошибку.
  assert.deepEqual(parseSection('[только через: corp_ext]'), { action: { target: { kind: 'only', outlets: ['corp_ext'] } } });
  assert.deepEqual(parseSection('[only via: corp_ext]'), { action: { target: { kind: 'only', outlets: ['corp_ext'] } } });
  assert.equal(parseRuleList('[только через: corp_ext]\nconfluence.example.com\n').entries.length, 1, 'и раздел узнаётся как свой формат');
  assert.deepEqual(parseSection('[через: vpn]'), { action: { target: { kind: 'tunnel' } } });
  assert.match(JSON.stringify(parseSection('[напрямую, самый быстрый]')), /самый быстрый/);
  assert.match(JSON.stringify(parseSection('[напрямую: DE]')), /не бывает списка/);
  assert.match(JSON.stringify(parseSection('[через: XX]')), /не страна/);
  assert.match(JSON.stringify(parseSection('[через]')), /какую страну/);
  assert.deepEqual([countryCode('de'), countryCode('Германия'), countryCode('США'), countryCode('UK'), countryCode('Narnia')], ['DE', 'DE', 'US', 'GB', null]);
});

test('повторы: тот же адрес и назначение — счётчик; другое назначение — первое остаётся, с предупреждением', () => {
  const r = parseRuleList('[через: DE]\nopenai.com\nopenai.com\nfull:openai.com\n[напрямую]\nopenai.com\n');
  assert.deepEqual(short(r.entries), ['openai.com', '=openai.com']);
  assert.equal(r.entries[0]?.action.target.kind, 'country');
  assert.equal(r.skipped['повтор'], 1);
  assert.deepEqual(lines(r, 'warnings'), [6]);
});

test('целая зона — только «с поддоменами» и только явно: `.ru`, `DOMAIN-SUFFIX,adult`; голое слово — мусор', () => {
  // Loyalsoldier/surge-rules: `DOMAIN-SUFFIX,adult` в ruleset/proxy.txt и `.amazon` в proxy.txt (DOMAIN-SET).
  assert.deepEqual(short(parseRuleList('DOMAIN-SUFFIX,adult\nDOMAIN,localhost\nDOMAIN-SUFFIX,ru,DIRECT\n').entries), ['adult', 'ru']);
  assert.deepEqual(short(parseRuleList('.amazon\n.openai.com\nchrome\n', { format: 'shadowrocket' }).entries), ['amazon', 'openai.com']);
  const plain = parseRuleList('.ru\n.рф\nru\n.lan\n');
  assert.deepEqual(short(plain.entries), ['ru', 'xn--p1ai']);
  assert.deepEqual(lines(plain, 'errors'), [3]);
  assert.deepEqual(plain.fenced.map((f) => f.line), [4], 'зона местной сети — за оградой');
});

test('распознавание формата и явный выбор', () => {
  const d = (s: string) => detectFormat(s.split('\n'));
  assert.equal(d('# список\nexample.com\n1.2.3.0/24'), 'plain');
  assert.equal(d('payload:\n  - DOMAIN,x.com'), 'clash');
  assert.equal(d('[Rule]\nDOMAIN-SUFFIX,x.com,PROXY'), 'shadowrocket');
  assert.equal(d('domain:x.com\nfull:y.com'), 'v2fly');
  assert.equal(d('x.com\n[через: DE]\ny.com'), 'contour');
  // Явный выбор сильнее: DOMAIN-SET как простой текст — голое имя с поддоменами.
  assert.deepEqual(short(parseRuleList('a.com\n.b.com\n', { format: 'plain' }).entries), ['a.com', 'b.com']);
  assert.deepEqual(short(parseRuleList('a.com\n', { format: 'shadowrocket' }).entries), ['=a.com']);
});

test('пределы: больше — отказ целиком, длинная строка — пропуск', () => {
  assert.throws(() => parseRuleList('a.com\n'.repeat(10), { maxLines: 5 }), /больше 5 строк/);
  assert.throws(() => parseRuleList('x'.repeat(2_000), { maxBytes: 1_000 }), /больше 1 КБ \(2 КБ\)/);
  const r = parseRuleList(`﻿a.com\r\n${'b'.repeat(2_000)}.com\r\nc.com\r\n`);
  assert.deepEqual(short(r.entries), ['a.com', 'c.com']);
  assert.equal(r.skipped['длинная строка'], 1);
});
