import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Consumers } from './consumers.ts';
import { ConfigError, loadConfig } from './config.ts';
import { startHttpInlet } from './inlets/http-proxy.ts';
import { errorText, log } from './log.ts';
import { startHealth } from './outlets/health.ts';
import { makeDial } from './outlets/connect.ts';
import { buildMihomoConfig } from './outlets/mihomo-config.ts';
import { runMihomo } from './outlets/mihomo.ts';
import { prepareOutlets } from './outlets/outlet.ts';
import { describeProfile } from './outlets/profile.ts';
import { Resolver } from './outlets/resolver.ts';
import { Chooser } from './select/chooser.ts';

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

  if (prepared.length === 0) log.warn('нет ни одного включённого выхода — прокси будет отвечать 502');
  for (const p of prepared) log.info(`выход «${p.outlet.name}»: ${describeProfile(p.profile)} → SOCKS :${p.outlet.socks.port}`);

  if (checkOnly) {
    const consumers = new Consumers(config.tokens, log);
    consumers.load();
    log.info('настройки в порядке');
    return;
  }

  // mihomo: конфиг с ключами — только владельцу процесса.
  const secret = randomBytes(24).toString('hex');
  mkdirSync(config.mihomo.dir, { recursive: true, mode: 0o700 });
  const configPath = path.join(config.mihomo.dir, 'config.yaml');
  writeFileSync(configPath, buildMihomoConfig({ outlets: prepared, controller: config.mihomo.controller, secret }), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  const mihomo = runMihomo({ ...config.mihomo, configPath, secret, log });
  try {
    await mihomo.ready;
  } catch (error) {
    // Не падаем: вход поднимаем, проверка живости покажет мёртвые выходы, а mihomo перезапустится сам.
    log.error(errorText(error));
  }

  const outlets = prepared.map((p) => p.outlet);
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

  const server = await startHttpInlet({ ...config.http, chooser, consumers, log });
  log.info('Contour готов');

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: останавливаюсь`);
    health.stop();
    consumers.stop();
    server.close();
    server.closeAllConnections();
    void mihomo.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 7_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) log.error(`настройки (${CONFIG_PATH}): ${error.message}`);
  else log.error(`не запустился: ${errorText(error)}`);
  process.exit(1);
});
