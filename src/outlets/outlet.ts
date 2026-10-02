import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config, OutletConfig } from '../config.ts';
import { describeLink, parseLink, type MihomoProxy } from './links.ts';
import { unknownPorts, type PortsInfo } from './ports.ts';
import { describeProfile, readWgProfile, type WgProfile } from './profile.ts';

/**
 * Выход — один туннель, в который можно соединиться через локальный SOCKS.
 *
 * Для входов и выбора выхода (`select/`) выход — только адрес SOCKS и
 * состояние; кто его поднял (mihomo сегодня, namespace с OpenVPN завтра) —
 * дело `outlets/`. Пароль на SOCKS — потому что на машине живут чужие
 * приложения, и `127.0.0.1:10800` без пароля был бы бесплатным туннелем для
 * любого из них в обход токенов.
 */

/** `standby` — запасной в группе соперников: не поднят, ждёт, пока работающий упадёт (rivals.ts). */
export type OutletState = 'unknown' | 'alive' | 'dead' | 'standby';

export type Outlet = {
  name: string;
  priority: number;
  socks: { host: string; port: number; user: string; pass: string };
  state: OutletState;
  latencyMs: number | null;
  /** Проверок подряд без успеха. */
  failures: number;
  lastError: string | null;
  externalIp: string | null;
  checkedAt: number | null;
  /** Какие порты выход пропускает (`ports.ts`). */
  ports: PortsInfo;
  /** Отпечаток ключа: тот же выход после перезапуска или новый ключ под старым именем. */
  confHash: string | null;
  /** Прямой выход — интернет самого сервера (`config.direct`): соединение без SOCKS. */
  direct: boolean;
  /** Только когда просят его страну: без просьбы выбор выхода его не видит. */
  onRequest: boolean;
  /** Страна выхода (`NL`): из настроек или по внешнему адресу; null — ещё не узнали. */
  country: string | null;
  /** Страна задана руками — по адресу не переписывается. */
  countryFixed: boolean;
};

/** sha256 файла ключа; не прочитать (в тестах — выдуманный путь) — null. */
function confHash(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Выход mihomo: что нужно, чтобы вписать его в конфиг ядра. Ровно одно из трёх. */
export type MihomoOutlet = {
  outlet: Outlet;
  config: OutletConfig;
  profile?: WgProfile;
  link?: MihomoProxy;
  subscription?: string;
};

/** Группа соперников выходу не нужна — её ведёт `rivals.ts`; поэтому необязательна. */
export function newOutlet(config: Omit<OutletConfig, 'group'> & { group?: string | null }, socksPort: number, socks?: Outlet['socks']): Outlet {
  return {
    name: config.name,
    priority: config.priority,
    socks: socks ?? { host: '127.0.0.1', port: socksPort, user: config.name, pass: randomBytes(18).toString('hex') },
    state: 'unknown',
    latencyMs: null,
    failures: 0,
    lastError: null,
    externalIp: null,
    checkedAt: null,
    ports: unknownPorts(),
    confHash: confHash(config.conf),
    direct: false,
    onRequest: false,
    country: config.country ?? null,
    countryFixed: Boolean(config.country),
  };
}

/** Прямой выход: SOCKS ему не нужен — `dialVia` соединяется сам. */
function directOutlet(d: Config['direct']): Outlet {
  const o = newOutlet({ name: d.name, kind: 'netns', bridge: null, protocol: 'wireguard', conf: '', env: null, dns: [], mtu: null, priority: d.priority, enabled: true, country: d.country }, 0, { host: '', port: 0, user: '', pass: '' });
  return { ...o, direct: true, onRequest: d.onRequest };
}

/**
 * Читает профили включённых выходов и раздаёт им порты SOCKS.
 * Плохой профиль — ошибка старта, а не молча пропущенный выход: иначе
 * «туннель не работает» обнаружится по 502, а не по строке в логе при запуске.
 */
export type Prepared = {
  /** Все включённые выходы — для выбора и проверки. */
  outlets: Outlet[];
  /** Те, что поднимает mihomo, — для его конфига. */
  mihomo: MihomoOutlet[];
  /** Строка о каждом для лога запуска, без ключей. */
  lines: string[];
};

/** Порт SOCKS внутри namespace выхода — один на всех, адреса у мостов разные. */
export const NETNS_SOCKS_PORT = 1080;

/** Мост выхода netns: `.1` — хост, `.2` — внутри. Тот же расчёт в deploy/contour-netns.sh. */
export function bridgeAddress(bridge: number): string {
  return `10.201.${bridge}.2`;
}

/**
 * Пароль SOCKS выхода netns — файл `<имя>.socks` рядом с ключом. Его создаёт
 * root-часть (contour-netns.sh), когда поднимает выход; Contour только читает.
 */
function netnsPassword(oc: Pick<OutletConfig, 'name' | 'conf'>): string {
  const file = path.join(path.dirname(oc.conf), `${oc.name}.socks`);
  let pass: string;
  try {
    pass = readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new Error(`нет пароля SOCKS ${file} — выход ещё не поднимали (systemctl start contour-netns@${oc.name}): ${(error as Error).message}`);
  }
  if (pass.length < 16) throw new Error(`пароль SOCKS в ${file} короче 16 знаков`);
  return pass;
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new Error(`не прочитать ${file}: ${(error as Error).message}`);
  }
}

/** Сервер из .ovpn — для строки в логе; ключи и сертификаты не трогаем. */
function describeOvpn(file: string): string {
  const m = /^\s*remote\s+(\S+)(?:\s+(\d+))?/m.exec(readText(file));
  return m ? `OpenVPN, ${m[1]}:${m[2] ?? 1194}` : 'OpenVPN';
}

/**
 * Пароль SOCKS запасного выхода появляется, только когда его впервые подняли, —
 * поэтому у выхода в группе его может не быть при запуске Contour: тогда пусто,
 * а `reloadNetnsPassword` перечитает после подъёма.
 */
export function reloadNetnsPassword(outlet: Outlet, oc: Pick<OutletConfig, 'name' | 'conf'>): void {
  outlet.socks.pass = netnsPassword(oc);
}

function prepareNetns(oc: OutletConfig, prepared: Prepared): void {
  const what = oc.protocol === 'openvpn' ? describeOvpn(oc.conf) : describeProfile(readWgProfile(oc.conf, oc.env));
  let pass = '';
  try {
    pass = netnsPassword(oc);
  } catch (error) {
    if (oc.group === null) throw error;
  }
  const host = bridgeAddress(oc.bridge as number);
  prepared.outlets.push(newOutlet(oc, NETNS_SOCKS_PORT, { host, port: NETNS_SOCKS_PORT, user: oc.name, pass }));
  prepared.lines.push(`выход «${oc.name}» (ядро, namespace): ${what} → SOCKS ${host}:${NETNS_SOCKS_PORT}`);
}

function prepareMihomo(oc: OutletConfig, port: number, prepared: Prepared): void {
  const item: MihomoOutlet = { outlet: newOutlet(oc, port), config: oc };
  let what: string;
  if (oc.protocol === 'link') {
    item.link = parseLink(readText(oc.conf));
    what = describeLink(item.link);
  } else if (oc.protocol === 'subscription') {
    item.subscription = readText(oc.conf);
    if (!/^https?:\/\/\S+$/.test(item.subscription)) throw new Error('в файле подписки не ссылка http(s)');
    what = `подписка ${new URL(item.subscription).host}`;
  } else {
    item.profile = readWgProfile(oc.conf, oc.env);
    what = describeProfile(item.profile);
  }
  prepared.outlets.push(item.outlet);
  prepared.mihomo.push(item);
  prepared.lines.push(`выход «${oc.name}» (mihomo): ${what} → SOCKS :${port}`);
}

/**
 * Прямой выход «по просьбе» — только когда есть туннели. Нет ни одного (сервер
 * друга в Нидерландах, где ничего не заблокировано), — он сам основной: иначе
 * без просьбы страны соединению некуда идти (владелец, 2026-10-02).
 */
export function prepareOutlets(config: Config): Prepared {
  const prepared: Prepared = { outlets: [], mihomo: [], lines: [] };
  for (const oc of config.outlets) {
    if (!oc.enabled) continue;
    try {
      if (oc.kind === 'netns') prepareNetns(oc, prepared);
      else prepareMihomo(oc, config.mihomo.socksBase + prepared.mihomo.length, prepared);
    } catch (error) {
      throw new Error(`выход «${oc.name}»: ${(error as Error).message}`);
    }
  }
  if (config.direct.enabled) {
    const onRequest = config.direct.onRequest && prepared.outlets.length > 0;
    prepared.outlets.unshift(directOutlet({ ...config.direct, onRequest }));
    prepared.lines.unshift(`выход «${config.direct.name}» — прямой, интернет сервера${onRequest ? ', только когда просят его страну' : config.direct.onRequest ? ', основной: туннелей нет' : ''}`);
  }
  return prepared;
}

/** Страны выходов — запасные тоже (поднимется — страна та же); `allowed` сужает (null — все). */
export function outletCountries(outlets: Outlet[], allowed: readonly string[] | null = null): string[] {
  const codes = new Set(outlets.map((o) => o.country).filter((c): c is string => Boolean(c) && (!allowed || allowed.includes(c as string))));
  return [...codes].sort();
}
