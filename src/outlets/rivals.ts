import type { OutletConfig } from '../config.ts';
import { errorText, type Logger } from '../log.ts';
import type { Outlet } from './outlet.ts';

/**
 * Группы соперников — сторона Contour: кому из группы работать.
 *
 * Соперники — выходы, которые вместе держать нельзя (один аккаунт у
 * провайдера: AmneziaWG и OpenVPN выбивают друг друга). Работает один, у
 * остальных состояние `standby`: выбор выхода их не видит, проверка живости не
 * трогает. Работающий не отвечает `failoverMs` после того, как его признали
 * мёртвым, — Contour просит помощника от root поднять следующего по приоритету
 * (помощник сначала гасит соперников, потом поднимает — `root/groups.ts`).
 *
 * Назад к основному сам не возвращается: проверить основной можно, только
 * погасив работающий, а это обрыв на случай, если основной всё ещё лежит.
 * Вернуть — кнопкой «Сделать основным» в панели. После переключения —
 * `cooldownMs` без новых: упал и запасной — не метаться туда-сюда каждые 30 с.
 */

export type RivalsOptions = {
  log: Logger;
  /** Попросить помощника поднять выход вместо соперников. */
  activate: (name: string) => Promise<void>;
  /** Поднят ли unit выхода (`systemctl is-active` — без root). */
  isRunning: (name: string) => Promise<boolean>;
  /** Выход только что подняли: перечитать пароль SOCKS, проверить сразу. */
  onActivated: (outlet: Outlet) => void;
  failoverMs?: number;
  cooldownMs?: number;
  tickMs?: number;
};

const FAILOVER_MS = 15_000;
const COOLDOWN_MS = 2 * 60_000;
const TICK_MS = 5_000;

export class Rivals {
  private readonly groups = new Map<string, Outlet[]>();
  private readonly opts: RivalsOptions;
  private readonly deadSince = new Map<string, number>();
  private readonly lastSwitch = new Map<string, number>();
  private readonly switching = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(outlets: Outlet[], configs: OutletConfig[], opts: RivalsOptions) {
    this.opts = opts;
    for (const c of configs) {
      const o = outlets.find((x) => x.name === c.name);
      if (!c.group || !o) continue;
      this.groups.set(c.group, [...(this.groups.get(c.group) ?? []), o]);
    }
    for (const list of this.groups.values()) list.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  }

  /** Группа выхода и его соперники — для панели. */
  rivalsOf(name: string): { group: string; rivals: string[] } | null {
    for (const [group, list] of this.groups) {
      if (list.some((o) => o.name === name)) return { group, rivals: list.filter((o) => o.name !== name).map((o) => o.name) };
    }
    return null;
  }

  /** При запуске: кто не поднят — запасной; в группе не поднят никто — поднять первого. */
  async init(): Promise<void> {
    for (const [group, list] of this.groups) {
      const running = await Promise.all(list.map((o) => this.opts.isRunning(o.name).catch(() => false)));
      list.forEach((o, i) => { if (!running[i]) o.state = 'standby'; });
      if (!running.some(Boolean) && list[0]) await this.switchTo(group, list[0], 'в группе не работал никто');
    }
  }

  start(): void {
    if (this.groups.size === 0) return;
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  tick(now = Date.now()): void {
    for (const [group, list] of this.groups) {
      const active = list.find((o) => o.state !== 'standby');
      if (!active || active.state !== 'dead') {
        if (active) this.deadSince.delete(active.name);
        continue;
      }
      const since = this.deadSince.get(active.name) ?? now;
      this.deadSince.set(active.name, since);
      const cooled = now - (this.lastSwitch.get(group) ?? 0) >= (this.opts.cooldownMs ?? COOLDOWN_MS);
      if (now - since < (this.opts.failoverMs ?? FAILOVER_MS) || !cooled) continue;
      const next = this.nextAfter(list, active);
      if (next) void this.switchTo(group, next, `«${active.name}» не отвечает ${Math.round((now - since) / 1000)} с`, now);
    }
  }

  /** Поднять выход вручную (панель). Ошибка — словами помощника. */
  async manual(name: string): Promise<void> {
    for (const [group, list] of this.groups) {
      const to = list.find((o) => o.name === name);
      if (!to) continue;
      if (to.state !== 'standby') throw new Error(`«${name}» уже работает`);
      const error = await this.switchTo(group, to, 'вручную из панели');
      if (error) throw error;
      return;
    }
    throw new Error(`«${name}» не в группе соперников`);
  }

  /** Следующий запасной после работающего — по кругу, по приоритету. */
  private nextAfter(list: Outlet[], active: Outlet): Outlet | null {
    const i = list.indexOf(active);
    for (let k = 1; k < list.length; k++) {
      const o = list[(i + k) % list.length] as Outlet;
      if (o.state === 'standby') return o;
    }
    return null;
  }

  private async switchTo(group: string, to: Outlet, why: string, now = Date.now()): Promise<Error | null> {
    if (this.switching.has(group)) return new Error('переключение уже идёт');
    this.switching.add(group);
    this.lastSwitch.set(group, now);
    try {
      await this.opts.activate(to.name);
      for (const o of this.groups.get(group) ?? []) {
        if (o !== to) { o.state = 'standby'; this.deadSince.delete(o.name); }
      }
      to.state = 'unknown';
      to.failures = 0;
      to.lastError = null;
      this.opts.onActivated(to);
      this.opts.log.warn(`группа «${group}»: ${why} — работает «${to.name}», остальные запасные`);
      return null;
    } catch (error) {
      this.opts.log.error(`группа «${group}»: ${why}, но «${to.name}» не поднять — ${errorText(error)}`);
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      this.switching.delete(group);
    }
  }
}
