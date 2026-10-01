import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { errorText, type Logger } from '../log.ts';
import { runMihomo, type MihomoHandle } from '../outlets/mihomo.ts';
import { buildEdgeConfig, type UdpOutlet } from './edge-config.ts';
import type { ShareStore } from './store.ts';

/**
 * Край раздачи — дочерний mihomo, как у выходов (`outlets/mihomo.ts`), но свой:
 * у него другой вход, другие правила, и перезапускать его при смене устройств
 * нельзя заодно с выходами.
 *
 * Смена устройств — перезапуск целиком, а не перечитывание конфига: убранное
 * или выключенное устройство должно потерять и уже открытые соединения.
 * Устройств нет — края нет: незачем держать открытый вход. Поднялся запасной
 * выход — тоже перезапуск (`refresh`): у него пароль SOCKS появляется только
 * после подъёма, а UDP идёт прямо в SOCKS выходов.
 */

export type EdgeOptions = {
  store: ShareStore;
  bin: string;
  dir: string;
  listen: string;
  port: number;
  controller: string;
  proxy: { host: string; port: number };
  /** Ядерные выходы для UDP, по приоритету (спрашивается на каждом перезапуске). */
  udp: () => UdpOutlet[];
  probeUrl: string;
  log: Logger;
};

const SETTLE_MS = 500;
const PROBE_MS = 2_000;

/** Открыт ли порт: mihomo отвечает по API и тогда, когда вход открыть не смог. */
function listening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: PROBE_MS }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

export class Edge {
  private handle: MihomoHandle | null = null;
  private open = false;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly opts: EdgeOptions;

  constructor(opts: EdgeOptions) {
    this.opts = opts;
  }

  start(): void {
    this.opts.store.onChange(() => this.schedule(SETTLE_MS));
    this.schedule(0);
  }

  /** Пересобрать край: поднялся другой выход. */
  refresh(): void {
    this.schedule(SETTLE_MS);
  }

  /** Край поднят и вход открыт — для панели. */
  running(): boolean {
    return this.handle !== null && this.open;
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.chain;
    await this.handle?.stop();
    this.handle = null;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.chain = this.chain.then(() => this.apply()).catch((error: unknown) => this.opts.log.error(`край раздачи: ${errorText(error)}`));
    }, ms);
    this.timer.unref();
  }

  private async apply(): Promise<void> {
    const { store, log } = this.opts;
    const devices = store.devices().filter((d) => d.enabled);
    await this.handle?.stop();
    this.handle = null;
    this.open = false;
    if (devices.length === 0) {
      log.info('край раздачи: включённых устройств нет — не запущен');
      return;
    }
    const secret = randomBytes(24).toString('hex');
    const configPath = path.join(this.opts.dir, 'config.yaml');
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    const udp = this.opts.udp();
    const { listen, port, proxy, probeUrl, controller } = this.opts;
    const text = buildEdgeConfig({ devices, wsPath: store.settings().path, listen, port, proxy, udp, probeUrl, controller, secret });
    writeFileSync(configPath, text, { mode: 0o600 });
    chmodSync(configPath, 0o600);
    log.info(`край раздачи: устройств ${devices.length}, вход ${listen}:${port}, UDP — ${udp.length > 0 ? udp.map((o) => o.name).join(' → ') : 'нет ядерных выходов, отвергается'}`);
    this.handle = runMihomo({ bin: this.opts.bin, dir: this.opts.dir, configPath, controller: this.opts.controller, secret, log, label: 'edge' });
    await this.handle.ready;
    this.open = await listening(this.opts.listen, this.opts.port);
    if (!this.open) log.error(`край раздачи: mihomo поднялся, а вход ${this.opts.listen}:${this.opts.port} не открыт — причина строкой выше (src: edge)`);
  }
}
