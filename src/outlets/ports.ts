import { renameSync, readFileSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import { errorText, type Logger } from '../log.ts';
import type { Dial } from './connect.ts';
import type { Outlet } from './outlet.ts';

/**
 * Какие порты выход пропускает.
 *
 * Выход может быть живым для сайтов и при этом молча рвать всё, кроме ходовых
 * портов: так вёл себя AmneziaWG-профиль провайдера (2026-10-01) — 80/443/8443
 * пропускал, а 9339 Brawl Stars, 5222, 25565, 27015 принимал и рвал за 26 мс.
 * Поэтому у выхода есть карта портов, и выбор выхода (`select/chooser.ts`)
 * ставит первым тот, что нужный порт пропускает.
 *
 * Проверка — через выход к portquiz.net, который отвечает по HTTP на любом
 * TCP-порту. Порт пропущен, только если пришёл ответ сервера: «соединение
 * установлено» от SOCKS ничего не значит — mihomo отвечает успехом раньше, чем
 * соединился. portquiz видит адрес выхода и список портов — не домашний адрес;
 * напрямую мимо выхода мы к нему не ходим. Не ответил даже на 80 и 443 — лежит
 * он или выход, вердикта нет («не проверено»), прежние данные остаются.
 *
 * Кроме плановой проверки — сигнал с живого трафика (`relay.ts`): выход закрыл
 * соединение раньше, чем пакет дошёл бы до его сервера, — это фильтр, а не
 * ответ сайта; такой порт проверяется отдельно, сразу. Ответ сервера по
 * живому соединению — тоже знание: порт пропускается.
 */

export type PortFilter = 'all' | 'filtered' | 'unknown';
export type PortsInfo = { filter: PortFilter; pass: Set<number>; cut: Set<number>; checkedAt: number | null };

/** Сигналы с живого трафика — то, что нужно от проверки входам. */
export type PortLearner = {
  /** Выход закрыл соединение на порт, не ответив, подозрительно быстро. */
  suspect(outlet: Outlet, port: number): void;
  /** Через выход на порт пришёл ответ сервера. */
  confirm(outlet: Outlet, port: number): void;
};

/** Ходовые: их пропускает любой выход; не ответили и они — проверке не верим. */
const BASELINE = [80, 443];
/**
 * Неходовые вразброс: VPN, почта клиентов, push Apple и Google, игры, высокие.
 * 25 нет нарочно: его режут от спама почти все хостинги, и «режет 25» ничего не
 * скажет о фильтре портов.
 */
const SAMPLE = [22, 1194, 3478, 5000, 5222, 5223, 5228, 6443, 8000, 8080, 8443, 8888, 9000, 10000, 25565, 27015, 50000];
const PROBE_TIMEOUT_MS = 6_000;
const PARALLEL = 4;
/** Один и тот же порт выхода по сигналу с трафика — не чаще. */
const SUSPECT_GAP_MS = 10 * 60_000;
const TICK_MS = 60_000;
const FIRST_TICK_MS = 20_000;
const SAVE_DELAY_MS = 5_000;

/** Для панели и JSON: множества — отсортированными списками. */
export function portsView(p: PortsInfo): { filter: PortFilter; pass: number[]; cut: number[]; checkedAt: number | null } {
  const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);
  return { filter: p.filter, pass: sorted(p.pass), cut: sorted(p.cut), checkedAt: p.checkedAt };
}

export function unknownPorts(): PortsInfo {
  return { filter: 'unknown', pass: new Set(), cut: new Set(), checkedAt: null };
}

/**
 * Насколько выход годится для порта: 0 — пропускает (проверено или «все порты»),
 * 1 — не проверено, 2 — выход режет неходовые, а этот порт не проверяли
 * (вероятно, режет), 3 — режет точно. Меньше — раньше в очереди.
 */
export function portRank(outlet: Outlet, port: number): number {
  const p = outlet.ports;
  if (p.cut.has(port)) return 3;
  if (p.pass.has(port) || p.filter === 'all') return 0;
  return p.filter === 'filtered' ? 2 : 1;
}

/** Ответит ли portquiz через выход на этом порту: ждём первые байты «HTTP/». */
export async function answers(dial: Dial, outlet: Outlet, host: string, port: number): Promise<boolean> {
  let socket: Socket;
  try {
    socket = await dial(outlet, host, port);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    socket.once('data', (chunk: Buffer) => finish(chunk.subarray(0, 5).toString('latin1') === 'HTTP/'));
    socket.once('close', () => finish(false));
    socket.once('error', () => finish(false));
    socket.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: contour\r\nConnection: close\r\n\r\n`);
  });
}

async function mapLimit<T, R>(items: T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await job(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type Saved = { hash: string | null; filter: PortFilter; pass: number[]; cut: number[]; checkedAt: number | null };

export type PortProbeOptions = {
  dial: Dial;
  host: string;
  intervalMs: number;
  /** Порты, которые нужны правилам (порты игр), — проверяются всегда. */
  needed: number[];
  /** Где помнить карты портов между перезапусками. */
  file: string;
  log: Logger;
};

export class PortProbe implements PortLearner {
  private readonly outlets: Outlet[];
  private readonly opts: PortProbeOptions;
  private readonly busy = new Set<string>();
  private readonly suspectedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(outlets: Outlet[], opts: PortProbeOptions) {
    this.outlets = outlets;
    this.opts = opts;
    this.load();
  }

  /** Порты одной проверки: ходовые, пробные и нужные правилам — без повторов. */
  ports(): number[] {
    return [...new Set([...BASELINE, ...SAMPLE, ...this.opts.needed])];
  }

  start(): void {
    const tick = (): void => {
      for (const o of this.outlets) {
        const stale = o.ports.checkedAt === null || Date.now() - o.ports.checkedAt >= this.opts.intervalMs;
        if (o.state === 'alive' && stale) void this.run(o);
      }
    };
    setTimeout(tick, FIRST_TICK_MS).unref();
    this.timer = setInterval(tick, TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }

  /** Полная проверка выхода. null — вердикта нет (выход или portquiz не отвечают). */
  async run(outlet: Outlet): Promise<PortsInfo | null> {
    if (this.busy.has(outlet.name)) return null;
    this.busy.add(outlet.name);
    try {
      const ports = this.ports();
      const ok = await mapLimit(ports, PARALLEL, (p) => answers(this.opts.dial, outlet, this.opts.host, p));
      const result = new Map(ports.map((p, i) => [p, ok[i] === true]));
      if (!BASELINE.some((p) => result.get(p))) {
        this.opts.log.warn(`порты выхода «${outlet.name}» не проверить: ${this.opts.host} не отвечает через него даже на 80 и 443`);
        return null;
      }
      const cut = new Set(ports.filter((p) => !result.get(p)));
      const pass = new Set(ports.filter((p) => result.get(p)));
      const was = outlet.ports;
      outlet.ports = { filter: cut.size === 0 ? 'all' : 'filtered', pass, cut, checkedAt: Date.now() };
      if (was.filter !== outlet.ports.filter || [...cut].join() !== [...was.cut].join()) this.opts.log.info(this.summary(outlet));
      this.saveSoon();
      return outlet.ports;
    } catch (error) {
      this.opts.log.warn(`порты выхода «${outlet.name}»: ${errorText(error)}`);
      return null;
    } finally {
      this.busy.delete(outlet.name);
    }
  }

  summary(outlet: Outlet): string {
    const p = outlet.ports;
    if (p.filter === 'all') return `выход «${outlet.name}» пропускает все порты`;
    if (p.filter === 'unknown') return `порты выхода «${outlet.name}» не проверены`;
    return `выход «${outlet.name}» режет порты ${[...p.cut].sort((a, b) => a - b).join(', ')} — соединения на них пойдут через другие выходы`;
  }

  suspect(outlet: Outlet, port: number): void {
    const key = `${outlet.name}:${port}`;
    if (Date.now() - (this.suspectedAt.get(key) ?? 0) < SUSPECT_GAP_MS) return;
    this.suspectedAt.set(key, Date.now());
    void (async () => {
      // 443 рядом — чтобы отличить «режет этот порт» от «выход сейчас не работает вообще».
      const [base, ok] = await Promise.all([answers(this.opts.dial, outlet, this.opts.host, 443), answers(this.opts.dial, outlet, this.opts.host, port)]);
      if (base) this.mark(outlet, port, ok, 'замечено на живом соединении');
    })();
  }

  confirm(outlet: Outlet, port: number): void {
    const p = outlet.ports;
    if (p.pass.has(port) || (p.filter === 'all' && !p.cut.has(port))) return;
    this.mark(outlet, port, true, 'ответ по живому соединению');
  }

  private mark(outlet: Outlet, port: number, ok: boolean, why: string): void {
    const p = outlet.ports;
    if (ok) {
      p.pass.add(port);
      if (p.cut.delete(port)) this.opts.log.info(`выход «${outlet.name}» снова пропускает порт ${port} (${why})`);
      if (p.cut.size === 0 && p.filter === 'filtered') p.filter = 'all';
    } else {
      if (p.cut.has(port)) return;
      p.cut.add(port);
      p.pass.delete(port);
      p.filter = 'filtered';
      this.opts.log.warn(`выход «${outlet.name}» режет порт ${port} (${why}) — соединения на него пойдут через другие выходы`);
    }
    this.saveSoon();
  }

  private load(): void {
    let saved: Record<string, Saved> = {};
    try {
      saved = (JSON.parse(readFileSync(this.opts.file, 'utf8')) as { outlets?: Record<string, Saved> }).outlets ?? {};
    } catch {
      return; // файла нет — проверим заново
    }
    for (const o of this.outlets) {
      const s = saved[o.name];
      // Другой ключ под тем же именем — другой выход: старая карта ему не годится.
      if (!s || s.hash !== o.confHash) continue;
      o.ports = { filter: s.filter, pass: new Set(s.pass), cut: new Set(s.cut), checkedAt: s.checkedAt };
    }
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  private flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const outlets: Record<string, Saved> = {};
    for (const o of this.outlets) {
      const p = o.ports;
      outlets[o.name] = { hash: o.confHash, filter: p.filter, pass: [...p.pass], cut: [...p.cut], checkedAt: p.checkedAt };
    }
    try {
      const tmp = path.join(path.dirname(this.opts.file), `.${path.basename(this.opts.file)}.tmp`);
      writeFileSync(tmp, JSON.stringify({ outlets }));
      renameSync(tmp, this.opts.file);
    } catch (error) {
      this.opts.log.warn(`карту портов не сохранить: ${errorText(error)}`);
    }
  }
}
