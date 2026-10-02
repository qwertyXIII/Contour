import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAC } from '../arp.ts';
import { formatCidr, overlaps, parseCidr } from '../cidr.ts';
import { GATEWAY_FILE, GATEWAY_NETS_FILE, GW_CLASS_MARK, GW_MARK_DIRECT, GW_MARK_VPN, GW_MAX_CLASSES, GW_TABLE, readGateway, ROUTE_TUNNEL, type GatewayMode, type GatewayState } from '../gateway.ts';
import { readJson, writeJson } from '../json-file.ts';
import { currentClasses, keptAddresses, MAX_NETS, PRIVATE_NETS, readyClasses, routeAddresses } from './gateway-classes.ts';
import { dropSlots, syncClassRoutes } from './gateway-routes.ts';
import { GatewayError, hex, nft, setElements, TABLE, tableExists } from './nft.ts';
import { groupId, run } from './sys.ts';

export { GatewayError } from './nft.ts';

/**
 * Шлюз для устройств — сторона помощника от root (общее — `src/gateway.ts`).
 *
 * Пакеты устройства-шлюза приходят на сервер. Первый пакет соединения решает
 * его путь, и путь запоминается в conntrack (`ct mark`), а не ищется заново по
 * каждому пакету: адрес может выйти из набора или класса, а соединение должно
 * доехать тем же путём, каким началось.
 *
 * Путь выбирает цепочка `gw_pick` (её строки — данные классов, `gateway-classes.ts`):
 * адрес из набора класса или «как сейчас» (`vpn_dst` — его пополняет DNS,
 * отвечая устройству), затем подсети классов и «как сейчас» (`vpn_net`). Не
 * выбрала — решает режим устройства:
 * - `all` — через VPN «как сейчас»; выход лежит — маршрута нет (`unreachable`
 *   в таблице 2701), и ничего не уходит напрямую;
 * - `blocked` — напрямую к роутеру с подменой адреса на адрес сервера (иначе
 *   ответы роутера шли бы мимо нас и conntrack видел бы полсоединения).
 * «Как сейчас» — меткой в таблицу 2701, где маршрут в мост каждого поднятого
 * выхода с метрикой-приоритетом (`deploy/contour-netns.sh`); класс — своей
 * меткой в свою таблицу (`gateway-routes.ts`). Ответы метку не получают (только
 * исходное направление): иначе ответ устройству ушёл бы обратно в туннель.
 *
 * Пересылка — только для устройств из списка: цепочка forward с политикой
 * drop. До шлюза сервер не пересылал ничего (ip_forward был 0), поэтому чужого
 * она не задевает. Редиректы ICMP выключены: иначе ядро подсказало бы
 * устройству «иди к роутеру сам» посреди соединения, и подмена адреса сломалась бы.
 */

const RULE_PRIORITY = 2701;
/** Свои и служебные сети: ни в VPN, ни к роутеру их не пересылаем. */
const LOCAL = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/3'];
/** Никуда даже из подсетей класса «только через выходы» (корпоративные 10/8): мосты выходов и служебное. */
const INFRA = ['0.0.0.0/8', '10.201.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/3'];
const APPLIED = '/run/contour/gateway.ruleset';

export function gatewayRuleset(iface: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(iface)) throw new GatewayError(`имя интерфейса «${iface}» странное`);
  const vpn = hex(GW_MARK_VPN);
  const direct = hex(GW_MARK_DIRECT);
  const classes = `${hex(GW_CLASS_MARK)}-${hex(GW_CLASS_MARK + GW_MAX_CLASSES - 1)}`;
  const at = `iifname "${iface}" ct state new`;
  // gw_marks — метки, что ведут таблицами шлюза («как сейчас» и классы); direct_marks —
  // каким можно к роутеру: «напрямую» и классы с прямым выходом в списке. Его наполняет
  // classCommands (всегда вместе с таблицей): ⚠️ nft 1.1.3 падает (SIGSEGV), если в одной
  // транзакции набор объявлен с elements и тут же flush — поэтому здесь он пустой.
  return `table ip ${TABLE} {
  set gw_blocked { type ether_addr; }
  set gw_all { type ether_addr; }
  set vpn_dst { type ipv4_addr; flags timeout; }
  set vpn_net { type ipv4_addr; flags interval; auto-merge; }
  set gw_seen { type ether_addr; flags dynamic, timeout; timeout 10m; }
  set local_dst { type ipv4_addr; flags interval; elements = { ${LOCAL.join(', ')} } }
  set infra_dst { type ipv4_addr; flags interval; elements = { ${INFRA.join(', ')} } }
  set gw_marks { type mark; flags interval; elements = { ${vpn}, ${classes} } }
  set direct_marks { type mark; }
  chain gw_pick {
  }
  chain gw_new_blocked {
    jump gw_pick
    ct mark @gw_marks return
    ip daddr != @local_dst ct mark set ${direct}
  }
  chain gw_new_all {
    jump gw_pick
    ct mark @gw_marks return
    ip daddr != @local_dst ct mark set ${vpn}
  }
  chain gw_pre {
    type filter hook prerouting priority mangle; policy accept;
    iifname "${iface}" ether saddr @gw_blocked ip daddr != @local_dst update @gw_seen { ether saddr }
    iifname "${iface}" ether saddr @gw_all ip daddr != @local_dst update @gw_seen { ether saddr }
    ${at} ether saddr @gw_blocked jump gw_new_blocked
    ${at} ether saddr @gw_all jump gw_new_all
    ct direction original ct mark @gw_marks meta mark set ct mark
  }
  chain gw_forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    ct mark @gw_marks oifname "ctv*" accept
    ct mark @direct_marks oifname "${iface}" accept
  }
  chain gw_post {
    type nat hook postrouting priority srcnat; policy accept;
    ct mark @gw_marks oifname "ctv*" masquerade
    ct mark @direct_marks oifname "${iface}" masquerade
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

/** Шлюз поднят этим процессом — есть что сверять по тику. */
let up = false;

/** Привести ядро к файлам: устройств нет — шлюз выключен целиком. */
export async function applyGateway(state: GatewayState = readGateway()): Promise<void> {
  if (Object.keys(state.devices).length === 0) {
    await downGateway();
    return;
  }
  const iface = await lanInterface();
  sysctl('net.ipv4.ip_forward', '1');
  sysctl('net.ipv4.conf.all.send_redirects', '0');
  sysctl(`net.ipv4.conf.${iface}.send_redirects`, '0');
  // Правила маршрутизации и таблицы — раньше меток: метка без своей таблицы ушла бы в main, то есть напрямую.
  await ensureRule();
  const { classes, text } = await readyClasses();
  const ruleset = gatewayRuleset(iface);
  const hash = createHash('sha256').update(ruleset).digest('hex');
  const exists = await tableExists();
  let applied = '';
  try { applied = readFileSync(APPLIED, 'utf8').trim(); } catch { /* ещё не ставили */ }
  // Пересоздаём таблицу, только когда поменялись сами правила, и адреса наборов переносим с остатком срока.
  if (!exists || applied !== hash) {
    const kept = exists ? await keptAddresses(classes) : '';
    await nft(`${exists ? `delete table ip ${TABLE}\n` : ''}${ruleset}${text}${kept}`);
    mkdirSync(path.dirname(APPLIED), { recursive: true });
    writeFileSync(APPLIED, hash);
  } else {
    await nft(text);
  }
  await nft(deviceCommands(state));
  await nft(netCommands(readNets()));
  up = true;
}

/** Сверка маршрутов классов — по тику помощника и после его команд над выходами (мост мог подняться). */
export async function syncGatewayRoutes(force = false): Promise<void> {
  const classes = currentClasses();
  if (up && classes.length > 0) await syncClassRoutes(classes, force);
}

function readNets(): string[] {
  const raw = readJson<{ nets?: unknown }>(GATEWAY_NETS_FILE, {});
  return Array.isArray(raw.nets) ? raw.nets.filter((n): n is string => typeof n === 'string' && parseCidr(n) !== null) : [];
}

export function netCommands(nets: string[]): string {
  const lines = [`flush set ip ${TABLE} vpn_net`];
  if (nets.length > 0) lines.push(`add element ip ${TABLE} vpn_net { ${nets.join(', ')} }`);
  return `${lines.join('\n')}\n`;
}

const owner = (): { uid: number; gid: number } => ({ uid: 0, gid: groupId('contour') });

/** Подсети «через VPN» для режима `blocked` (от DNS): проверить, сохранить у себя, положить в набор. */
export async function setNets(cidrs: unknown): Promise<number> {
  if (!Array.isArray(cidrs) || cidrs.length > MAX_NETS) throw new GatewayError(`подсети — список до ${MAX_NETS}`);
  const nets: string[] = [];
  for (const raw of cidrs) {
    const c = typeof raw === 'string' ? parseCidr(raw) : null;
    if (!c || c.bits < 8 || PRIVATE_NETS.some((p) => overlaps(c, p))) throw new GatewayError(`«${String(raw)}» — не публичная подсеть /8…/32`);
    nets.push(formatCidr(c));
  }
  writeJson(GATEWAY_NETS_FILE, { nets }, 0o640, owner());
  if (await tableExists()) await nft(netCommands(nets));
  return nets.length;
}

export async function downGateway(): Promise<void> {
  up = false;
  await run('nft', ['delete', 'table', 'ip', TABLE]);
  for (let i = 0; i < 5; i++) if ((await run('ip', ['rule', 'del', 'priority', String(RULE_PRIORITY)])).code !== 0) break;
  await dropSlots();
  sysctl('net.ipv4.ip_forward', '0');
  sysctl('net.ipv4.conf.all.send_redirects', '1');
  rmSync(APPLIED, { force: true });
}

/** Режим устройства: null — выключить шлюз для него. */
export async function setDeviceMode(mac: unknown, mode: unknown): Promise<GatewayState> {
  const m = typeof mac === 'string' ? mac.toLowerCase() : '';
  if (!MAC.test(m)) throw new GatewayError('MAC вида aa:bb:cc:dd:ee:ff');
  if (mode !== null && mode !== 'blocked' && mode !== 'all') throw new GatewayError('режим — blocked, all или null');
  const state = readGateway();
  if (mode === null) delete state.devices[m];
  else state.devices[m] = mode;
  writeJson(GATEWAY_FILE, state, 0o640, owner());
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
  const elems = await setElements('gw_seen');
  return elems.map((e) => (typeof e === 'string' ? e : (e as { elem?: { val?: unknown } }).elem?.val)).filter((m): m is string => typeof m === 'string' && MAC.test(m));
}

/** Адреса заблокированного имени — в «как сейчас» (зовёт contour-dns перед ответом устройству). */
export async function allowAddresses(ips: unknown, ttl: unknown): Promise<void> {
  await routeAddresses(ips, ttl, ROUTE_TUNNEL);
}
