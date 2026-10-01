import { createHash } from 'node:crypto';
import { chownSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { MAC } from '../arp.ts';
import { formatCidr, overlaps, parseCidr, type Cidr } from '../cidr.ts';
import { GATEWAY_FILE, GATEWAY_NETS_FILE, GW_MARK_DIRECT, GW_MARK_VPN, GW_TABLE, readGateway, type GatewayMode, type GatewayState } from '../gateway.ts';
import { isPrivateV4, PRIVATE_V4 } from '../inlets/fence.ts';
import { groupId, run, runInput } from './sys.ts';

/**
 * Шлюз для устройств — сторона помощника от root (общее — `src/gateway.ts`).
 *
 * Пакеты устройства-шлюза приходят на сервер. Первый пакет соединения решает
 * его путь, и путь запоминается в conntrack (`ct mark`), а не ищется заново по
 * каждому пакету: адрес может выйти из набора «через VPN», а соединение должно
 * доехать тем же путём, каким началось.
 * - `all` — всё, кроме своих сетей, — через VPN; выход лежит — маршрута нет
 *   (`unreachable` в таблице шлюза), и ничего не уходит напрямую;
 * - `blocked` — к адресам из набора `vpn_dst` (его пополняет DNS, когда
 *   отвечает устройству на заблокированное имя) — через VPN, остальное —
 *   напрямую к роутеру с подменой адреса на адрес сервера (иначе ответы роутера
 *   шли бы мимо нас и conntrack видел бы полсоединения).
 * Через VPN — меткой в таблицу шлюза, где маршрут в мост каждого поднятого
 * выхода с метрикой-приоритетом (`deploy/contour-netns.sh`). Ответы метку не
 * получают (только исходное направление): иначе ответ устройству ушёл бы
 * обратно в туннель.
 *
 * Пересылка — только для устройств из списка: цепочка forward с политикой
 * drop. До шлюза сервер не пересылал ничего (ip_forward был 0), поэтому чужого
 * она не задевает. Редиректы ICMP выключены: иначе ядро подсказало бы
 * устройству «иди к роутеру сам» посреди соединения, и подмена адреса сломалась бы.
 */

export class GatewayError extends Error {}

const TABLE = 'contour_gw';
const RULE_PRIORITY = 2701;
/** Свои и служебные сети: ни в VPN, ни к роутеру их не пересылаем. */
const LOCAL = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/3'];
/** Сколько адрес заблокированного имени живёт в наборе после последнего ответа DNS: приложения держат адреса дольше TTL. */
const MIN_TIMEOUT_S = 3_600;
const MAX_TIMEOUT_S = 6 * 3_600;
const MAX_IPS = 32;
const APPLIED = '/run/contour/gateway.ruleset';
const hex = (n: number): string => `0x${n.toString(16)}`;

export function gatewayRuleset(iface: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(iface)) throw new GatewayError(`имя интерфейса «${iface}» странное`);
  const vpn = hex(GW_MARK_VPN);
  const direct = hex(GW_MARK_DIRECT);
  const at = `iifname "${iface}" ct state new`;
  return `table ip ${TABLE} {
  set gw_blocked { type ether_addr; }
  set gw_all { type ether_addr; }
  set vpn_dst { type ipv4_addr; flags timeout; }
  set vpn_net { type ipv4_addr; flags interval; auto-merge; }
  set gw_seen { type ether_addr; flags dynamic, timeout; timeout 10m; }
  set local_dst { type ipv4_addr; flags interval; elements = { ${LOCAL.join(', ')} } }
  chain gw_pre {
    type filter hook prerouting priority mangle; policy accept;
    iifname "${iface}" ether saddr @gw_blocked ip daddr != @local_dst update @gw_seen { ether saddr }
    iifname "${iface}" ether saddr @gw_all ip daddr != @local_dst update @gw_seen { ether saddr }
    ${at} ether saddr @gw_all ip daddr != @local_dst ct mark set ${vpn}
    ${at} ether saddr @gw_blocked ip daddr @vpn_dst ct mark set ${vpn}
    ${at} ether saddr @gw_blocked ip daddr @vpn_net ct mark set ${vpn}
    ${at} ct mark != ${vpn} ether saddr @gw_blocked ip daddr != @local_dst ct mark set ${direct}
    ct direction original ct mark ${vpn} meta mark set ${vpn}
  }
  chain gw_forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    ct mark ${vpn} oifname "ctv*" accept
    ct mark ${direct} oifname "${iface}" accept
  }
  chain gw_post {
    type nat hook postrouting priority srcnat; policy accept;
    ct mark ${vpn} oifname "ctv*" masquerade
    ct mark ${direct} oifname "${iface}" masquerade
  }
}
`;
}

/** Команды nft для наборов устройств: заменить целиком. */
export function deviceCommands(state: GatewayState): string {
  const by = (mode: GatewayMode): string[] => Object.entries(state.devices).filter(([, m]) => m === mode).map(([mac]) => mac);
  const lines = [`flush set ip ${TABLE} gw_blocked`, `flush set ip ${TABLE} gw_all`];
  for (const [set, macs] of [['gw_blocked', by('blocked')], ['gw_all', by('all')]] as const) {
    if (macs.length > 0) lines.push(`add element ip ${TABLE} ${set} { ${macs.join(', ')} }`);
  }
  return `${lines.join('\n')}\n`;
}

/** Адреса — в набор «через VPN» со свежим сроком: add, delete, add — одной транзакцией (add не продлевает срок). */
export function allowCommands(ips: string[], ttl: number): string {
  const timeout = Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Math.round(ttl)));
  const withTimeout = ips.map((ip) => `${ip} timeout ${timeout}s`).join(', ');
  return [
    `add element ip ${TABLE} vpn_dst { ${withTimeout} }`,
    `delete element ip ${TABLE} vpn_dst { ${ips.join(', ')} }`,
    `add element ip ${TABLE} vpn_dst { ${withTimeout} }`,
  ].join('\n') + '\n';
}

async function nft(text: string): Promise<void> {
  const r = await runInput('nft', ['-f', '-'], text);
  if (r.code !== 0) throw new GatewayError(`nft: ${(r.err || r.out).trim().split('\n').slice(0, 3).join(' · ')}`);
}

/** Интерфейс домашней сети — тот, где маршрут по умолчанию: при загрузке второго адреса может ещё не быть. */
export async function lanInterface(): Promise<string> {
  const r = await run('ip', ['-o', '-4', 'route', 'show', 'default']);
  const m = /\bdev (\S+)/.exec(r.out);
  if (!m) throw new GatewayError('нет маршрута по умолчанию — не понять, где домашняя сеть');
  return m[1] as string;
}

function sysctl(key: string, value: string): void {
  writeFileSync(`/proc/sys/${key.replace(/\./g, '/')}`, value);
}

async function ensureRule(): Promise<void> {
  const r = await run('ip', ['rule', 'show', 'priority', String(RULE_PRIORITY)]);
  if (!r.out.includes(`fwmark ${hex(GW_MARK_VPN)}`)) {
    const add = await run('ip', ['rule', 'add', 'priority', String(RULE_PRIORITY), 'fwmark', hex(GW_MARK_VPN), 'lookup', String(GW_TABLE)]);
    if (add.code !== 0) throw new GatewayError(`ip rule: ${add.err.trim()}`);
  }
  // Выхода нет — «недоступно», а не маршрут по умолчанию из main: через VPN или никак.
  await run('ip', ['route', 'replace', 'unreachable', 'default', 'metric', '65535', 'table', String(GW_TABLE)]);
}

/** Привести ядро к файлу: устройств нет — шлюз выключен целиком. */
export async function applyGateway(state: GatewayState = readGateway()): Promise<void> {
  if (Object.keys(state.devices).length === 0) {
    await downGateway();
    return;
  }
  const iface = await lanInterface();
  sysctl('net.ipv4.ip_forward', '1');
  sysctl('net.ipv4.conf.all.send_redirects', '0');
  sysctl(`net.ipv4.conf.${iface}.send_redirects`, '0');
  const ruleset = gatewayRuleset(iface);
  const hash = createHash('sha256').update(ruleset).digest('hex');
  const exists = (await run('nft', ['list', 'table', 'ip', TABLE])).code === 0;
  let applied = '';
  try { applied = readFileSync(APPLIED, 'utf8').trim(); } catch { /* ещё не ставили */ }
  // Пересоздаём таблицу, только когда поменялись сами правила: пересоздание опустошает набор «через VPN».
  if (!exists || applied !== hash) {
    await nft(`${exists ? `delete table ip ${TABLE}\n` : ''}${ruleset}`);
    mkdirSync(path.dirname(APPLIED), { recursive: true });
    writeFileSync(APPLIED, hash);
  }
  await nft(deviceCommands(state));
  await nft(netCommands(readNets()));
  await ensureRule();
}

const MAX_NETS = 4_096;
const PRIVATE: Cidr[] = PRIVATE_V4.map(([net, bits]) => parseCidr(`${net}/${bits}`) as Cidr);

function readNets(): string[] {
  try {
    const raw = JSON.parse(readFileSync(GATEWAY_NETS_FILE, 'utf8')) as { nets?: unknown };
    return Array.isArray(raw.nets) ? raw.nets.filter((n): n is string => typeof n === 'string' && parseCidr(n) !== null) : [];
  } catch {
    return [];
  }
}

export function netCommands(nets: string[]): string {
  const lines = [`flush set ip ${TABLE} vpn_net`];
  if (nets.length > 0) lines.push(`add element ip ${TABLE} vpn_net { ${nets.join(', ')} }`);
  return `${lines.join('\n')}\n`;
}

/** Подсети «через VPN» для режима `blocked` (от DNS): проверить, сохранить у себя, положить в набор. */
export async function setNets(cidrs: unknown): Promise<number> {
  if (!Array.isArray(cidrs) || cidrs.length > MAX_NETS) throw new GatewayError(`подсети — список до ${MAX_NETS}`);
  const nets: string[] = [];
  for (const raw of cidrs) {
    const c = typeof raw === 'string' ? parseCidr(raw) : null;
    if (!c || c.bits < 8 || PRIVATE.some((p) => overlaps(c, p))) throw new GatewayError(`«${String(raw)}» — не публичная подсеть /8…/32`);
    nets.push(formatCidr(c));
  }
  mkdirSync(path.dirname(GATEWAY_NETS_FILE), { recursive: true });
  const tmp = `${GATEWAY_NETS_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ nets })}\n`, { mode: 0o640 });
  chownSync(tmp, 0, groupId('contour'));
  renameSync(tmp, GATEWAY_NETS_FILE);
  if ((await run('nft', ['list', 'table', 'ip', TABLE])).code === 0) await nft(netCommands(nets));
  return nets.length;
}

export async function downGateway(): Promise<void> {
  await run('nft', ['delete', 'table', 'ip', TABLE]);
  for (let i = 0; i < 5; i++) if ((await run('ip', ['rule', 'del', 'priority', String(RULE_PRIORITY)])).code !== 0) break;
  sysctl('net.ipv4.ip_forward', '0');
  sysctl('net.ipv4.conf.all.send_redirects', '1');
  rmSync(APPLIED, { force: true });
}

function writeState(state: GatewayState): void {
  mkdirSync(path.dirname(GATEWAY_FILE), { recursive: true });
  const tmp = `${GATEWAY_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o640 });
  chownSync(tmp, 0, groupId('contour'));
  renameSync(tmp, GATEWAY_FILE);
}

/** Режим устройства: null — выключить шлюз для него. */
export async function setDeviceMode(mac: unknown, mode: unknown): Promise<GatewayState> {
  const m = typeof mac === 'string' ? mac.toLowerCase() : '';
  if (!MAC.test(m)) throw new GatewayError('MAC вида aa:bb:cc:dd:ee:ff');
  if (mode !== null && mode !== 'blocked' && mode !== 'all') throw new GatewayError('режим — blocked, all или null');
  const state = readGateway();
  if (mode === null) delete state.devices[m];
  else state.devices[m] = mode;
  writeState(state);
  await applyGateway(state);
  return state;
}

/**
 * Кто из устройств-шлюзов на деле шлёт пакеты через сервер (набор `gw_seen`,
 * 10 минут после последнего пакета в чужую сеть). Отметка в панели — ещё не
 * шлюз: пока на устройстве маршрутизатор — роутер, настоящие адреса
 * заблокированного ему отдавать нельзя — пакеты уйдут мимо нас, прямо в блокировку.
 */
export async function seenDevices(): Promise<string[]> {
  const r = await run('nft', ['-j', 'list', 'set', 'ip', TABLE, 'gw_seen']);
  if (r.code !== 0) return [];
  try {
    const items = (JSON.parse(r.out) as { nftables?: Array<{ set?: { elem?: unknown[] } }> }).nftables ?? [];
    const elems = items.flatMap((i) => i.set?.elem ?? []);
    return elems.map((e) => (typeof e === 'string' ? e : (e as { elem?: { val?: unknown } }).elem?.val)).filter((m): m is string => typeof m === 'string' && MAC.test(m));
  } catch {
    return [];
  }
}

/** Адреса заблокированного имени — в набор «через VPN» (зовёт contour-dns перед ответом устройству). */
export async function allowAddresses(ips: unknown, ttl: unknown): Promise<void> {
  if (!Array.isArray(ips) || ips.length === 0 || ips.length > MAX_IPS) throw new GatewayError(`адреса — список от 1 до ${MAX_IPS}`);
  for (const ip of ips) {
    if (typeof ip !== 'string' || !isIPv4(ip) || isPrivateV4(ip)) throw new GatewayError(`«${String(ip)}» — не публичный IPv4`);
  }
  const t = typeof ttl === 'number' && Number.isFinite(ttl) ? ttl : MIN_TIMEOUT_S;
  await nft(allowCommands(ips as string[], t));
}
