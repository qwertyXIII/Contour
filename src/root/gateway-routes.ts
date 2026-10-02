import { readFileSync, statSync } from 'node:fs';
import { parseConfig, type Config } from '../config.ts';
import { GW_CLASS_MARK, GW_CLASS_TABLE, GW_MAX_CLASSES, type GatewayClass } from '../gateway.ts';
import { CONFIG_PATH } from './config-edit.ts';
import { GatewayError, hex } from './nft.ts';
import type { GatewayClassRuntime } from './protocol.ts';
import { run } from './sys.ts';

/**
 * Таблицы маршрутов классов шлюза — сторона помощника (классы — `gateway-classes.ts`).
 *
 * У класса свой слот: метка соединения → правило `fwmark → таблица`, в таблице —
 * маршрут в мост каждого поднятого выхода класса с метрикой по месту в списке и
 * `unreachable` в конце. Ядро берёт поднятый с меньшей метрикой; лёг выход —
 * ядро само снимает его маршруты вместе с мостом, и класс сразу идёт следующим
 * своим выходом — не чужим и не напрямую.
 *
 * Хозяин этих таблиц — помощник, а не `contour-netns.sh`, как у 2701: набор
 * классов — данные, которые меняются на ходу (объявляет движок правил), и держит
 * их помощник; скрипт выхода работает только в момент подъёма и читал бы JSON из
 * bash — вышло бы два писателя одних таблиц. Падение ядро отрабатывает само, а
 * подъём помощник ловит сверкой раз в несколько секунд и сразу после своих
 * команд над выходами. 2701 («как сейчас») остаётся у скрипта как было.
 */

export type SlotClass = GatewayClass & { slot: number; only: boolean; nets: string[] };
/** Путь выхода класса: мост ядерного выхода, роутер (прямой выход) или никак (выход mihomo, нет такого). */
export type MemberPath = { bridge: number } | 'direct' | null;
export type Lan = { dev: string; via: string };

const UNREACHABLE_METRIC = 65_535;
/** Полная сверка таблиц и без перемен — на случай, если маршрут сняли руками. */
const FULL_EVERY_MS = 60_000;

export const slotMark = (slot: number): number => GW_CLASS_MARK + slot;
export const slotTable = (slot: number): number => GW_CLASS_TABLE + slot;

/** Маршрут — строкой «тип|куда|через|устройство|метрика»: так их сравнивать с тем, что в ядре. */
const key = (type: string, dst: string, via: string, dev: string, metric: number): string => `${type}|${dst}|${via}|${dev}|${metric}`;

export function memberPaths(outlets: string[], config: Config | null, only: boolean): MemberPath[] {
  return outlets.map((name) => {
    const o = config?.outlets.find((x) => x.name === name);
    if (o) return o.kind === 'netns' && o.bridge !== null ? { bridge: o.bridge } : null;
    // «Только через эти выходы» — никогда напрямую, даже если прямой выход назвали.
    return !only && config?.direct.enabled && config.direct.name === name ? 'direct' : null;
  });
}

/** Какие маршруты должны быть в таблице класса: по месту в списке, в конце — «недоступно». */
export function desiredRoutes(paths: MemberPath[], up: ReadonlySet<number>, lan: Lan | null): string[] {
  const out: string[] = [];
  paths.forEach((p, i) => {
    if (p === 'direct') {
      if (lan) out.push(key('unicast', 'default', lan.via, lan.dev, i + 1));
    } else if (p && up.has(p.bridge)) {
      out.push(key('unicast', 'default', `10.201.${p.bridge}.2`, `ctv${p.bridge}`, i + 1));
    }
  });
  out.push(key('unreachable', 'default', '', '', UNREACHABLE_METRIC));
  return out;
}

/** Каким выходом класс идёт сейчас: первый живой по списку. */
export function liveVia(outlets: string[], paths: MemberPath[], up: ReadonlySet<number>, lan: Lan | null): string | null {
  const i = paths.findIndex((p) => (p === 'direct' ? lan !== null : p !== null && up.has(p.bridge)));
  return i < 0 ? null : (outlets[i] as string);
}

type JsonRoute = { type?: string; dst?: string; gateway?: string; dev?: string; metric?: number };

export function routeKeys(json: string): string[] {
  try {
    return (JSON.parse(json || '[]') as JsonRoute[]).map((r) => key(r.type ?? 'unicast', r.dst ?? 'default', r.gateway ?? '', r.dev ?? '', r.metric ?? 0));
  } catch {
    return [];
  }
}

export function planRoutes(current: string[], desired: string[]): { add: string[]; del: string[] } {
  return { add: desired.filter((k) => !current.includes(k)), del: current.filter((k) => !desired.includes(k)) };
}

export function routeArgs(k: string, table: number, verb: 'replace' | 'del'): string[] {
  const [type, dst, via, dev, metric] = k.split('|') as [string, string, string, string, string];
  return ['route', verb, ...(type === 'unicast' ? [] : [type]), dst, ...(via ? ['via', via] : []), ...(dev ? ['dev', dev] : []), 'metric', metric, 'table', String(table)];
}

/** Мосты поднятых выходов: `ctvN` включён и на нём 10.201.N.1. Мост → ifindex (пересоздан — новый номер). */
export function parseUpBridges(json: string): Map<number, number> {
  const up = new Map<number, number>();
  try {
    for (const l of JSON.parse(json || '[]') as Array<{ ifindex?: number; ifname?: string; flags?: string[]; addr_info?: Array<{ local?: string }> }>) {
      const n = Number(/^ctv(\d+)$/.exec(l.ifname ?? '')?.[1]);
      if (Number.isInteger(n) && l.flags?.includes('UP') && l.addr_info?.some((a) => a.local === `10.201.${n}.1`)) up.set(n, l.ifindex ?? 0);
    }
  } catch {
    // нечитаемо — как будто мостов нет: маршрутов не прибавим, «недоступно» останется
  }
  return up;
}

/** Роутер — маршрут по умолчанию основной таблицы с меньшей метрикой. */
export function parseLanDefault(json: string): Lan | null {
  try {
    const routes = (JSON.parse(json || '[]') as JsonRoute[]).filter((r) => r.gateway && r.dev).sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0));
    return routes[0] ? { dev: routes[0].dev as string, via: routes[0].gateway as string } : null;
  } catch {
    return null;
  }
}

let configCache: { mtime: number; config: Config } | null = null;

/** Настройки — за мостами выходов и именем прямого выхода; перечитываются по изменению файла. */
export function readConfig(): Config | null {
  try {
    const mtime = statSync(CONFIG_PATH).mtimeMs;
    if (configCache?.mtime !== mtime) configCache = { mtime, config: parseConfig(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    // нет или сломан — последние прочитанные; совсем нет — классы без путей (недоступно)
  }
  return configCache?.config ?? null;
}

/** Правило слота и «недоступно» в его таблице — до того, как nft начнёт ставить метку: метка без таблицы ушла бы в main, то есть напрямую. */
export async function prepareSlot(slot: number): Promise<void> {
  const rule = `fwmark ${hex(slotMark(slot))} lookup ${slotTable(slot)}`;
  const has = await run('ip', ['rule', 'show', 'priority', String(slotTable(slot))]);
  if (!has.out.includes(rule)) {
    const add = await run('ip', ['rule', 'add', 'priority', String(slotTable(slot)), 'fwmark', hex(slotMark(slot)), 'lookup', String(slotTable(slot))]);
    if (add.code !== 0) throw new GatewayError(`ip rule слота ${slot}: ${add.err.trim()}`);
  }
  await run('ip', ['route', 'replace', 'unreachable', 'default', 'metric', String(UNREACHABLE_METRIC), 'table', String(slotTable(slot))]);
}

/**
 * Снятый класс: таблица — одно «недоступно», правило остаётся. Соединения,
 * начатые через класс, живут в conntrack со старой меткой — без правила они
 * ушли бы основной таблицей к роутеру, то есть мимо туннеля.
 */
export async function retireSlot(slot: number): Promise<void> {
  await run('ip', ['route', 'flush', 'table', String(slotTable(slot))]);
  await run('ip', ['route', 'replace', 'unreachable', 'default', 'metric', String(UNREACHABLE_METRIC), 'table', String(slotTable(slot))]);
}

/** Шлюз выключен целиком: правила и таблицы слотов — прочь (пересылки и так нет). Только те, что есть: без шлюза помощник зовёт это при каждом запуске. */
export async function dropSlots(): Promise<void> {
  const rules = (await run('ip', ['rule', 'show'])).out;
  for (let slot = 0; slot < GW_MAX_CLASSES; slot++) {
    if (!rules.includes(`fwmark ${hex(slotMark(slot))} lookup ${slotTable(slot)}`)) continue;
    const sel = ['priority', String(slotTable(slot)), 'fwmark', hex(slotMark(slot)), 'lookup', String(slotTable(slot))];
    for (let i = 0; i < 5; i++) if ((await run('ip', ['rule', 'del', ...sel])).code !== 0) break;
    await run('ip', ['route', 'flush', 'table', String(slotTable(slot))]);
  }
  runtime = [];
  lastSig = '';
}

/** Привести таблицу к нужному: сначала добавить, потом убрать — таблица ни на миг не пустеет. */
async function syncTable(table: number, desired: string[]): Promise<boolean> {
  const current = routeKeys((await run('ip', ['-j', '-4', 'route', 'show', 'table', String(table)])).out);
  const { add, del } = planRoutes(current, desired);
  let ok = true;
  for (const k of add) if ((await run('ip', routeArgs(k, table, 'replace'))).code !== 0) ok = false;
  // Мог уже уйти под replace с той же метрикой — ошибка удаления не беда.
  for (const k of del) await run('ip', routeArgs(k, table, 'del'));
  return ok;
}

let runtime: GatewayClassRuntime[] = [];
let lastSig = '';
let lastAt = 0;

export const classRuntime = (): GatewayClassRuntime[] => runtime;

/**
 * Сверить таблицы классов с поднятыми мостами. Дёшево, когда ничего не
 * менялось: один `ip -j addr`; полностью — при переменах (мост пересоздан —
 * другой ifindex), по `force` и раз в минуту. Не вышло — повтор на следующей сверке.
 */
export async function syncClassRoutes(classes: SlotClass[], force = false): Promise<GatewayClassRuntime[]> {
  const config = readConfig();
  const up = parseUpBridges((await run('ip', ['-j', '-4', 'addr', 'show'])).out);
  const paths = classes.map((c) => memberPaths(c.outlets, config, c.only));
  const lan = paths.some((p) => p.includes('direct')) ? parseLanDefault((await run('ip', ['-j', '-4', 'route', 'show', 'default'])).out) : null;
  const sig = JSON.stringify([classes, [...up].sort((a, b) => a[0] - b[0]), lan, configCache?.mtime ?? 0]);
  if (!force && sig === lastSig && Date.now() - lastAt < FULL_EVERY_MS) return runtime;
  const bridges = new Set(up.keys());
  let ok = true;
  const next: GatewayClassRuntime[] = [];
  for (const [i, c] of classes.entries()) {
    const p = paths[i] as MemberPath[];
    if (!(await syncTable(slotTable(c.slot), desiredRoutes(p, bridges, lan)))) ok = false;
    next.push({ name: c.name, slot: c.slot, outlets: c.outlets, only: c.only, country: c.country ?? null, nets: c.nets.length, via: liveVia(c.outlets, p, bridges, lan) });
  }
  runtime = next;
  lastAt = Date.now();
  lastSig = ok ? sig : '';
  return runtime;
}
