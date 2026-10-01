import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import dnsPacket from 'dns-packet';
import { DEFAULTS, LAN_DOMAINS, parseConfig } from '../src/config.ts';
import { Consumers } from '../src/consumers.ts';
import { answerOwn } from '../src/dns/server.ts';
import { inCidr, matchesDomain } from '../src/inlets/lan-match.ts';
import { parseHttpHost, parseSni } from '../src/inlets/sni.ts';
import { newOutlet } from '../src/outlets/outlet.ts';
import { Chooser } from '../src/select/chooser.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });

/** Настоящий ClientHello от Node: поднимаем «сервер», который только слушает первые байты. */
async function clientHello(servername: string): Promise<Buffer> {
  const got = new Promise<Buffer>((resolve) => {
    const server = net.createServer((s) => {
      let buf = Buffer.alloc(0);
      s.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        if (buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3)) { resolve(buf); s.destroy(); server.close(); }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      const c = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false });
      c.on('error', () => {});
    });
  });
  return got;
}

test('SNI из настоящего ClientHello; по частям — «нужно ещё»', async () => {
  const hello = await clientHello('rr3---sn-abc.googlevideo.com');
  assert.deepEqual(parseSni(hello), { kind: 'name', name: 'rr3---sn-abc.googlevideo.com' });
  assert.deepEqual(parseSni(hello.subarray(0, 3)), { kind: 'need-more' });
  assert.deepEqual(parseSni(hello.subarray(0, hello.length - 1)), { kind: 'need-more' });
  assert.equal(parseSni(Buffer.from('GET / HTTP/1.1\r\n')).kind, 'none');
});

test('Host из http-запроса', () => {
  assert.equal(parseHttpHost(Buffer.from('GET / HTTP/1.1\r\nHost: www.YouTube.com:80\r\nAccept: */*\r\n\r\n')), 'www.youtube.com');
  assert.equal(parseHttpHost(Buffer.from('GET / HTTP/1.1\r\nHost: x')), 'need-more');
  assert.equal(parseHttpHost(Buffer.from('GET / HTTP/1.1\r\nAccept: */*\r\n\r\n')), null);
});

test('домены: сам сайт и поддомены, но не похожие имена', () => {
  assert.equal(matchesDomain('youtube.com', LAN_DOMAINS), true);
  assert.equal(matchesDomain('www.youtube.com.', LAN_DOMAINS), true);
  assert.equal(matchesDomain('rr1---sn-x.googlevideo.com', LAN_DOMAINS), true);
  assert.equal(matchesDomain('i.ytimg.com', LAN_DOMAINS), true);
  assert.equal(matchesDomain('notyoutube.com', LAN_DOMAINS), false);
  assert.equal(matchesDomain('www.googleapis.com', LAN_DOMAINS), false);
  assert.equal(matchesDomain('ya.ru', LAN_DOMAINS), false);
});

test('сеть: адрес из 192.168.0.0/24, v4-mapped тоже', () => {
  assert.equal(inCidr('192.168.0.42', '192.168.0.0/24'), true);
  assert.equal(inCidr('::ffff:192.168.0.42', '192.168.0.0/24'), true);
  assert.equal(inCidr('192.168.1.42', '192.168.0.0/24'), false);
  assert.equal(inCidr('8.8.8.8', '192.168.0.0/24'), false);
  assert.equal(inCidr('fe80::1', '192.168.0.0/24'), false);
});

test('DNS: свой A — адрес сервера, AAAA и HTTPS — пусто, остальное — не наше', () => {
  const lan = { ...DEFAULTS.lan, enabled: true };
  const ask = (name: string, type: string) =>
    dnsPacket.decode(dnsPacket.encode({ id: 7, type: 'query', flags: dnsPacket.RECURSION_DESIRED, questions: [{ name, type: type as 'A', class: 'IN' }] }));

  const a = answerOwn(ask('www.youtube.com', 'A'), lan);
  assert.ok(a);
  const ra = dnsPacket.decode(a);
  assert.equal(ra.id, 7);
  assert.deepEqual(ra.answers?.map((x) => (x as { data: string }).data), ['192.168.0.50']);

  const aaaa = answerOwn(ask('www.youtube.com', 'AAAA'), lan);
  assert.ok(aaaa);
  assert.equal(dnsPacket.decode(aaaa).answers?.length, 0);
  assert.equal(dnsPacket.decode(answerOwn(ask('youtube.com', 'UNKNOWN_65'), lan) as Buffer).answers?.length, 0);

  assert.equal(answerOwn(ask('ya.ru', 'A'), lan), null, 'чужое — к обычному DNS');
  assert.equal(answerOwn(ask('youtube.com', 'MX'), lan), null, 'другие типы своего — тоже к обычному');
});

test('настройки lan: умолчания, свои сайты добавляются, мусор — ошибка', () => {
  assert.equal(parseConfig('').lan.enabled, false);
  const c = parseConfig('lan:\n  enabled: true\n  extraDomains: [Example.COM, "*.foo.org"]\n');
  assert.equal(c.lan.enabled, true);
  assert.ok(c.lan.domains.includes('youtube.com'));
  assert.ok(c.lan.domains.includes('example.com'));
  assert.ok(c.lan.domains.includes('foo.org'));
  assert.throws(() => parseConfig('lan:\n  address: 999.1.1.1\n'), /lan\.address/);
  assert.throws(() => parseConfig('lan:\n  allow: 192.168.0.0\n'), /lan\.allow/);
  assert.throws(() => parseConfig('lan:\n  extraDomains: ["not a domain"]\n'), /не имя сайта/);
});

test('SNI-вход: имя из списка — поток через выход с проигрыванием, чужое — разрыв', async () => {
  // «Сайт»: эхо первых байт обратно — так видно, что ClientHello дошёл целиком.
  const site = net.createServer((s) => s.once('data', (c: Buffer) => { s.end(`got ${c.length}`); }));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const sitePort = (site.address() as net.AddressInfo).port;

  const dir = mkdtempSync(path.join(tmpdir(), 'contour-'));
  writeFileSync(path.join(dir, 'tokens'), '');
  const consumers = new Consumers(path.join(dir, 'tokens'), quiet);
  consumers.load();
  const fake = newOutlet({ name: 'fake', kind: 'mihomo', bridge: null, protocol: 'wireguard', conf: '/x', env: null, dns: [], mtu: null, priority: 1, enabled: true }, 1);
  fake.state = 'alive';
  const asked: string[] = [];
  const chooser = new Chooser([fake], { stickyMs: 0, connectTimeoutMs: 1000, onFailure: () => {}, log: quiet });
  chooser.connect = async (host, port) => {
    asked.push(`${host}:${port}`);
    const socket = net.connect(sitePort, '127.0.0.1');
    await new Promise<void>((r, j) => { socket.once('connect', r); socket.once('error', j); });
    return { socket, outlet: fake, failed: [] };
  };

  // «Домашняя сеть» в тесте — 127.0.0.0/8; порт 443 в тесте не взять, поэтому разбор — через serveForTest на своём порту.
  const lan = { ...DEFAULTS.lan, enabled: true, address: '127.0.0.1', allow: '127.0.0.0/8' };
  const { serveForTest } = await import('../src/inlets/lan.ts');
  const inlet = net.createServer((c) => serveForTest('tls', 443, c, lan, { chooser, consumers, log: quiet }));
  await new Promise<void>((r) => inlet.listen(0, '127.0.0.1', r));
  const inletPort = (inlet.address() as net.AddressInfo).port;

  const hello = await clientHello('www.youtube.com');
  const viaInlet = (payload: Buffer): Promise<string> => new Promise((resolve) => {
    const c = net.connect(inletPort, '127.0.0.1', () => {
      // По частям — как бывает с длинным ClientHello.
      c.write(payload.subarray(0, 10));
      setTimeout(() => c.write(payload.subarray(10)), 30);
    });
    let out = '';
    c.on('data', (d) => { out += d.toString(); });
    c.on('close', () => resolve(out));
    c.on('error', () => resolve(out));
  });

  try {
    assert.equal(await viaInlet(hello), `got ${hello.length}`);
    assert.deepEqual(asked, ['www.youtube.com:443']);
    const foreign = await clientHello('ya.ru');
    assert.equal(await viaInlet(foreign), '', 'чужой сайт — разрыв без ответа');
    assert.deepEqual(asked, ['www.youtube.com:443'], 'через выход не пошло');
  } finally {
    inlet.close(); site.close();
  }
});
