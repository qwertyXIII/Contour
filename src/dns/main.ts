import { ConfigError, loadConfig } from '../config.ts';
import { errorText, log } from '../log.ts';
import { startDns } from './server.ts';

/**
 * Точка входа `contour-dns` — отдельный процесс от Contour (см. server.ts).
 * Читает тот же `contour.yaml`, раздел `lan`. Выключен — выходит с кодом 0,
 * а не перезапускается по кругу.
 */

const CONFIG_PATH = process.env.CONTOUR_CONFIG ?? '/etc/contour/contour.yaml';

try {
  const config = loadConfig(CONFIG_PATH);
  if (!config.lan.enabled) {
    log.info('домашняя сеть выключена (lan.enabled: false) — DNS не нужен');
    process.exit(0);
  }
  const dnsLog = log.child({ src: 'dns' });
  startDns(config.lan, dnsLog);
  dnsLog.info(`обычный DNS: ${config.lan.upstream.join(', ')}; своё — ${config.lan.domains.length} сайтов`);
  process.on('SIGTERM', () => process.exit(0));
} catch (error) {
  if (error instanceof ConfigError) log.error(`настройки (${CONFIG_PATH}): ${error.message}`);
  else log.error(`DNS не запустился: ${errorText(error)}`);
  process.exit(1);
}
