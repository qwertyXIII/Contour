import { networkInterfaces } from 'node:os';
import { arpTable } from '../arp.ts';
import type { Config } from '../config.ts';
import { readGateway } from '../gateway.ts';
import { journal, type JournalEntry } from '../log.ts';
import type { Outlet } from '../outlets/outlet.ts';
import { portsView } from '../outlets/ports.ts';
import { rootCall, type OutletRuntime, type RootStatus } from '../root/protocol.ts';
import { SHARE_PREFIX, type ShareStore } from '../share/store.ts';
import type { Meter } from '../stats/meter.ts';
import type { GatewayAddresses } from './addresses.ts';
import type { Devices } from './devices.ts';
import type { SpeedResult } from './speedtest.ts';

/**
 * Что панель показывает на главном — одним ответом.
 *
 * Состояние выходов складывается из двух мест: здоровье и скорость знает
 * Contour (проверка, счётчик), а то, что требует root (поднят ли namespace,
 * рукопожатие, байты туннеля, состояние служб), — помощник. Его ответ
 * кешируется на несколько секунд: панель спрашивает раз в 2 с, а systemctl
 * на каждый вопрос — лишняя нагрузка.
 */

const ROOT_CACHE_MS = 5_000;

type Rate = { up: number; down: number };
const ZERO: Rate = { up: 0, down: 0 };

export type StateDeps = {
  config: Config;
  outlets: Outlet[];
  meter: Meter;
  devices: Devices;
  speeds: Map<string, SpeedResult>;
  /** Свой адрес каждому устройству-шлюзу (addresses.ts). */
  addresses: GatewayAddresses;
  /** Устройства раздачи — их имена для строк `share.<id>`. */
  share: ShareStore | null;
};

type ConsumerRow = {
  who: string; kind: 'device' | 'program' | 'share'; ip: string | null; mac: string | null; name: string | null;
  gateway: string | null; gatewayActive: boolean | null; gatewayIp: string | null; gatewayConflict: string | null;
  rate: Rate; today: Rate; lastSeen: number | null;
};

/** Одно устройство под двумя адресами: счётчики — вместе, адрес и ключ — у того, что был виден позже. */
function mergeRows(a: ConsumerRow, b: ConsumerRow): ConsumerRow {
  const newer = (b.lastSeen ?? 0) > (a.lastSeen ?? 0) ? b : a;
  return {
    ...newer,
    rate: { up: a.rate.up + b.rate.up, down: a.rate.down + b.rate.down },
    today: { up: a.today.up + b.today.up, down: a.today.down + b.today.down },
    lastSeen: Math.max(a.lastSeen ?? 0, b.lastSeen ?? 0) || null,
  };
}

/** Адреса самого сервера (.113, .50) — в списке устройств им не место: это проверки с сервера. */
function ownAddresses(): Set<string> {
  return new Set(Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address)));
}

export class PanelState {
  private root: { at: number; data: RootStatus | null; error: string | null } = { at: 0, data: null, error: null };
  private readonly deps: StateDeps;

  constructor(deps: StateDeps) {
    this.deps = deps;
  }

  async rootStatus(force = false): Promise<{ data: RootStatus | null; error: string | null }> {
    if (!force && Date.now() - this.root.at < ROOT_CACHE_MS) return this.root;
    try {
      this.root = { at: Date.now(), data: await rootCall<RootStatus>({ cmd: 'status' }, 10_000), error: null };
    } catch (error) {
      this.root = { at: Date.now(), data: null, error: (error as Error).message };
    }
    return this.root;
  }

  private outletsView(runtime: OutletRuntime[]) {
    const { meter, speeds } = this.deps;
    const rates = meter.rates().outlet;
    const today = meter.todayTotals().outlet;
    const live = new Map(this.deps.outlets.map((o) => [o.name, o]));
    // Список — из настроек (помощник знает и выключенные), здоровье — из живых.
    const names = runtime.length > 0 ? runtime.map((r) => r.name) : [...live.keys()];
    return names.map((name) => {
      const o = live.get(name);
      const r = runtime.find((x) => x.name === name);
      return {
        name,
        kind: r?.kind ?? null,
        protocol: r?.protocol ?? null,
        enabled: r?.enabled ?? true,
        priority: r?.priority ?? o?.priority ?? null,
        group: r?.group ?? null,
        // Соперники — по настройкам, включая выключенных: их тоже можно выбрать в паре.
        rivals: r?.group ? runtime.filter((x) => x.group === r.group && x.name !== name).map((x) => x.name) : [],
        state: o?.state ?? 'off',
        latencyMs: o?.latencyMs ?? null,
        externalIp: o?.externalIp ?? null,
        lastError: o?.lastError ?? null,
        checkedAt: o?.checkedAt ?? null,
        tunnelUp: r?.up ?? null,
        handshakeAgoS: r?.handshakeAgoS ?? null,
        tunnelRx: r?.rxBytes ?? null,
        tunnelTx: r?.txBytes ?? null,
        rate: rates[name] ?? ZERO,
        today: today[name] ?? ZERO,
        speed: speeds.get(name) ?? null,
        ports: o ? portsView(o.ports) : null,
      };
    });
  }

  /**
   * Кто ходит через Contour. Устройство — одна строка на MAC: телефон, сменив
   * адрес (DHCP, ручной адрес шлюза), остаётся в таблице соседей и под старыми —
   * их счётчики складываются, адрес — самый свежий. Свои адреса сервера — не устройства.
   */
  private consumersView(seen: string[] | null) {
    const { meter, devices } = this.deps;
    const rates = meter.rates().who;
    const today = meter.todayTotals().who;
    const lastSeen = meter.lastSeen();
    const keys = new Set([...Object.keys(today), ...Object.keys(rates), ...Object.keys(lastSeen)]);
    // Устройство-шлюз ходит мимо Contour — в счётчиках его нет; показываем по MAC из таблицы соседей.
    const gateway = readGateway().devices;
    const arp = arpTable();
    for (const [ip, mac] of arp) if (mac in gateway) keys.add(`lan:${ip}`);
    const { addresses, config } = this.deps;
    addresses.observe(arp, new Set(Object.keys(gateway)));
    const own = ownAddresses();
    const lanIps = [...keys].filter((k) => k.startsWith('lan:')).map((k) => k.slice(4)).filter((ip) => !own.has(ip));
    const byIp = new Map(devices.resolve(lanIps).map((d) => [d.ip, d]));
    const shared = new Map((this.deps.share?.devices() ?? []).map((s) => [`${SHARE_PREFIX}${s.id}`, s.name]));
    const rows = new Map<string, ConsumerRow>();
    for (const who of keys) {
      const ip = who.startsWith('lan:') ? who.slice(4) : null;
      if (ip && own.has(ip)) continue;
      const d = ip ? byIp.get(ip) : undefined;
      const row: ConsumerRow = {
        who,
        kind: ip ? 'device' : who.startsWith(SHARE_PREFIX) ? 'share' : 'program',
        ip,
        mac: d?.mac ?? null,
        name: d?.name ?? shared.get(who) ?? null,
        gateway: d?.mac ? gateway[d.mac] ?? null : null,
        // null — помощник не сказал (не обновлён или недоступен).
        gatewayActive: d?.mac && gateway[d.mac] && seen ? seen.includes(d.mac) : null,
        // Адрес, который ставить на устройстве, и чужой ли он сейчас.
        gatewayIp: d?.mac && gateway[d.mac] ? addresses.suggest(d.mac, arp, config.lan.address) : null,
        gatewayConflict: d?.mac && gateway[d.mac] ? addresses.conflict(d.mac, arp) : null,
        rate: rates[who] ?? ZERO,
        today: today[who] ?? ZERO,
        lastSeen: lastSeen[who] ?? null,
      };
      // Ключ строки — MAC: адрес меняется, а строка в панели должна остаться той же.
      const key = row.mac ? `dev:${row.mac}` : who;
      const was = rows.get(key);
      rows.set(key, { ...(was ? mergeRows(was, row) : row), who: key });
    }
    return [...rows.values()].sort((a, b) => (b.today.down + b.today.up) - (a.today.down + a.today.up));
  }

  async overview() {
    const { config } = this.deps;
    const root = await this.rootStatus();
    return {
      now: Date.now(),
      outlets: this.outletsView(root.data?.outlets ?? []),
      consumers: this.consumersView(root.data?.gatewaySeen ?? null),
      units: root.data?.units ?? {},
      rootError: root.error,
      lan: { enabled: config.lan.enabled, address: config.lan.address, panelName: config.panel.name },
    };
  }

  journal(limit = 150): JournalEntry[] {
    return journal.slice(-limit).reverse();
  }
}
