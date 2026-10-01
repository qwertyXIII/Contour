import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Consumers } from './consumers.ts';
import { ConfigError, loadConfig } from './config.ts';
import { startHttpInlet } from './inlets/http-proxy.ts';
import { startGamePorts } from './inlets/game-ports.ts';
import { Hints } from './inlets/hints.ts';
import { startLanInlet } from './inlets/lan.ts';
import { errorText, log } from './log.ts';
import { startHealth } from './outlets/health.ts';
import { makeDial } from './outlets/connect.ts';
import { buildMihomoConfig } from './outlets/mihomo-config.ts';
import { runMihomo, type MihomoHandle } from './outlets/mihomo.ts';
import { prepareOutlets, reloadNetnsPassword, type Outlet } from './outlets/outlet.ts';
import { PortProbe } from './outlets/ports.ts';
import { Rivals } from './outlets/rivals.ts';
import { rootCall } from './root/protocol.ts';
import { Resolver } from './outlets/resolver.ts';
import { Chooser } from './select/chooser.ts';
import { Auth } from './panel/auth.ts';
import { GatewayAddresses } from './panel/addresses.ts';
import { Devices } from './panel/devices.ts';
import { createPanel, type Panel } from './panel/server.ts';
import { Sites } from './panel/sites.ts';
import type { SpeedResult } from './panel/speedtest.ts';
import { PanelState } from './panel/state.ts';
import { Meter } from './stats/meter.ts';

/**
 * Точка входа Contour.
 *
 * Порядок: настройки → профили выходов → конфиг и запуск mihomo → проверка
 * живости → вход HTTP-прокси. `--check` останавливается после профилей и
 * печатает, что получилось, без ключей: так установка проверяет настройки
 * до первого запуска под systemd.
 */

const CONFIG_PATH = process.env.CONTOUR_CONFIG ?? '/etc/contour/contour.yaml';
/** Своё состояние Contour: счётчики трафика, карты портов выходов. */
const STATE_DIR = '/var/lib/contour';

/** Поднят ли unit ядерного выхода — `systemctl is-active` root не нужен. */
function unitActive(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('systemctl', ['is-active', `contour-netns@${name}.service`], (_error, stdout) => {
      const s = String(stdout).trim();
      resolve(s === 'active' || s === 'activating');
    });
  });
}
const checkOnly = process.argv.includes('--check');

async function main(): Promise<void> {
  const config = loadConfig(CONFIG_PATH);
  const prepared = prepareOutlets(config);

  if (prepared.outlets.length === 0) log.warn('нет ни одного включённого выхода — прокси будет отвечать 502');
  for (const line of prepared.lines) log.info(line);

  if (checkOnly) {
    const consumers = new Consumers(config.tokens, log);
    consumers.load();
    log.info('настройки в порядке');
    return;
  }

  // mihomo — только если есть его выходы. Конфиг с ключами — только владельцу процесса.
  let mihomo: MihomoHandle | null = null;
  if (prepared.mihomo.length > 0) {
    const secret = randomBytes(24).toString('hex');
    mkdirSync(config.mihomo.dir, { recursive: true, mode: 0o700 });
    const configPath = path.join(config.mihomo.dir, 'config.yaml');
    // Подписки mihomo качает через первый ядерный выход: сайт подписки отсюда может быть закрыт.
    const kernel = prepared.outlets.find((o) => !prepared.mihomo.some((m) => m.outlet === o));
    const fetchVia = kernel ? { ...kernel.socks } : null;
    writeFileSync(configPath, buildMihomoConfig({ outlets: prepared.mihomo, controller: config.mihomo.controller, secret, fetchVia }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    mihomo = runMihomo({ ...config.mihomo, configPath, secret, log });
    try {
      await mihomo.ready;
    } catch (error) {
      // Не падаем: вход поднимаем, проверка живости покажет мёртвые выходы, а mihomo перезапустится сам.
      log.error(errorText(error));
    }
  }

  const outlets = prepared.outlets;
  const dial = makeDial(new Resolver(), config.health.connectTimeoutSec * 1000);
  // Соперники — до проверки живости: запасной не поднят, и проверка его не трогает.
  let recheck: ((o: Outlet) => void) | null = null;
  const rivals = new Rivals(outlets, config.outlets, {
    log,
    activate: async (name) => { await rootCall({ cmd: 'outlet.activate', name }); },
    isRunning: unitActive,
    onActivated: (o) => {
      const oc = config.outlets.find((c) => c.name === o.name);
      try {
        if (oc) reloadNetnsPassword(o, oc);
      } catch (error) {
        log.warn(`выход «${o.name}» поднят, но ${errorText(error)}`);
      }
      recheck?.(o);
    },
  });
  await rivals.init();
  rivals.start();
  const health = startHealth(outlets, {
    intervalMs: config.health.intervalSec * 1000,
    connectTimeoutMs: config.health.connectTimeoutSec * 1000,
    probeHost: config.health.probeHost,
    probePath: config.health.probePath,
    ipHost: config.health.ipHost,
    ipIntervalMs: config.health.ipIntervalSec * 1000,
    log,
    dial,
  });
  recheck = (o) => health.recheck(o);
  // Какие порты пропускает каждый выход: при запуске (с диска), раз в сутки и по сигналу с трафика.
  const ports = new PortProbe(outlets, {
    dial,
    host: config.health.portsHost,
    intervalMs: config.health.portsIntervalSec * 1000,
    needed: config.lan.enabled ? config.lan.ports.map((r) => r.port) : [],
    file: path.join(STATE_DIR, 'outlet-ports.json'),
    log,
  });
  ports.start();
  const chooser = new Chooser(outlets, {
    stickyMs: config.sticky.hours * 3_600_000,
    connectTimeoutMs: config.health.connectTimeoutSec * 1000,
    onFailure: (outlet) => health.recheck(outlet),
    log,
    dial,
  });
  const consumers = new Consumers(config.tokens, log);
  consumers.load();
  consumers.startFlushing();

  const meter = new Meter({ dir: STATE_DIR, log });
  meter.start();
  const server = await startHttpInlet({ ...config.http, chooser, consumers, log, meter, ports });
  const panel = config.panel.enabled ? startPanel(config, { outlets, meter, dial, ports, rivals }) : null;
  const panelHosts = new Set([config.panel.name, config.lan.address]);
  const lanServers = config.lan.enabled
    ? startLanInlet(config.lan, { chooser, consumers, log, meter, ports }, panel ? { hosts: panelHosts, take: panel.take } : null)
    : [];
  // Порты игр — по подсказкам DNS (inlets/hints.ts, game-ports.ts).
  const hints = new Hints();
  const hintSocket = config.lan.enabled && config.lan.ports.length > 0 ? hints.listen(config.lan.hintPort, log) : null;
  const gameServers = hintSocket ? startGamePorts(config.lan, hints, { chooser, consumers, log, meter, ports }) : [];
  log.info('Contour готов');

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: останавливаюсь`);
    health.stop();
    rivals.stop();
    ports.stop();
    consumers.stop();
    meter.stop();
    panel?.server.close();
    server.close();
    server.closeAllConnections();
    for (const s of [...lanServers, ...gameServers]) s.close();
    hintSocket?.close();
    void (mihomo ? mihomo.stop() : Promise.resolve()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 7_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function startPanel(config: ReturnType<typeof loadConfig>, live: { outlets: Outlet[]; meter: Meter; dial: ReturnType<typeof makeDial>; ports: PortProbe; rivals: Rivals }): Panel {
  const speeds = new Map<string, SpeedResult>();
  const devices = new Devices(config.panel.dataDir);
  const auth = new Auth(config.panel.passwordFile, config.panel.dataDir);
  if (!auth.configured()) log.warn(`панель: нет пароля (${config.panel.passwordFile}) — войти нельзя; задать: sudo bash deploy/panel-password.sh`);
  const state = new PanelState({ config, outlets: live.outlets, meter: live.meter, devices, speeds, addresses: new GatewayAddresses(config.panel.dataDir) });
  const sites = new Sites({ dnsDir: config.lan.dataDir, own: config.lan.domains });
  return createPanel({
    listen: config.panel.listen,
    port: config.panel.port,
    log: log.child({ src: 'panel' }),
    auth, state, devices, sites, speeds,
    meter: live.meter,
    outlets: live.outlets,
    dial: live.dial,
    ports: live.ports,
    rivals: live.rivals,
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) log.error(`настройки (${CONFIG_PATH}): ${error.message}`);
  else log.error(`не запустился: ${errorText(error)}`);
  process.exit(1);
});
