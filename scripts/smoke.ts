import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { Consumers } from '../src/consumers.ts';
import { startHttpInlet } from '../src/inlets/http-proxy.ts';
import { log } from '../src/log.ts';
import { startHealth, httpOverSocket } from '../src/outlets/health.ts';
import { runMihomo } from '../src/outlets/mihomo.ts';
import { newOutlet } from '../src/outlets/outlet.ts';
import { Chooser } from '../src/select/chooser.ts';
import { dialVia } from '../src/dial.ts';

/**
 * Живой прогон всей цепочки без VPN-ключа: mihomo с выходом `direct` вместо
 * туннеля, наш SOCKS-вход с паролем, проверка живости, выбор выхода, HTTP-прокси
 * с токеном. Проверяет всё, кроме самого WireGuard, — то есть ровно то, что
 * нельзя отлаживать на живой установке под sudo.
 *
 *   MIHOMO_BIN=~/.local/contour-smoke/mihomo node scripts/smoke.ts
 *
 * Трафик идёт напрямую с машины, не через VPN — это только проверка кода.
 */

const bin = process.env.MIHOMO_BIN;
if (!bin) { console.error('нужен MIHOMO_BIN=/путь/к/mihomo'); process.exit(2); }

const dir = mkdtempSync(path.join(tmpdir(), 'contour-smoke-'));
const port = 20_000 + Math.floor(Math.random() * 10_000);
const controller = `127.0.0.1:${port + 1}`;
const secret = randomBytes(12).toString('hex');
const outlet = newOutlet({ name: 'direct', kind: 'mihomo', protocol: 'wireguard', conf: '/x', env: null, priority: 1, enabled: true }, port);

const config = {
  mode: 'rule',
  'log-level': 'warning',
  'external-controller': controller,
  secret,
  'geo-auto-update': false,
  listeners: [{ name: 'in-direct', type: 'socks', listen: '127.0.0.1', port, proxy: 'direct', udp: false, users: [{ username: outlet.socks.user, password: outlet.socks.pass }] }],
  proxies: [{ name: 'direct', type: 'direct', udp: false }],
  rules: ['MATCH,REJECT'],
};
const configPath = path.join(dir, 'config.yaml');
writeFileSync(configPath, stringify(config), { mode: 0o600 });

const tokensPath = path.join(dir, 'tokens');
const token = randomBytes(16).toString('hex');
writeFileSync(tokensPath, `smoke:${token}\n`);

const mihomo = runMihomo({ bin, dir, configPath, controller, secret, log });
await mihomo.ready;

// 1. SOCKS-вход требует пароль.
const bad = { ...outlet, socks: { ...outlet.socks, pass: 'wrong' } };
try {
  await dialVia(bad, 'example.com', 80, 5000);
  log.error('SOCKS пустил с неверным паролем — так нельзя');
  process.exit(1);
} catch (error) {
  log.info(`SOCKS с неверным паролем отверг: ${(error as Error).message}`);
}

// 2. Через SOCKS с паролем — внешний адрес.
const s = await dialVia(outlet, 'api.ipify.org', 80, 8000);
const ip = await httpOverSocket(s, 'api.ipify.org', '/', 8000);
log.info(`через SOCKS: ${ip.status} ${ip.body.trim()}`);

// 3. Проверка живости → выход должен стать живым.
const health = startHealth([outlet], { intervalMs: 2000, connectTimeoutMs: 5000, probeHost: 'cp.cloudflare.com', probePath: '/generate_204', ipHost: 'api.ipify.org', ipIntervalMs: 1000, log });
await new Promise((r) => setTimeout(r, 2500));
log.info(`состояние выхода: ${outlet.state}, ${outlet.latencyMs} мс, внешний адрес ${outlet.externalIp}`);

// 4. HTTP-прокси с токеном: CONNECT к https-сайту через fetch с нашим прокси — руками, через curl.
const chooser = new Chooser([outlet], { stickyMs: 60_000, connectTimeoutMs: 5000, onFailure: (o) => health.recheck(o), log });
const consumers = new Consumers(tokensPath, log);
consumers.load();
const server = await startHttpInlet({ listen: '127.0.0.1', port: port + 2, chooser, consumers, log });
const { execFile } = await import('node:child_process');
const run = (args: string[]): Promise<string> => new Promise((resolve) => {
  execFile('curl', ['-sS', '--max-time', '20', ...args], (error, stdout, stderr) => resolve(error ? `ошибка: ${stderr || error.message}` : stdout));
});
const proxy = `http://smoke:${token}@127.0.0.1:${port + 2}`;
log.info(`curl без токена: ${(await run(['-o', '/dev/null', '-w', '%{http_code}', '-x', `http://127.0.0.1:${port + 2}`, 'https://api.ipify.org'])).trim()} (ждём 407)`);
log.info(`curl https через прокси: ${(await run(['-x', proxy, 'https://api.ipify.org'])).trim()}`);
log.info(`curl http через прокси: ${(await run(['-x', proxy, 'http://api.ipify.org/'])).trim()}`);
log.info(`curl в частный адрес: ${(await run(['-o', '/dev/null', '-w', '%{http_code}', '-x', proxy, 'http://192.168.0.1/'])).trim()} (ждём 403)`);
log.info(`учёт: ${JSON.stringify([...consumers.totals()])}`);

health.stop();
server.close();
server.closeAllConnections();
await mihomo.stop();
log.info('прогон закончен');
process.exit(0);
