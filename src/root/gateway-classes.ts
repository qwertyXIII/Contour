import { isIPv4 } from 'node:net';
import { formatCidr, overlaps, parseCidr, type Cidr } from '../cidr.ts';
import { DEFAULTS, type Config } from '../config.ts';
import { GATEWAY_CLASSES_FILE, GW_MARK_DIRECT, GW_MARK_VPN, GW_MAX_CLASSES, ROUTE_DIRECT, ROUTE_TUNNEL } from '../gateway.ts';
import { isPrivateV4, PRIVATE_V4 } from '../inlets/fence.ts';
import { readJson, writeJson } from '../json-file.ts';
import { classRuntime, memberPaths, prepareSlot, readConfig, retireSlot, slotMark, syncClassRoutes, type SlotClass } from './gateway-routes.ts';
import { GatewayError, hex, nft, setElements, TABLE, tableExists } from './nft.ts';
import type { GatewayClassRuntime } from './protocol.ts';
import { groupId } from './sys.ts';

/**
 * Классы маршрута шлюза — сторона помощника (что такое класс — `src/gateway.ts`).
 *
 * Движок правил присылает весь набор классов разом (`gateway.classes`), DNS —
 * адреса имени с классом (`gateway.route`). Здесь: проверка объявления, слоты
 * (номер слота — метка и таблица, `gateway-routes.ts`), наборы адресов класса в
 * nft и цепочка выбора `gw_pick`.
 *
 * Правила таблицы nft от набора классов не зависят: класс — это данные (наборы
 * `gc<слот>_dst` и `gc<слот>_net`, строки цепочки `gw_pick`, метки в
 * `direct_marks`). Поэтому объявление никогда не пересоздаёт таблицу и не
 * опустошает наборы — ни свои, ни «как сейчас».
 *
 * Адрес — ровно в одном наборе «через …»: положили в класс — он уходит из
 * остальных. Последнее решение DNS по имени и есть текущее; общий адрес двух
 * имён с разными классами (CDN) ведётся по последнему — для адресов иначе и не
 * выйдет. Подсети класса — постоянные, адрес сильнее подсети (точное сильнее
 * широкого).
 */

const CLASS_NAME = /^[a-z0-9][a-z0-9_.:-]{0,47}$/;
const OUTLET_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const COUNTRY = /^[A-Z]{2}$/;
const MAX_OUTLETS = 16;
export const MAX_NETS = 4_096;
/** Сколько адрес имени живёт в наборе после последнего ответа DNS: приложения держат адреса дольше TTL. */
const MIN_TIMEOUT_S = 3_600;
const MAX_TIMEOUT_S = 6 * 3_600;
const MAX_IPS = 32;

const cidrs = (list: Array<[string, number]>): Cidr[] => list.map(([net, bits]) => parseCidr(`${net}/${bits}`) as Cidr);
export const PRIVATE_NETS: Cidr[] = cidrs(PRIVATE_V4);
/** Чего нет смысла вести никуда ни в каком классе. Мосты 10.201/16 вырезаны ещё и в nft (`infra_dst`): корпоративные 10/8 класс принять может. */
const NEVER: Cidr[] = cidrs([['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 3]]);

export const dstSet = (slot: number): string => `gc${slot}_dst`;
export const netSet = (slot: number): string => `gc${slot}_net`;

export type DeclaredClass = Omit<SlotClass, 'slot'>;

function bad(text: string): never {
  throw new GatewayError(text);
}

function checkNets(raw: unknown, name: string, only: boolean, taken: Array<{ c: Cidr; owner: string }>): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_NETS) bad(`подсети класса «${name}» — список до ${MAX_NETS}`);
  return raw.map((n) => {
    const c = typeof n === 'string' ? parseCidr(n) : null;
    if (!c || c.bits < 8 || NEVER.some((x) => overlaps(c, x))) bad(`«${String(n)}» в классе «${name}» — не подсеть /8…/32 (или служебная)`);
    // Ограда частных адресов — везде; исключение — только подсети класса «только через выходы».
    if (!only && PRIVATE_NETS.some((p) => overlaps(c, p))) bad(`«${String(n)}» — частная подсеть: только в классе «только через выходы» (only)`);
    const clash = taken.find((t) => t.owner !== name && overlaps(t.c, c));
    if (clash) bad(`«${String(n)}» класса «${name}» пересекается с подсетью класса «${clash.owner}»: одна подсеть — один класс`);
    taken.push({ c, owner: name });
    return formatCidr(c);
  });
}

/** Объявление классов от движка правил: помощник не верит и ему — проверяет всё. */
export function checkClasses(raw: unknown, directName: string): DeclaredClass[] {
  if (!Array.isArray(raw) || raw.length > GW_MAX_CLASSES) bad(`классы — список до ${GW_MAX_CLASSES}`);
  const names = new Set<string>();
  const taken: Array<{ c: Cidr; owner: string }> = [];
  return raw.map((x): DeclaredClass => {
    const r = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    const name = r.name;
    if (typeof name !== 'string' || !CLASS_NAME.test(name)) bad('имя класса: латиница в нижнем регистре, цифры, «-», «_», «.», «:», до 48 знаков');
    if (name === ROUTE_TUNNEL || name === ROUTE_DIRECT) bad(`«${name}» — встроенный путь, а не класс`);
    if (names.has(name)) bad(`класс «${name}» — дважды`);
    names.add(name);
    if (r.only !== undefined && typeof r.only !== 'boolean') bad(`only класса «${name}» — true или false`);
    const only = r.only === true;
    const outlets = r.outlets;
    if (!Array.isArray(outlets) || outlets.length > MAX_OUTLETS || !outlets.every((o) => typeof o === 'string' && OUTLET_NAME.test(o))) {
      bad(`выходы класса «${name}» — список имён до ${MAX_OUTLETS}`);
    }
    if (new Set(outlets).size !== outlets.length) bad(`в классе «${name}» выход назван дважды`);
    if (only && outlets.includes(directName)) bad(`класс «${name}» — «только через выходы»: прямого выхода «${directName}» в нём быть не может`);
    if (r.country !== undefined && (typeof r.country !== 'string' || !COUNTRY.test(r.country))) bad(`страна класса «${name}» — две заглавные буквы (DE)`);
    const nets = checkNets(r.nets, name, only, taken);
    return { name, outlets: outlets as string[], only, ...(typeof r.country === 'string' ? { country: r.country } : {}), nets };
  });
}

/**
 * Слоты: у знакомого класса — прежний (метка его живых соединений не должна
 * вдруг вести в чужую таблицу), новому — свободный, лучше не только что
 * освобождённый. `fresh` — слоты новых классов (их набор адресов — с нуля),
 * `freed` — освобождённые и никем не занятые.
 */
export function assignSlots(prev: SlotClass[], next: DeclaredClass[]): { classes: SlotClass[]; fresh: number[]; freed: number[] } {
  const prevSlot = new Map(prev.map((c) => [c.name, c.slot]));
  const used = new Set(next.map((c) => prevSlot.get(c.name)).filter((s): s is number => s !== undefined));
  const released = prev.filter((c) => !next.some((n) => n.name === c.name)).map((c) => c.slot);
  const pick = (): number => {
    for (const avoid of [true, false]) {
      for (let s = 0; s < GW_MAX_CLASSES; s++) if (!used.has(s) && !(avoid && released.includes(s))) return s;
    }
    return bad(`классов больше ${GW_MAX_CLASSES}`);
  };
  const fresh: number[] = [];
  const classes = next.map((c) => {
    let slot = prevSlot.get(c.name);
    if (slot === undefined) {
      slot = pick();
      used.add(slot);
      fresh.push(slot);
    }
    return { ...c, slot };
  });
  return { classes, fresh, freed: released.filter((s) => !used.has(s)) };
}

/** Слоты классов, у которых в списке прямой выход: их метке можно к роутеру (`direct_marks`). */
export function directSlots(classes: SlotClass[], config: Config | null): number[] {
  return classes.filter((c) => memberPaths(c.outlets, config, c.only).includes('direct')).map((c) => c.slot);
}

/**
 * Команды nft для классов одной транзакцией: наборы, метки «можно к роутеру» и
 * цепочка выбора заново. Порядок строк `gw_pick` — порядок старшинства: служебное
 * — никуда; адреса (DNS) — раньше подсетей; подсети классов — раньше подсетей «как сейчас».
 */
export function classCommands(classes: SlotClass[], direct: number[], fresh: number[], freed: number[]): string {
  const t = `ip ${TABLE}`;
  const dstSpec = '{ type ipv4_addr; flags timeout; }';
  const netSpec = '{ type ipv4_addr; flags interval; auto-merge; }';
  const lines = [`flush chain ${t} gw_pick`];
  for (const c of classes) {
    lines.push(`add set ${t} ${dstSet(c.slot)} ${dstSpec}`, `add set ${t} ${netSet(c.slot)} ${netSpec}`);
    if (fresh.includes(c.slot)) lines.push(`flush set ${t} ${dstSet(c.slot)}`);
    lines.push(`flush set ${t} ${netSet(c.slot)}`);
    if (c.nets.length > 0) lines.push(`add element ${t} ${netSet(c.slot)} { ${c.nets.join(', ')} }`);
  }
  // add перед delete: удаление того, чего нет, сорвало бы всю транзакцию.
  for (const s of freed) lines.push(`add set ${t} ${dstSet(s)} ${dstSpec}`, `delete set ${t} ${dstSet(s)}`, `add set ${t} ${netSet(s)} ${netSpec}`, `delete set ${t} ${netSet(s)}`);
  lines.push(`flush set ${t} direct_marks`, `add element ${t} direct_marks { ${[GW_MARK_DIRECT, ...direct.map(slotMark)].map(hex).join(', ')} }`);
  const rule = (expr: string): void => { lines.push(`add rule ${t} gw_pick ${expr}`); };
  rule('ip daddr @infra_dst return');
  rule(`ip daddr @vpn_dst ct mark set ${hex(GW_MARK_VPN)} return`);
  for (const c of classes) rule(`ip daddr @${dstSet(c.slot)} ct mark set ${hex(slotMark(c.slot))} return`);
  for (const c of classes) rule(`ip daddr @${netSet(c.slot)} ct mark set ${hex(slotMark(c.slot))} return`);
  rule(`ip daddr @vpn_net ct mark set ${hex(GW_MARK_VPN)} return`);
  return `${lines.join('\n')}\n`;
}

/**
 * Адреса — в набор `target` со свежим сроком (add, delete, add — одной
 * транзакцией: add срок не продлевает) и прочь из остальных наборов «через …»
 * (add, delete — удаление отсутствующего сорвало бы транзакцию).
 */
export function allowCommands(ips: string[], ttl: number, target = 'vpn_dst', others: string[] = []): string {
  const t = `ip ${TABLE}`;
  const timeout = Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Math.round(ttl)));
  const withTimeout = ips.map((ip) => `${ip} timeout ${timeout}s`).join(', ');
  const plain = ips.join(', ');
  const lines = [`add element ${t} ${target} { ${withTimeout} }`, `delete element ${t} ${target} { ${plain} }`, `add element ${t} ${target} { ${withTimeout} }`];
  for (const o of others) lines.push(`add element ${t} ${o} { ${plain} }`, `delete element ${t} ${o} { ${plain} }`);
  return `${lines.join('\n')}\n`;
}

let state: SlotClass[] | null = null;

/** Классы помощника: из файла при первом спросе — так они переживают перезапуск и перезагрузку. */
export function currentClasses(): SlotClass[] {
  if (state) return state;
  const raw = readJson<{ classes?: Array<Record<string, unknown>> }>(GATEWAY_CLASSES_FILE, {});
  try {
    const list = Array.isArray(raw.classes) ? raw.classes : [];
    const declared = checkClasses(list, readConfig()?.direct.name ?? DEFAULTS.direct.name);
    const slots = list.map((c) => c.slot);
    const valid = slots.every((s) => Number.isInteger(s) && (s as number) >= 0 && (s as number) < GW_MAX_CLASSES) && new Set(slots).size === slots.length;
    state = valid ? declared.map((c, i) => ({ ...c, slot: slots[i] as number })) : assignSlots([], declared).classes;
  } catch {
    // файл пишет только помощник; испорчен — классов нет: адреса пойдут «как сейчас» или напрямую по режиму
    state = [];
  }
  return state;
}

/**
 * Классы из файла — в ядро после (пере)создания таблицы и при каждом подъёме
 * шлюза: правила слотов и маршруты — сразу, а текст nft gateway.ts кладёт в
 * свою транзакцию вместе с таблицей.
 */
export async function readyClasses(): Promise<{ classes: SlotClass[]; text: string }> {
  const classes = currentClasses();
  for (const c of classes) await prepareSlot(c.slot);
  if (classes.length > 0) await syncClassRoutes(classes, true);
  return { classes, text: classCommands(classes, directSlots(classes, readConfig()), [], []) };
}

/** Весь набор классов от движка правил. Не изменилось — только сверить маршруты. */
export async function declareClasses(raw: unknown): Promise<GatewayClassRuntime[]> {
  const config = readConfig();
  const prev = currentClasses();
  const { classes, fresh, freed } = assignSlots(prev, checkClasses(raw, config?.direct.name ?? DEFAULTS.direct.name));
  // Шлюз выключен (устройств нет) — только запомнить: поднимется — applyGateway возьмёт из файла.
  const live = await tableExists();
  if (JSON.stringify(classes) === JSON.stringify(prev)) return live ? syncClassRoutes(prev) : classRuntime();
  if (live) {
    // Порядок — чтобы метка никогда не вела в пустоту: правило и маршруты класса раньше,
    // чем nft начнёт её ставить; таблица снятого — к «недоступно», когда метку уже не ставят.
    for (const c of classes) await prepareSlot(c.slot);
    await syncClassRoutes(classes, true);
    await nft(classCommands(classes, directSlots(classes, config), fresh, freed));
    for (const s of freed) await retireSlot(s);
  }
  state = classes;
  writeJson(GATEWAY_CLASSES_FILE, { classes }, 0o640, { uid: 0, gid: groupId('contour') });
  return live ? classRuntime() : classes.map((c) => ({ name: c.name, slot: c.slot, outlets: c.outlets, only: c.only, country: c.country ?? null, nets: c.nets.length, via: null }));
}

function checkIps(ips: unknown): string[] {
  if (!Array.isArray(ips) || ips.length === 0 || ips.length > MAX_IPS) bad(`адреса — список от 1 до ${MAX_IPS}`);
  for (const ip of ips) if (typeof ip !== 'string' || !isIPv4(ip) || isPrivateV4(ip)) bad(`«${String(ip)}» — не публичный IPv4`);
  return ips as string[];
}

/** Адреса имени — в класс `route` (`tunnel` — «как сейчас»); зовёт contour-dns перед ответом устройству. */
export async function routeAddresses(ips: unknown, ttl: unknown, route: unknown = ROUTE_TUNNEL): Promise<void> {
  const list = checkIps(ips);
  const classes = currentClasses();
  let target = 'vpn_dst';
  if (route !== ROUTE_TUNNEL) {
    if (route === ROUTE_DIRECT) bad('«напрямую» — без набора: устройству — ответ обычного DNS');
    const c = classes.find((x) => x.name === route);
    if (!c) bad(`класса «${String(route)}» нет — сначала gateway.classes`);
    target = dstSet(c.slot);
  }
  const others = ['vpn_dst', ...classes.map((c) => dstSet(c.slot))].filter((s) => s !== target);
  await nft(allowCommands(list, typeof ttl === 'number' && Number.isFinite(ttl) ? ttl : MIN_TIMEOUT_S, target, others));
}

/**
 * Адреса наборов «через …» с остатком срока — чтобы пересоздание таблицы (новые
 * правила после install.sh) их не стёрло: DNS те же адреса снова не пришлёт ещё
 * 10 минут, и всё это время они шли бы напрямую, в блокировку.
 */
export async function keptAddresses(classes: SlotClass[]): Promise<string> {
  const lines: string[] = [];
  for (const set of ['vpn_dst', ...classes.map((c) => dstSet(c.slot))]) {
    const elems = (await setElements(set))
      .map((e) => (e as { elem?: { val?: unknown; expires?: unknown } }).elem)
      .filter((e): e is { val: string; expires: number } => typeof e?.val === 'string' && isIPv4(e.val) && !isPrivateV4(e.val) && typeof e.expires === 'number' && e.expires > 0);
    if (elems.length > 0) lines.push(`add element ip ${TABLE} ${set} { ${elems.map((e) => `${e.val} timeout ${Math.round(e.expires)}s`).join(', ')} }`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
