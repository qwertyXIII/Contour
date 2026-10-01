import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Consumers } from './consumers.ts';
import { ConfigError, loadConfig } from './config.ts';
import { startHttpInlet } from './inlets/http-proxy.ts';
import { startLanInlet } from './inlets/lan.ts';
import { errorText, log } from './log.ts';
import { startHealth } from './outlets/health.ts';
import { makeDial } from './outlets/connect.ts';
import { buildMihomoConfig } from './outlets/mihomo-config.ts';
import { runMihomo, type MihomoHandle } from './outlets/mihomo.ts';
import { prepareOutlets } from './outlets/outlet.ts';
import { Resolver } from './outlets/resolver.ts';
import { Chooser } from './select/chooser.ts';
import { Auth } from './panel/auth.ts';
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

  const meter = new Meter({ dir: '/var/lib/contour', log });
  meter.start();
  const server = await startHttpInlet({ ...config.http, chooser, consumers, log, meter });
  const panel = config.panel.enabled ? startPanel(config, { outlets, meter, dial }) : null;
  const panelHosts = new Set([config.panel.name, config.lan.address]);
  const lanServers = config.lan.enabled
    ? startLanInlet(config.lan, { chooser, consumers, log, meter }, panel ? { hosts: panelHosts, take: panel.take } : null)
    : [];
  log.info('Contour готов');

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: останавливаюсь`);
    health.stop();
    consumers.stop();
    meter.stop();
    panel?.server.close();
    server.close();
    server.closeAllConnections();
    for (const s of lanServers) s.close();
    void (mihomo ? mihomo.stop() : Promise.resolve()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 7_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function startPanel(config: ReturnType<typeof loadConfig>, live: { outlets: ReturnType<typeof prepareOutlets>['outlets']; meter: Meter; dial: ReturnType<typeof makeDial> }): Panel {
  const speeds = new Map<string, SpeedResult>();
  const devices = new Devices(config.panel.dataDir);
  const auth = new Auth(config.panel.passwordFile, config.panel.dataDir);
  if (!auth.configured()) log.warn(`панель: нет пароля (${config.panel.passwordFile}) — войти нельзя; задать: sudo bash deploy/panel-password.sh`);
  const state = new PanelState({ config, outlets: live.outlets, meter: live.meter, devices, speeds });
  const sites = new Sites({ dnsDir: config.lan.dataDir, own: config.lan.domains });
  return createPanel({
    listen: config.panel.listen,
    port: config.panel.port,
    log: log.child({ src: 'panel' }),
    auth, state, devices, sites, speeds,
    meter: live.meter,
    outlets: live.outlets,
    dial: live.dial,
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) log.error(`настройки (${CONFIG_PATH}): ${error.message}`);
  else log.error(`не запустился: ${errorText(error)}`);
  process.exit(1);
});
