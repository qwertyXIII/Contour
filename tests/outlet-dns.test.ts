import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import dnsPacket from 'dns-packet';
import { tcpLookup } from '../src/outlets/dns-tcp.ts';
import { ResolveError } from '../src/outlets/doh.ts';
import type { Outlet } from '../src/outlets/outlet.ts';
import { OutletDns } from '../src/outlets/outlet-dns.ts';
import { Resolver } from '../src/outlets/resolver.ts';
import { InternalHints, net24, withHintNet } from '../src/rules/hints.ts';
import { parseRuleList } from '../src/rules/parse.ts';
import { parseSection, sectionText } from '../src/rules/contour-format.ts';

/** DNS по TCP: имя → адрес из `table`, неизвестное — NXDOMAIN. */
function dnsServer(table: Record<string, string>): Promise<net.Server> {
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < 2 || buf.length < 2 + buf.readUInt16BE(0)) return;
      const q = dnsPacket.decode(buf.subarray(2, 2 + buf.readUInt16BE(0)));
      const name = q.questions?.[0]?.name ?? '';
      const ip = table[name];
      s.end(dnsPacket.streamEncode({
        type: 'response', id: q.id, flags: dnsPacket.RECURSION_DESIRED | (ip ? 0 : 3), questions: q.questions,
        answers: ip ? [{ type: 'CNAME', name, ttl: 300, data: `lb.${name}` }, { type: 'A', name: `lb.${name}`, ttl: 120, data: ip }] : [],
      }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/** SOCKS5 с логином: куда просили — записать, а вести всегда в `to` (там DNS). */
function socksServer(to: number, asked: string[]): Promise<net.Server> {
  const server = net.createServer((c) => {
    let step = 0;
    c.on('data', (d: Buffer) => {
      if (step === 0) { step = 1; c.write(Buffer.from([5, 2])); return; }
      if (step === 1) { step = 2; c.write(Buffer.from([1, 0])); return; }
      if (step !== 2) return;
      step = 3;
      c.pause();
      asked.push(`${d.subarray(4, 8).join('.')}:${d.readUInt16BE(8)}`);
      const up = net.connect(to, '127.0.0.1', () => {
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        c.pipe(up).pipe(c);
        c.resume();
      });
      up.on('error', () => c.destroy());
    });
    c.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const port = (s: net.Server): number => (s.address() as AddressInfo).port;
const outlet = (name: string, socksPort: number): Outlet => ({ name, socks: { host: '127.0.0.1', port: socksPort, user: name, pass: 'p' } }) as unknown as Outlet;

test('DNS по TCP: адрес из ответа с CNAME, «имени нет» — ResolveError', async () => {
  const dns = await dnsServer({ 'confluence.example.com': '10.42.10.5' });
  try {
    const r = await tcpLookup(net.connect(port(dns), '127.0.0.1'), 'confluence.example.com');
    assert.deepEqual(r, { ips: ['10.42.10.5'], ttl: 120 });
    await assert.rejects(tcpLookup(net.connect(port(dns), '127.0.0.1'), 'nope.example.com'), ResolveError);
  } finally {
    dns.close();
  }
});

test('DNS выхода — из файла скрипта подъёма; нет файла или мусор — пусто', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'contour-odns-'));
  writeFileSync(path.join(dir, 'corp_ext'), '10.42.0.53\nне адрес\n10.42.0.54\n10.42.0.53\n');
  const d = new OutletDns(dir, 0);
  assert.deepEqual(d.servers('corp_ext'), ['10.42.0.53', '10.42.0.54']);
  assert.deepEqual(d.servers('corp_mixed'), [], 'файла нет — DNS нет');
  assert.deepEqual(d.servers('../etc'), [], 'имя выхода — только как в настройках');
});

test('резолвер: имя правила «только через» — DNS выхода через сам выход; остальные и сбой DNS — как раньше', async () => {
  const dns = await dnsServer({ 'confluence.example.com': '10.42.10.5' });
  const asked: string[] = [];
  const socks = await socksServer(port(dns), asked);
  const warned: string[] = [];
  const o = outlet('corp_ext', port(socks));
  const r = new Resolver({ internal: (x, name) => (x.name === 'corp_ext' && name === 'confluence.example.com' ? ['10.42.0.53'] : []), warn: (t) => warned.push(t) });
  try {
    assert.deepEqual(await r.resolve(o, 'Confluence.Example.com.'), ['10.42.10.5'], 'внутренний адрес от DNS выхода');
    assert.deepEqual(asked, ['10.42.0.53:53'], 'спросили DNS выхода, через выход, по TCP');
    assert.deepEqual(await r.resolve(o, '10.1.2.3'), ['10.1.2.3'], 'адрес — как есть');
    await assert.rejects(new Resolver({ internal: () => ['10.42.0.53'] }).resolve(o, 'nope.example.com'), ResolveError, '«имени нет» от DNS выхода — ответ, не повод идти в DoH');
    assert.equal(warned.length, 0);
  } finally {
    socks.close();
    dns.close();
  }
});

test('подсказка «добавь подсеть»: /24 адреса, новые наверх, покрытые правилом — прочь; строка — разделом того же назначения', () => {
  const hints = new InternalHints();
  hints.note({ name: 'a.example.com', ip: '10.42.10.5', outlet: 'corp_ext', list: 'Конфа' }, 1);
  hints.note({ name: 'b.example.com', ip: '10.20.0.7', outlet: 'corp_ext', list: 'Конфа' }, 2);
  assert.equal(net24('10.42.10.5'), '10.42.10.0/24');
  assert.deepEqual(hints.list(() => false, 3).map((h) => h.name), ['b.example.com', 'a.example.com']);
  assert.deepEqual(hints.list((h) => h.ip === '10.20.0.7', 3).map((h) => h.name), ['a.example.com'], 'подсеть уже в правиле — подсказки нет');
  assert.deepEqual(hints.list(() => false, 4 * 86_400_000), [], 'старше трёх дней — забыта');

  const action = { target: { kind: 'only' as const, outlets: ['corp_ext'] } };
  assert.equal(sectionText(action), '[только через: corp_ext]');
  assert.deepEqual(parseSection(sectionText({ ...action, fastest: true })), { action: { ...action, fastest: true } }, 'заголовок читается обратно');
  const h = { name: 'a.example.com', ip: '10.42.10.5', outlet: 'corp_ext', net: '10.42.10.0/24', list: 'Конфа', at: 1 };
  const text = withHintNet('[только через: corp_ext]\na.example.com\n\n[напрямую]\nx.ru\n', h, sectionText(action));
  const parsed = parseRuleList(text);
  // Частная подсеть разбор кладёт в `fenced` — список пускает её обратно, раз это «только через» (lists.ts).
  const net = parsed.fenced.map((f) => f.entry).find((e) => e.match.kind === 'cidr');
  assert.deepEqual(net?.action, action, 'подсеть — под тем же назначением, хотя последний раздел — «напрямую»');
  assert.equal(parsed.errors.length, 0);
});
