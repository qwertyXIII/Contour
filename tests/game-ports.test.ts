import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULTS, GAME_PORTS, parseConfig } from '../src/config.ts';
import { Consumers } from '../src/consumers.ts';
import { startGamePorts } from '../src/inlets/game-ports.ts';
import { hintSender, Hints } from '../src/inlets/hints.ts';
import { newOutlet } from '../src/outlets/outlet.ts';
import { Chooser } from '../src/select/chooser.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });
const supercell = GAME_PORTS[0]!;

test('подсказка: игровой сервер раньше картинок и магазина, даже если спрошен раньше', () => {
  const h = new Hints();
  h.add('192.168.0.110', 'game.brawlstarsgame.com', 1000);
  h.add('192.168.0.110', 'game-assets.brawlstarsgame.com', 2000);
  h.add('192.168.0.110', 'store.supercell.com', 3000);
  assert.equal(h.pick('192.168.0.110', supercell, 4000), 'game.brawlstarsgame.com');
  h.add('192.168.0.110', 'gamea.clashofclans.com', 5000);
  assert.equal(h.pick('192.168.0.110', supercell, 6000), 'gamea.clashofclans.com', 'из игровых — самое свежее');
});

test('подсказка: только имена правила, только этого устройства, только свежие', () => {
  const h = new Hints();
  h.add('192.168.0.110', 'www.youtube.com', 1000);
  assert.equal(h.pick('192.168.0.110', supercell, 2000), null, 'чужое правилу имя');
  h.add('192.168.0.103', 'game.brawlstarsgame.com', 1000);
  assert.equal(h.pick('192.168.0.110', supercell, 2000), null, 'подсказка другого устройства');
  assert.equal(h.pick('192.168.0.103', supercell, 2000), 'game.brawlstarsgame.com');
  assert.equal(h.pick('192.168.0.103', supercell, 1000 + 11 * 60_000), null, 'устарела');
});

test('подсказка: повтор имени обновляет время, а не копится', () => {
  const h = new Hints();
  for (let i = 0; i < 100; i++) h.add('192.168.0.110', `a${i}.supercell.com`, i);
  assert.equal(h.pick('192.168.0.110', { port: 1, hosts: ['a0.supercell.com'] }, 300), null, 'старые вытеснены пределом');
  assert.equal(h.pick('192.168.0.110', { port: 1, hosts: ['a99.supercell.com'] }, 300), 'a99.supercell.com');
  h.add('192.168.0.110', 'a99.supercell.com', 400);
  h.add('192.168.0.110', 'a98.supercell.com', 500);
  h.add('192.168.0.110', 'a99.supercell.com', 600);
  assert.equal(h.pick('192.168.0.110', supercell, 700), 'a99.supercell.com');
});

test('подсказка доходит от DNS датаграммой', async () => {
  const h = new Hints();
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const socket = h.listen(port, quiet);
  try {
    await new Promise<void>((r) => socket.once('listening', r));
    hintSender(port)('192.168.0.110', 'game.brawlstarsgame.com');
    for (let i = 0; i < 50 && !h.pick('192.168.0.110', supercell); i++) await sleep(10);
    assert.equal(h.pick('192.168.0.110', supercell), 'game.brawlstarsgame.com');
  } finally {
    socket.close();
  }
});

test('настройки: порты игр по умолчанию, свои — проверяются', () => {
  assert.deepEqual(parseConfig('').lan.ports, GAME_PORTS);
  assert.equal(parseConfig('').lan.hintPort, 18053);
  assert.deepEqual(parseConfig('lan:\n  ports: []\n').lan.ports, [], 'пустой список — без портов игр');
  assert.deepEqual(parseConfig('lan:\n  ports:\n    - {port: 5222, hosts: [Example.com]}\n').lan.ports, [{ port: 5222, hosts: ['example.com'] }]);
  assert.throws(() => parseConfig('lan:\n  ports:\n    - {port: 443, hosts: [example.com]}\n'), /443/);
  assert.throws(() => parseConfig('lan:\n  ports:\n    - {port: 9339, hosts: []}\n'), /hosts/);
  assert.throws(() => parseConfig('lan:\n  ports:\n    - {port: 9339}\n'), /hosts/);
  assert.throws(() => parseConfig('lan:\n  ports: 9339\n'), /lan\.ports/);
});

test('порт игры: соединение без имени ведётся к имени из подсказки; без подсказки — разрыв', async () => {
  // «Игровой сервер»: клиент говорит первым, сервер отвечает тем, что получил.
  const game = net.createServer((s) => s.once('data', (c: Buffer) => { s.end(`got ${c.toString()}`); }));
  await new Promise<void>((r) => game.listen(0, '127.0.0.1', r));
  const gamePort = (game.address() as net.AddressInfo).port;

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
    const socket = net.connect(gamePort, '127.0.0.1');
    await new Promise<void>((r, j) => { socket.once('connect', r); socket.once('error', j); });
    return { socket, outlet: fake, failed: [] };
  };

  const rulePort = 20_000 + Math.floor(Math.random() * 20_000);
  const lan = { ...DEFAULTS.lan, enabled: true, address: '127.0.0.1', allow: '127.0.0.0/8', ports: [{ port: rulePort, hosts: supercell.hosts }] };
  const hints = new Hints();
  const [server] = startGamePorts(lan, hints, { chooser, consumers, log: quiet });
  const play = (): Promise<string> => new Promise((resolve) => {
    const c = net.connect(rulePort, '127.0.0.1', () => c.write('login'));
    let out = '';
    c.on('data', (d) => { out += d.toString(); });
    c.on('close', () => resolve(out));
    c.on('error', () => resolve(out));
  });

  try {
    for (let i = 0; i < 50 && !server?.listening; i++) await sleep(10);
    assert.equal(await play(), '', 'устройство не спрашивало имя — разрыв');
    assert.deepEqual(asked, []);
    hints.add('127.0.0.1', 'game.brawlstarsgame.com');
    assert.equal(await play(), 'got login');
    assert.deepEqual(asked, [`game.brawlstarsgame.com:${rulePort}`], 'к имени из подсказки и на порт правила');
  } finally {
    server?.close(); game.close();
  }
});
