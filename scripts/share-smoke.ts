/**
 * Раздача целиком, без root и без живого Contour: настоящий край (mihomo),
 * «телефон» — второй mihomo с выходом VLESS по WebSocket, вместо Contour —
 * подставной HTTP-прокси, который записывает, кто и куда пришёл.
 *
 *   node scripts/share-smoke.ts
 *
 * Проверяет: край принимает свой ключ и не принимает чужой; в прокси он ходит
 * под именем устройства и с его паролем; имя сайта доезжает до прокси именем
 * (край сам ничего не разрешает); правила отдаются по токену.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { stringify } from 'yaml';
import { log } from '../src/log.ts';
import { Sites } from '../src/panel/sites.ts';
import { Edge } from '../src/share/edge.ts';
import { ShareRules } from '../src/share/rules.ts';
import { startShareServer } from '../src/share/server.ts';
import { ShareStore } from '../src/share/store.ts';

const BIN = process.env.MIHOMO ?? '/opt/contour/bin/mihomo';
const P = 28_300 + Math.floor(Math.random() * 500);
const PORTS = { edge: P, edgeApi: P + 1, proxy: P + 2, list: P + 3, phone: P + 4, phoneApi: P + 5 };
const dir = mkdtempSync(path.join(tmpdir(), 'contour-share-smoke-'));
let failed = 0;
const check = (ok: boolean, what: string): void => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed += 1; };

// Подставной Contour: CONNECT с Basic, записывает имя и цель.
const seen: Array<{ who: string; target: string }> = [];
const proxy = http.createServer();
proxy.on('connect', (req, socket: net.Socket, head) => {
  const auth = Buffer.from(String(req.headers['proxy-authorization'] ?? '').replace(/^Basic /, ''), 'base64').toString();
  seen.push({ who: auth, target: req.url ?? '' });
  const [host, port] = (req.url ?? '').split(':');
  const up = net.connect(Number(port), host as string, () => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(socket); socket.pipe(up); });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
await new Promise<void>((r) => proxy.listen(PORTS.proxy, '127.0.0.1', r));

const store = new ShareStore(dir);
const phone = store.add('iPhone');
store.setDomain('c.example.ru');
const edge = new Edge({ store, bin: BIN, dir: path.join(dir, 'edge'), listen: '127.0.0.1', port: PORTS.edge, controller: `127.0.0.1:${PORTS.edgeApi}`, proxy: { host: '127.0.0.1', port: PORTS.proxy }, log });
edge.start();
await sleep(3_000);

/** «Телефон»: mihomo с VLESS к краю и SOCKS для curl. */
function startPhone(uuid: string, tag: string): ReturnType<typeof spawn> {
  const d = path.join(dir, `phone-${tag}`);
  const conf = path.join(dir, `phone-${tag}.yaml`);
  writeFileSync(conf, stringify({
    mode: 'rule', 'log-level': 'warning', ipv6: false, 'external-controller': `127.0.0.1:${PORTS.phoneApi}`, secret: 'x',
    listeners: [{ name: 'in', type: 'socks', listen: '127.0.0.1', port: PORTS.phone, udp: false, proxy: 'contour' }],
    proxies: [{ name: 'contour', type: 'vless', server: '127.0.0.1', port: PORTS.edge, uuid, network: 'ws', tls: false, udp: false, 'ws-opts': { path: store.settings().path } }],
    rules: ['MATCH,REJECT'],
  }));
  return spawn(BIN, ['-d', d, '-f', conf], { stdio: 'ignore' });
}

function curl(args: string[]): Promise<string> {
  return new Promise((resolve) => execFile('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15', ...args], (_e, out) => resolve(String(out).trim())));
}

const good = startPhone(phone.uuid, 'good');
await sleep(2_000);
check((await curl(['--socks5-hostname', `127.0.0.1:${PORTS.phone}`, 'http://example.com/'])) === '200', 'свой ключ: страница открылась через край');
check(seen.some((s) => s.who === `share.${phone.id}:${phone.uuid}` && s.target === 'example.com:80'), 'в прокси — под именем устройства, сайт — именем, не адресом');
good.kill();
await sleep(1_000);

const before = seen.length;
const bad = startPhone('00000000-0000-4000-8000-000000000000', 'bad');
await sleep(2_000);
check((await curl(['--socks5-hostname', `127.0.0.1:${PORTS.phone}`, 'http://example.com/'])) !== '200', 'чужой ключ: край не пускает');
check(seen.length === before, 'чужой ключ до прокси не доходит');
bad.kill();

const rules = new ShareRules({ sites: new Sites({ dnsDir: dir, own: ['youtube.com'] }), dnsDir: dir, skip: [] });
const server = startShareServer({ listen: '127.0.0.1', port: PORTS.list, store, rules, log });
await sleep(300);
check((await curl([`http://127.0.0.1:${PORTS.list}/list/${phone.list}/contour.conf`])) === '200', 'правила по токену');
check((await curl([`http://127.0.0.1:${PORTS.list}/list/${'A'.repeat(32)}/contour.conf`])) === '404', 'чужой токен — 404');

store.setEnabled(phone.id, false);
await sleep(2_000);
check(!edge.running(), 'выключил единственный телефон — край погашен');

server.close();
proxy.close();
await edge.stop();
console.log(failed === 0 ? 'всё в порядке' : `не прошло: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
