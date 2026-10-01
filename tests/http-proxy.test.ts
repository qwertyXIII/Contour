import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Consumers } from '../src/consumers.ts';
import { parseAuthority, startHttpInlet } from '../src/inlets/http-proxy.ts';
import { newOutlet, type Outlet } from '../src/outlets/outlet.ts';
import { Chooser } from '../src/select/chooser.ts';
import { createLogger } from '../src/vendor/logger.js';

/**
 * Вход проверяется с поддельным выходом: локальный SOCKS5-сервер без
 * авторизации не нужен — вместо него подменяется `connect` у Chooser'а, и
 * «выход» просто соединяется напрямую с локальным сервером-целью.
 */

const quiet = createLogger({ enabled: false });
const TOKEN = '0123456789abcdef0123456789abcdef';

async function setup(): Promise<{ proxy: string; target: http.Server; close: () => void }> {
  const target = http.createServer((req, res) => {
    res.setHeader('x-seen-host', req.headers.host ?? '');
    res.end(`ok ${req.method} ${req.url}`);
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = (target.address() as net.AddressInfo).port;

  const dir = mkdtempSync(path.join(tmpdir(), 'contour-'));
  const tokens = path.join(dir, 'tokens');
  writeFileSync(tokens, `alter:${TOKEN}\n`);
  const consumers = new Consumers(tokens, quiet);
  consumers.load();

  const fake: Outlet = newOutlet({ name: 'fake', kind: 'mihomo', protocol: 'wireguard', conf: '/x', env: null, priority: 1, enabled: true }, 1);
  fake.state = 'alive';
  const chooser = new Chooser([fake], { stickyMs: 0, connectTimeoutMs: 1000, onFailure: () => {}, log: quiet });
  // Любой адрес ведёт в локальную цель — ограда при этом проверяет то, что просил клиент.
  chooser.connect = async () => {
    const socket = net.connect(targetPort, '127.0.0.1');
    await new Promise<void>((r, j) => { socket.once('connect', r); socket.once('error', j); });
    return { socket, outlet: fake, failed: [] };
  };

  const server = await startHttpInlet({ listen: '127.0.0.1', port: 0, chooser, consumers, log: quiet });
  const proxyPort = (server.address() as net.AddressInfo).port;
  return {
    proxy: `127.0.0.1:${proxyPort}`,
    target,
    close: () => { server.close(); server.closeAllConnections(); target.close(); target.closeAllConnections(); },
  };
}

function rawRequest(proxy: string, text: string): Promise<string> {
  const [host, port] = proxy.split(':') as [string, string];
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), host, () => socket.write(text));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => { data += c; });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    setTimeout(() => socket.destroy(), 1500).unref();
  });
}

const auth = `Proxy-Authorization: Basic ${Buffer.from(`alter:${TOKEN}`).toString('base64')}`;

test('без токена — 407, с токеном CONNECT открывает туннель', async () => {
  const s = await setup();
  try {
    const denied = await rawRequest(s.proxy, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    assert.match(denied, /^HTTP\/1\.1 407 /);
    assert.match(denied, /Proxy-Authenticate: Basic/);

    const ok = await rawRequest(s.proxy, `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${auth}\r\n\r\nGET /t HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n`);
    assert.match(ok, /^HTTP\/1\.1 200 Connection Established/);
    assert.match(ok, /ok GET \/t/, 'байты после 200 дошли до цели и обратно');
  } finally {
    s.close();
  }
});

test('ограда: CONNECT к частному адресу — 403', async () => {
  const s = await setup();
  try {
    const out = await rawRequest(s.proxy, `CONNECT 192.168.0.1:443 HTTP/1.1\r\n${auth}\r\n\r\n`);
    assert.match(out, /^HTTP\/1\.1 403 /);
    assert.match(out, /частный адрес/);
    const local = await rawRequest(s.proxy, `CONNECT localhost:443 HTTP/1.1\r\n${auth}\r\n\r\n`);
    assert.match(local, /^HTTP\/1\.1 403 /);
  } finally {
    s.close();
  }
});

test('проброс http: запрос уходит в цель с её Host, без Proxy-заголовков', async () => {
  const s = await setup();
  try {
    const out = await rawRequest(s.proxy, `GET http://example.com/path?q=1 HTTP/1.1\r\nHost: example.com\r\n${auth}\r\nConnection: close\r\n\r\n`);
    assert.match(out, /^HTTP\/1\.1 200 /);
    assert.match(out, /x-seen-host: example.com/);
    assert.match(out, /ok GET \/path\?q=1/);

    const https = await rawRequest(s.proxy, `GET https://example.com/ HTTP/1.1\r\n${auth}\r\nConnection: close\r\n\r\n`);
    assert.match(https, /^HTTP\/1\.1 400 /);

    const self = await rawRequest(s.proxy, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(self, /^HTTP\/1\.1 200 /);
    assert.match(self, /contour/);
  } finally {
    s.close();
  }
});

test('parseAuthority: host:port и [v6]:port', () => {
  assert.deepEqual(parseAuthority('example.com:443'), { host: 'example.com', port: 443 });
  assert.deepEqual(parseAuthority('[2001:db8::1]:8443'), { host: '2001:db8::1', port: 8443 });
  assert.equal(parseAuthority('example.com'), null);
  assert.equal(parseAuthority(''), null);
  assert.equal(parseAuthority(undefined), null);
});
