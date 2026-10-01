import { arpTable } from '../arp.ts';
import type { Config } from '../config.ts';
import { readGateway } from '../gateway.ts';
import { journal, type JournalEntry } from '../log.ts';
import type { Outlet } from '../outlets/outlet.ts';
import { portsView } from '../outlets/ports.ts';
import { rootCall, type OutletRuntime, type RootStatus } from '../root/protocol.ts';
import type { Meter } from '../stats/meter.ts';
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
};

/**
 * Свободный адрес для устройства-шлюза — подсказка в панели: вне пула DHCP
 * роутера (100–199), не занятый в таблице соседей, в той же /24, что сервер.
 */
export function freeAddress(serverIp: string, arp: Map<string, string> = arpTable()): string | null {
  const base = serverIp.split('.').slice(0, 3).join('.');
  for (let n = 20; n < 50; n++) {
    const ip = `${base}.${n}`;
    if (ip !== serverIp && !arp.has(ip)) return ip;
  }
  return null;
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

  private consumersView() {
    const { meter, devices } = this.deps;
    const rates = meter.rates().who;
    const today = meter.todayTotals().who;
    const seen = meter.lastSeen();
    const keys = new Set([...Object.keys(today), ...Object.keys(rates), ...Object.keys(seen)]);
    // Устройство-шлюз ходит мимо Contour — в счётчиках его нет; показываем по MAC из таблицы соседей.
    const gateway = readGateway().devices;
    for (const [ip, mac] of arpTable()) if (mac in gateway) keys.add(`lan:${ip}`);
    const lanIps = [...keys].filter((k) => k.startsWith('lan:')).map((k) => k.slice(4));
    const byIp = new Map(devices.resolve(lanIps).map((d) => [d.ip, d]));
    return [...keys].map((who) => {
      const ip = who.startsWith('lan:') ? who.slice(4) : null;
      const d = ip ? byIp.get(ip) : undefined;
      return {
        who,
        kind: ip ? 'device' : 'program',
        ip,
        mac: d?.mac ?? null,
        name: d?.name ?? null,
        gateway: d?.mac ? gateway[d.mac] ?? null : null,
        rate: rates[who] ?? ZERO,
        today: today[who] ?? ZERO,
        lastSeen: seen[who] ?? null,
      };
    }).sort((a, b) => (b.today.down + b.today.up) - (a.today.down + a.today.up));
  }

  async overview() {
    const { config } = this.deps;
    const root = await this.rootStatus();
    return {
      now: Date.now(),
      outlets: this.outletsView(root.data?.outlets ?? []),
      consumers: this.consumersView(),
      units: root.data?.units ?? {},
      rootError: root.error,
      lan: { enabled: config.lan.enabled, address: config.lan.address, panelName: config.panel.name, freeIp: freeAddress(config.lan.address) },
    };
  }

  journal(limit = 150): JournalEntry[] {
    return journal.slice(-limit).reverse();
  }
}
