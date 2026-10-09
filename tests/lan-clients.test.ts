import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import dnsPacket from 'dns-packet';
import { DEFAULTS, parseConfig } from '../src/config.ts';
import { Consumers } from '../src/consumers.ts';
import { resolvePacket } from '../src/dns/server.ts';
import { serveForTest } from '../src/inlets/lan.ts';
import { admitted, lanClient } from '../src/inlets/lan-match.ts';
import { newOutlet } from '../src/outlets/outlet.ts';
import { Chooser, type ExitNeed } from '../src/select/chooser.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });
const CLIENT = { name: 'aiproxy', net: '10.200.0.0/30', country: 'DE' };

test('клиенты входа в настройке: имя, подсеть, страна; ошибки — словами', () => {
  const c = parseConfig('lan:\n  clients:\n    - { name: aiproxy, net: 10.200.0.0/30, country: de }\n    - { name: lab, net: 10.201.9.0/24 }\n');
  assert.deepEqual(c.lan.clients, [CLIENT, { name: 'lab', net: '10.201.9.0/24', country: null }]);
  assert.deepEqual(parseConfig('').lan.clients, []);
  assert.throws(() => parseConfig('lan:\n  clients:\n    - { name: aiproxy, net: 10.200.0.0 }\n'), /lan\.clients\[0\]\.net/);
  assert.throws(() => parseConfig('lan:\n  clients:\n    - { name: aiproxy, net: 10.200.0.0/30, country: Germany }\n'), /country/);
  assert.throws(() => parseConfig('lan:\n  clients:\n    - { name: a, net: 10.0.0.0/30 }\n    - { name: a, net: 10.0.1.0/30 }\n'), /дважды/);
  assert.throws(() => parseConfig('lan:\n  clients:\n    - { name: a, net: 10.0.0.0/30, exit: x }\n'), /неизвестное поле/);
});

test('кого пускать: домашняя сеть и подсети клиентов, больше никого', () => {
  const lan = { allow: '192.168.0.0/24', clients: [CLIENT] };
  assert.equal(lanClient('10.200.0.2', lan.clients)?.name, 'aiproxy');
  assert.equal(lanClient('::ffff:10.200.0.2', lan.clients)?.name, 'aiproxy');
  assert.equal(lanClient('192.168.0.42', lan.clients), null);
  assert.equal(admitted('192.168.0.42', lan), true);
  assert.equal(admitted('10.200.0.2', lan), true);
  assert.equal(admitted('10.200.0.6', lan), false);
});

test('DNS: клиенту входа — наш адрес на любое публичное имя, без решения и проб; местное и дом — как было', async () => {
  const lan = { ...DEFAULTS.lan, enabled: true, address: '192.168.0.50', clients: [CLIENT] };
  const decided: string[] = [];
  const deps = { lan, log: quiet, decide: async (name: string) => { decided.push(name); return { tunnel: true }; } };
  const ask = async (name: string, type: 'A' | 'AAAA', client: string) => {
    const q = dnsPacket.encode({ id: 9, type: 'query', flags: dnsPacket.RECURSION_DESIRED, questions: [{ name, type, class: 'IN' }] });
    return dnsPacket.decode(await resolvePacket(q, deps, client) as Buffer);
  };
  const a = await ask('statsig.anthropic.com', 'A', '10.200.0.2');
  assert.deepEqual(a.answers?.map((x) => ('data' in x ? x.data : null)), ['192.168.0.50']);
  assert.deepEqual((await ask('chatgpt.com', 'AAAA', '10.200.0.2')).answers, [], 'IPv6 — пусто: мимо Contour не уйти');
  assert.deepEqual(decided, [], 'клиенту — без решения по имени и без проб самообучения');
  await ask('printer.local', 'A', '10.200.0.2');
  await ask('www.youtube.com', 'A', '192.168.0.42');
  assert.deepEqual(decided, ['printer.local', 'www.youtube.com'], 'местное имя клиента и дом — обычным решением');
});

/** Ответ входа на `payload` целиком (до закрытия). */
function through(port: number, payload: Buffer): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(payload));
    let out = '';
    c.on('data', (d) => { out += d.toString(); });
    c.on('close', () => resolve(out));
    c.on('error', () => resolve(out));
  });
}

async function clientHello(servername: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve) => {
    const server = net.createServer((s) => {
      let buf = Buffer.alloc(0);
      s.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        if (buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3)) { resolve(buf); s.destroy(); server.close(); }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const c = tls.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, servername, rejectUnauthorized: false });
      c.on('error', () => {});
    });
  });
}

test('вход: клиент — со своей страной и состоянием «выход есть / нет»; не клиент и не дом — отказ', async () => {
  const site = net.createServer((s) => s.once('data', (c: Buffer) => { s.end(`got ${c.length}`); }));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const sitePort = (site.address() as net.AddressInfo).port;
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-'));
  writeFileSync(path.join(dir, 'tokens'), '');
  const consumers = new Consumers(path.join(dir, 'tokens'), quiet);
  consumers.load();
  const out = (name: string, country: string) => {
    const o = newOutlet({ name, kind: 'mihomo', bridge: null, protocol: 'wireguard', conf: '/x', env: null, dns: [], mtu: null, priority: 1, enabled: true }, 1);
    o.country = country;
    return o;
  };
  const de = out('de1', 'DE');
  const nl = out('nl', 'NL');
  de.state = 'dead';
  nl.state = 'alive';
  const chooser = new Chooser([de, nl], { stickyMs: 0, connectTimeoutMs: 1000, onFailure: () => {}, log: quiet });
  const asked: Array<{ host: string; need: ExitNeed }> = [];
  chooser.connect = async (host, _port, _exclude, need = {}) => {
    asked.push({ host, need });
    const socket = net.connect(sitePort, '127.0.0.1');
    await new Promise<void>((r, j) => { socket.once('connect', r); socket.once('error', j); });
    return { socket, outlet: de, failed: [] };
  };
  // «Клиент» в тесте — 127.0.0.0/8, домашняя сеть — чужая.
  const lan = { ...DEFAULTS.lan, enabled: true, address: '127.0.0.1', allow: '192.168.0.0/24', clients: [{ name: 'aiproxy', net: '127.0.0.0/8', country: 'DE' }] };
  const deps = { chooser, consumers, log: quiet };
  const listen = async (kind: 'tls' | 'http', l: typeof lan): Promise<net.Server> => {
    const s = net.createServer((c) => serveForTest(kind, kind === 'tls' ? 443 : 80, c, l, deps));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return s;
  };
  const http = await listen('http', lan);
  const tlsIn = await listen('tls', lan);
  const stranger = await listen('http', { ...lan, clients: [] });
  const port = (s: net.Server): number => (s.address() as net.AddressInfo).port;
  const status = Buffer.from('GET /__contour/status HTTP/1.1\r\nHost: 192.168.0.50\r\n\r\n');
  try {
    const down = await through(port(http), status);
    assert.match(down, /^HTTP\/1\.1 503 /, 'немецкий выход лёг — 503, хотя Нидерланды живы');
    assert.deepEqual(JSON.parse(down.slice(down.indexOf('{'))), { ok: false, client: 'aiproxy', country: 'DE', outlets: [{ name: 'de1', country: 'DE', state: 'dead' }] });
    de.state = 'alive';
    assert.match(await through(port(http), status), /^HTTP\/1\.1 200 [\s\S]*"ok":true/);

    const hello = await clientHello('api.anthropic.com');
    assert.equal(await through(port(tlsIn), hello), `got ${hello.length}`);
    assert.deepEqual(asked, [{ host: 'api.anthropic.com', need: { country: 'DE' } }], 'страна клиента — в требовании к выходу');

    assert.equal(await through(port(stranger), status), '', 'не клиент и не из дома — разрыв');
  } finally {
    http.close(); tlsIn.close(); stranger.close(); site.close();
  }
});
