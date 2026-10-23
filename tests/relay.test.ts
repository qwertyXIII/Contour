import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Consumers } from '../src/consumers.ts';
import { IDLE_GRACE_MS, relay } from '../src/inlets/relay.ts';
import { newOutlet, type Outlet } from '../src/outlets/outlet.ts';
import { Chooser } from '../src/select/chooser.ts';
import { createLogger } from '../src/vendor/logger.js';

/**
 * Поток через выход на настоящих сокетах: «выходы» — локальные серверы, Chooser
 * соединяется с ними через `dial`. Проверяется то, из-за чего сервисы
 * «телепортировались» (владелец 2026-10-23): повтор уходил в другую страну,
 * прилипание ставилось до ответа сайта, простой считался отказом.
 */

const quiet = createLogger({ enabled: false });

type Kind = 'echo' | 'mute' | 'idle';

async function serve(kind: Kind): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((s) => {
    if (kind === 'mute') { s.destroy(); return; }
    if (kind === 'idle') { setTimeout(() => s.destroy(), IDLE_GRACE_MS + 300); s.on('error', () => {}); return; }
    s.on('data', () => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
    s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

function mk(name: string, priority: number, country: string): Outlet {
  const o = newOutlet({ name, kind: 'mihomo', bridge: null, protocol: 'wireguard', conf: '/x', env: null, dns: [], mtu: null, priority, enabled: true }, 1);
  o.state = 'alive';
  o.country = country;
  return o;
}

async function setup(outlets: Array<[Outlet, Kind]>): Promise<{ chooser: Chooser; dialed: string[]; failures: string[]; ask: (send: boolean) => Promise<string>; close: () => void }> {
  const ports = new Map<string, number>();
  const closers: Array<() => void> = [];
  for (const [o, kind] of outlets) { const s = await serve(kind); ports.set(o.name, s.port); closers.push(s.close); }
  const dialed: string[] = [];
  const failures: string[] = [];
  const chooser = new Chooser(outlets.map(([o]) => o), {
    stickyMs: 3_600_000, connectTimeoutMs: 1000, onFailure: (o) => failures.push(o.name), log: quiet,
    dial: async (o) => {
      dialed.push(o.name);
      const socket = net.connect(ports.get(o.name) as number, '127.0.0.1');
      await new Promise<void>((r, j) => { socket.once('connect', r); socket.once('error', j); });
      return socket;
    },
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-'));
  writeFileSync(path.join(dir, 'tokens'), '');
  const consumers = new Consumers(path.join(dir, 'tokens'), quiet);
  consumers.load();
  const inlet = net.createServer((client) => relay(client, Buffer.alloc(0), 'test', { host: 'chatgpt.com', port: 443 }, { chooser, consumers, log: quiet }, { onEstablished: () => {}, onFail: () => client.destroy() }));
  await new Promise<void>((r) => inlet.listen(0, '127.0.0.1', r));
  const inletPort = (inlet.address() as net.AddressInfo).port;
  const ask = (send: boolean): Promise<string> => new Promise((resolve) => {
    const socket = net.connect(inletPort, '127.0.0.1', () => { if (send) socket.write('GET / HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n'); });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => { data += c; });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
  });
  return { chooser, dialed, failures, ask, close: () => { inlet.close(); for (const c of closers) c(); } };
}

test('повтор не уходит в другую страну: свой выход закрыл молча — другой той же страны, а чужой страны — никогда', async () => {
  const s = await setup([[mk('de-bad', 1, 'DE'), 'mute'], [mk('nl', 2, 'NL'), 'echo'], [mk('de-good', 3, 'DE'), 'echo']]);
  try {
    assert.match(await s.ask(true), /200 OK[\s\S]*ok$/);
    assert.deepEqual(s.dialed, ['de-bad', 'de-good'], 'нидерландский выход приоритетнее, но страна соединения — DE');
    assert.deepEqual(s.failures, ['de-bad']);
    assert.equal(s.chooser.stickyCount(), 1, 'сайт ответил — сервис прилип к DE');
  } finally {
    s.close();
  }
  const lone = await setup([[mk('de-bad', 1, 'DE'), 'mute'], [mk('nl', 2, 'NL'), 'echo']]);
  try {
    assert.equal(await lone.ask(true), '', 'в DE больше некому — клиенту закрытие, а не ответ из Нидерландов');
    assert.deepEqual(lone.dialed, ['de-bad']);
    assert.equal(lone.chooser.stickyCount(), 0, 'сайт не ответил — никуда не прилипли');
  } finally {
    lone.close();
  }
});

test('простой — не отказ: клиент ничего не прислал, сайт закрыл позже — без повтора и без перепроверки выхода', async () => {
  const s = await setup([[mk('de', 1, 'DE'), 'idle'], [mk('de2', 2, 'DE'), 'echo']]);
  try {
    assert.equal(await s.ask(false), '');
    assert.deepEqual(s.dialed, ['de'], 'второй выход не трогали');
    assert.deepEqual(s.failures, [], 'выход не отправлен на перепроверку');
  } finally {
    s.close();
  }
});
