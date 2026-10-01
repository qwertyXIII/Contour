import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Consumers } from '../src/consumers.ts';
import { relay } from '../src/inlets/relay.ts';
import { newOutlet, type Outlet } from '../src/outlets/outlet.ts';
import { PortProbe, portRank, type PortLearner } from '../src/outlets/ports.ts';
import { Chooser } from '../src/select/chooser.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });
const mk = (name: string, priority: number): Outlet => {
  const o = newOutlet({ name, kind: 'mihomo', bridge: null, protocol: 'wireguard', conf: '/x', env: null, dns: [], mtu: null, priority, enabled: true }, 1);
  o.state = 'alive';
  return o;
};

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as net.AddressInfo).port;
}

/** «portquiz»: отвечает по HTTP; «фильтр»: принимает и сразу рвёт — как вход AmneziaWG. */
async function fakeNet(): Promise<{ quiz: number; filter: number; close: () => void }> {
  const quizServer = net.createServer((s) => s.once('data', () => s.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')));
  const filterServer = net.createServer((s) => s.destroy());
  const quiz = await listen(quizServer);
  const filter = await listen(filterServer);
  return { quiz, filter, close: () => { quizServer.close(); filterServer.close(); } };
}

test('порт решает порядок раньше приоритета; прилипание порт не перебивает', () => {
  const awg = mk('awg', 10);
  const ovpn = mk('ovpn', 50);
  awg.ports = { filter: 'filtered', pass: new Set([80, 443]), cut: new Set([9339]), checkedAt: 1 };
  ovpn.ports = { filter: 'all', pass: new Set(), cut: new Set(), checkedAt: 1 };
  assert.equal(portRank(awg, 443), 0);
  assert.equal(portRank(awg, 9339), 3, 'режет точно');
  assert.equal(portRank(awg, 27015), 2, 'режет неходовые, этот не проверяли — вероятно, режет');
  assert.equal(portRank(mk('new', 1), 9339), 1, 'не проверено');
  assert.equal(portRank(ovpn, 9339), 0);

  const chooser = new Chooser([awg, ovpn], { stickyMs: 60_000, connectTimeoutMs: 1000, onFailure: () => {}, log: quiet });
  assert.deepEqual(chooser.order('game.brawlstarsgame.com', 9339).map((o) => o.name), ['ovpn', 'awg']);
  assert.deepEqual(chooser.order('www.youtube.com', 443).map((o) => o.name), ['awg', 'ovpn'], 'на 443 — по приоритету');
  (chooser as unknown as { sticky: Map<string, unknown> }).sticky.set('game.brawlstarsgame.com', { name: 'awg', until: Date.now() + 60_000 });
  assert.deepEqual(chooser.order('game.brawlstarsgame.com', 9339).map((o) => o.name), ['ovpn', 'awg'], 'прилип к тому, кто режет порт, — не вперёд');
});

test('проверка портов: ответ сервера — пропускает, молчаливый разрыв — режет; карта переживает перезапуск', async () => {
  const fake = await fakeNet();
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-ports-'));
  const file = path.join(dir, 'outlet-ports.json');
  const cutPorts = new Set([9339, 5222, 25565]);
  const dial = async (_o: Outlet, _h: string, port: number) => {
    const s = net.connect(cutPorts.has(port) ? fake.filter : fake.quiz, '127.0.0.1');
    await new Promise<void>((r, j) => { s.once('connect', r); s.once('error', j); });
    return s;
  };
  const awg = mk('awg', 10);
  try {
    const probe = new PortProbe([awg], { dial, host: 'portquiz.net', intervalMs: 86_400_000, needed: [9339, 7777], file, log: quiet });
    assert.ok(probe.ports().includes(7777), 'порты правил — всегда в проверке');
    const r = await probe.run(awg);
    assert.equal(r?.filter, 'filtered');
    assert.deepEqual([...awg.ports.cut].sort((a, b) => a - b), [5222, 9339, 25565]);
    assert.ok(awg.ports.pass.has(443) && awg.ports.pass.has(7777));
    assert.match(probe.summary(awg), /режет порты 5222, 9339, 25565/);
    probe.stop(); // сохраняет сразу

    const again = mk('awg', 10);
    new PortProbe([again], { dial, host: 'portquiz.net', intervalMs: 86_400_000, needed: [], file, log: quiet });
    assert.equal(again.ports.filter, 'filtered', 'с диска');
    assert.ok(again.ports.cut.has(9339));

    // Другой ключ под тем же именем — карта не его.
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.outlets.awg.hash = 'другой-ключ';
    writeFileSync(file, JSON.stringify(saved));
    const replaced = mk('awg', 10);
    new PortProbe([replaced], { dial, host: 'portquiz.net', intervalMs: 86_400_000, needed: [], file, log: quiet });
    assert.equal(replaced.ports.filter, 'unknown');
  } finally {
    fake.close();
  }
});

test('проверка портов: не ответили даже 80 и 443 — вердикта нет, прежняя карта остаётся', async () => {
  const awg = mk('awg', 10);
  awg.ports = { filter: 'all', pass: new Set(), cut: new Set(), checkedAt: 5 };
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-ports-'));
  const probe = new PortProbe([awg], { dial: async () => { throw new Error('нет'); }, host: 'portquiz.net', intervalMs: 1, needed: [], file: path.join(dir, 'p.json'), log: quiet });
  assert.equal(await probe.run(awg), null);
  assert.equal(awg.ports.filter, 'all');
  assert.equal(awg.ports.checkedAt, 5);
});

test('сигналы с трафика: быстрый молчаливый разрыв — проверка порта и «режет»; ответ сайта — «пропускает»', async () => {
  const fake = await fakeNet();
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-ports-'));
  const dial = async (_o: Outlet, _h: string, port: number) => {
    const s = net.connect(port === 9339 ? fake.filter : fake.quiz, '127.0.0.1');
    await new Promise<void>((r, j) => { s.once('connect', r); s.once('error', j); });
    return s;
  };
  const awg = mk('awg', 10);
  awg.ports = { filter: 'all', pass: new Set(), cut: new Set(), checkedAt: 1 };
  const probe = new PortProbe([awg], { dial, host: 'portquiz.net', intervalMs: 86_400_000, needed: [], file: path.join(dir, 'p.json'), log: quiet });
  try {
    probe.suspect(awg, 9339);
    for (let i = 0; i < 100 && !awg.ports.cut.has(9339); i++) await sleep(10);
    assert.ok(awg.ports.cut.has(9339));
    assert.equal(awg.ports.filter, 'filtered');
    probe.confirm(awg, 9339);
    assert.ok(!awg.ports.cut.has(9339) && awg.ports.pass.has(9339));
    assert.equal(awg.ports.filter, 'all', 'больше ничего не режет');
  } finally {
    probe.stop();
    fake.close();
  }
});

test('relay: выход молча рвёт сразу после соединения — сигнал «подозрение» на этот порт', async () => {
  const fake = await fakeNet();
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-'));
  writeFileSync(path.join(dir, 'tokens'), '');
  const consumers = new Consumers(path.join(dir, 'tokens'), quiet);
  consumers.load();
  const awg = mk('awg', 10);
  const chooser = new Chooser([awg], { stickyMs: 0, connectTimeoutMs: 1000, onFailure: () => {}, log: quiet });
  chooser.connect = async (_host, _port, exclude) => {
    if (exclude?.has('awg')) throw new Error('других выходов нет');
    const socket = net.connect(fake.filter, '127.0.0.1');
    await new Promise<void>((r, j) => { socket.once('connect', r); socket.once('error', j); });
    return { socket, outlet: awg, failed: [] };
  };
  const seen: string[] = [];
  const ports: PortLearner = { suspect: (o, p) => seen.push(`suspect ${o.name}:${p}`), confirm: (o, p) => seen.push(`confirm ${o.name}:${p}`) };
  const inlet = net.createServer((c) => relay(c, Buffer.alloc(0), 'test', { host: 'game.brawlstarsgame.com', port: 9339 }, { chooser, consumers, log: quiet, ports }, { onEstablished: () => {}, onFail: () => c.destroy() }));
  const port = await listen(inlet);
  try {
    await new Promise<void>((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => c.write('login'));
      c.on('close', () => resolve());
      c.on('error', () => resolve());
    });
    assert.deepEqual(seen, ['suspect awg:9339']);
  } finally {
    inlet.close();
    fake.close();
  }
});
