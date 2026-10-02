/**
 * Раздача целиком, без root и без живого Contour: настоящий край (mihomo),
 * «телефон» — второй mihomo с выходом VLESS по WebSocket, вместо Contour —
 * подставной HTTP-прокси, который записывает, кто и куда пришёл, вместо
 * выхода для UDP — mihomo-SOCKS той же формы, что внутри namespace
 * (`contour-netns.sh`: UDP, DNS, ограда), только без туннеля.
 *
 *   node scripts/share-smoke.ts
 *
 * Проверяет: край принимает свой ключ и не принимает чужой; в прокси он ходит
 * под именем устройства и с его паролем; имя сайта доезжает до прокси именем
 * (край сам ничего не разрешает); UDP доходит до интернета и обратно (DNS к
 * 1.1.1.1), а к частным адресам — нет, ни адресом, ни именем; правила отдаются
 * по токену.
 */
import { execFile, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import dnsPacket from 'dns-packet';
import { stringify } from 'yaml';
import { PRIVATE_V4 } from '../src/inlets/fence.ts';
import { log } from '../src/log.ts';
import { Edge } from '../src/share/edge.ts';
import { RuleSet } from '../src/rules/engine.ts';
import { startShareServer } from '../src/share/server.ts';
import { ShareStore } from '../src/share/store.ts';

const BIN = process.env.MIHOMO ?? '/opt/contour/bin/mihomo';
const P = 28_300 + Math.floor(Math.random() * 500);
const PORTS = { edge: P, edgeApi: P + 1, proxy: P + 2, list: P + 3, phone: P + 4, phoneApi: P + 5, outlet: P + 6, echo: P + 7 };
const dir = mkdtempSync(path.join(tmpdir(), 'contour-share-smoke-'));
let failed = 0;
const check = (ok: boolean, what: string): void => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed += 1; };

// Подставной Contour: CONNECT с Basic, записывает имя и цель.
const seen: Array<{ who: string; target: string; exit?: string }> = [];
const proxy = http.createServer();
proxy.on('connect', (req, socket: net.Socket, head) => {
  const auth = Buffer.from(String(req.headers['proxy-authorization'] ?? '').replace(/^Basic /, ''), 'base64').toString();
  seen.push({ who: auth, target: req.url ?? '', exit: req.headers['contour-exit'] as string | undefined });
  const [host, port] = (req.url ?? '').split(':');
  const up = net.connect(Number(port), host as string, () => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(socket); socket.pipe(up); });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
await new Promise<void>((r) => proxy.listen(PORTS.proxy, '127.0.0.1', r));

// Подставной выход для UDP: SOCKS с UDP, своим DNS и оградой — как внутри namespace.
const outletConf = path.join(dir, 'outlet.yaml');
writeFileSync(outletConf, stringify({
  mode: 'rule', 'log-level': 'warning', ipv6: false, 'geo-auto-update': false,
  dns: { enable: true, ipv6: false, nameserver: ['1.1.1.1', '8.8.8.8'] },
  listeners: [{ name: 'in', type: 'socks', listen: '127.0.0.1', port: PORTS.outlet, udp: true, users: [{ username: 'fake', password: 'fake-pass' }] }],
  rules: [...PRIVATE_V4.map(([net, bits]) => `IP-CIDR,${net}/${bits},REJECT`), 'MATCH,DIRECT'],
}));
const outlet = spawn(BIN, ['-d', path.join(dir, 'outlet'), '-f', outletConf], { stdio: 'ignore' });
// Эхо на 127.0.0.1 — до него UDP с телефона дойти не должен.
const echo = dgram.createSocket('udp4');
let echoed = 0;
echo.on('message', (m, r) => { echoed += 1; echo.send(m, r.port, r.address); });
await new Promise<void>((r) => echo.bind(PORTS.echo, '127.0.0.1', r));

const store = new ShareStore(dir);
const phone = store.setCountry(store.add('iPhone').id, 'RU', true);
store.setDomain('c.example.ru');
const udp = [{ name: 'fake', socks: { host: '127.0.0.1', port: PORTS.outlet, user: 'fake', pass: 'fake-pass' } }];
const edge = new Edge({ store, bin: BIN, dir: path.join(dir, 'edge'), listen: '127.0.0.1', port: PORTS.edge, controller: `127.0.0.1:${PORTS.edgeApi}`, proxy: { host: '127.0.0.1', port: PORTS.proxy }, udp: () => udp, countries: () => [{ code: 'RU', udp: [{ name: 'home', direct: true, socks: { host: '', port: 0, user: '', pass: '' } }] }], probeUrl: 'http://cp.cloudflare.com/generate_204', log });
edge.start();
await sleep(3_000);

/** «Телефон»: mihomo с VLESS к краю и SOCKS для curl. */
function startPhone(uuid: string, tag: string): ReturnType<typeof spawn> {
  const d = path.join(dir, `phone-${tag}`);
  const conf = path.join(dir, `phone-${tag}.yaml`);
  writeFileSync(conf, stringify({
    mode: 'rule', 'log-level': 'warning', ipv6: false, 'external-controller': `127.0.0.1:${PORTS.phoneApi}`, secret: 'x',
    listeners: [{ name: 'in', type: 'socks', listen: '127.0.0.1', port: PORTS.phone, udp: true, proxy: 'contour' }],
    proxies: [{ name: 'contour', type: 'vless', server: '127.0.0.1', port: PORTS.edge, uuid, network: 'ws', tls: false, udp: true, 'ws-opts': { path: store.settings().path } }],
    rules: ['MATCH,REJECT'],
  }));
  return spawn(BIN, ['-d', d, '-f', conf], { stdio: 'ignore' });
}

function curl(args: string[]): Promise<string> {
  return new Promise((resolve) => execFile('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15', ...args], (_e, out) => resolve(String(out).trim())));
}

/** UDP через SOCKS «телефона» (UDP ASSOCIATE): адрес — IPv4 или имя; ответ или null за `ms`. */
async function socksUdp(target: { ip?: string; name?: string; port: number }, payload: Buffer, ms = 6_000): Promise<Buffer | null> {
  const tcp = net.connect(PORTS.phone, '127.0.0.1');
  const read = (): Promise<Buffer> => new Promise((r) => tcp.once('data', r));
  await new Promise((r) => tcp.once('connect', r));
  tcp.write(Buffer.from([5, 1, 0]));
  await read();
  tcp.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
  const rep = await read();
  const relayPort = rep.readUInt16BE(8);
  const head = target.ip
    ? Buffer.from([0, 0, 0, 1, ...target.ip.split('.').map(Number), target.port >> 8, target.port & 255])
    : Buffer.concat([Buffer.from([0, 0, 0, 3, (target.name as string).length]), Buffer.from(target.name as string), Buffer.from([target.port >> 8, target.port & 255])]);
  const sock = dgram.createSocket('udp4');
  const answer = new Promise<Buffer | null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    sock.once('message', (m) => { clearTimeout(t); resolve(m.subarray(10)); });
  });
  sock.send(Buffer.concat([head, payload]), relayPort, '127.0.0.1');
  const out = await answer;
  sock.close();
  tcp.destroy();
  return out;
}

const good = startPhone(phone.uuid, 'good');
await sleep(4_000);
check((await curl(['--socks5-hostname', `127.0.0.1:${PORTS.phone}`, 'http://example.com/'])) === '200', 'свой ключ: страница открылась через край');
check(seen.some((s) => s.who === `share.${phone.id}:${phone.uuid}` && s.target === 'example.com:80'), 'в прокси — под именем устройства, сайт — именем, не адресом');
const query = dnsPacket.encode({ id: 7, type: 'query', flags: dnsPacket.RECURSION_DESIRED, questions: [{ name: 'example.com', type: 'A', class: 'IN' }] });
const dnsAnswer = await socksUdp({ ip: '1.1.1.1', port: 53 }, query);
check(dnsAnswer !== null && (dnsPacket.decode(dnsAnswer).answers?.length ?? 0) > 0, 'UDP: DNS к 1.1.1.1 через край и выход — ответ пришёл');
check((await socksUdp({ ip: '127.0.0.1', port: PORTS.echo }, Buffer.from('ping'), 3_000)) === null && echoed === 0, 'UDP к 127.0.0.1 — ограда, до эха не дошло');
check((await socksUdp({ name: 'localhost', port: PORTS.echo }, Buffer.from('ping'), 3_000)) === null && echoed === 0, 'UDP к «localhost» по имени — тоже ограда');
good.kill();
await sleep(1_000);

// Второй сервер — «Contour-RU»: TCP в прокси с заголовком страны, UDP — напрямую с края (выход в России — дом).
const ru = startPhone(phone.exits.RU as string, 'ru');
await sleep(4_000);
const seenBefore = seen.length;
check((await curl(['--socks5-hostname', `127.0.0.1:${PORTS.phone}`, 'http://example.com/'])) === '200', 'сервер страны: страница открылась');
check(seen.slice(seenBefore).some((s) => s.who === `share.${phone.id}:${phone.uuid}` && s.exit === 'RU'), 'сервер страны: в прокси с Contour-Exit: RU, под тем же именем устройства');
const ruDns = await socksUdp({ ip: '1.1.1.1', port: 53 }, query);
check(ruDns !== null && (dnsPacket.decode(ruDns).answers?.length ?? 0) > 0, 'сервер страны: UDP напрямую с края — ответ пришёл');
check((await socksUdp({ ip: '127.0.0.1', port: PORTS.echo }, Buffer.from('ping'), 3_000)) === null && echoed === 0, 'сервер страны: UDP к 127.0.0.1 — ограда края (без ограды выхода)');
ru.kill();
await sleep(1_000);

const before = seen.length;
const bad = startPhone('00000000-0000-4000-8000-000000000000', 'bad');
await sleep(2_000);
check((await curl(['--socks5-hostname', `127.0.0.1:${PORTS.phone}`, 'http://example.com/'])) !== '200', 'чужой ключ: край не пускает');
check(seen.length === before, 'чужой ключ до прокси не доходит');
bad.kill();

const rules = new RuleSet([{ layer: 'loaded', source: 'проверка', entries: [
  { match: { kind: 'domain', name: 'youtube.com', exact: false }, action: { target: { kind: 'tunnel' } } },
  { match: { kind: 'domain', name: 'gosuslugi.ru', exact: false }, action: { target: { kind: 'country', country: 'RU' } } },
] }]);
const server = startShareServer({ listen: '127.0.0.1', port: PORTS.list, store, rules: () => rules, allowed: null, log });
await sleep(300);
check((await curl([`http://127.0.0.1:${PORTS.list}/list/${phone.list}/contour.conf`])) === '200', 'правила по токену');
check((await curl([`http://127.0.0.1:${PORTS.list}/list/${phone.list}/country-ru.list`])) === '200', 'список страны по токену');
check((await curl([`http://127.0.0.1:${PORTS.list}/list/${phone.list}/servers`])) === '200', 'подписка по токену');
check((await curl([`http://127.0.0.1:${PORTS.list}/list/${'A'.repeat(32)}/contour.conf`])) === '404', 'чужой токен — 404');

store.setEnabled(phone.id, false);
await sleep(2_000);
check(!edge.running(), 'выключил единственный телефон — край погашен');

server.close();
proxy.close();
echo.close();
outlet.kill();
await edge.stop();
console.log(failed === 0 ? 'всё в порядке' : `не прошло: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
