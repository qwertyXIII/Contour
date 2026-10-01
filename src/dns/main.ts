import { ConfigError, loadConfig } from '../config.ts';
import { errorText, log } from '../log.ts';
import { Learner } from './learn.ts';
import { Lists } from './lists.ts';
import { Overrides } from './overrides.ts';
import { startDns, type Decide } from './server.ts';
import { makeTunnelProbe, readToken } from './tunnel-probe.ts';

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
  const lan = config.lan;
  const dnsLog = log.child({ src: 'dns' });
  const lists = new Lists({ own: lan.domains, urls: lan.lists, cacheDir: lan.dataDir, log: dnsLog });
  lists.start();
  const token = readToken(config.tokens);
  if (lan.learn && !token) dnsLog.warn(`нет токена contour-dns в ${config.tokens} — самообучение не сможет проверять через VPN и уводить туда не будет`);
  const viaTunnel = token ? makeTunnelProbe({ host: config.http.listen, port: config.http.port, user: 'contour-dns', token }) : null;
  const learner = lan.learn && viaTunnel ? new Learner({ upstream: lan.upstream, dir: lan.dataDir, budgetMs: lan.probeBudgetMs, log: dnsLog, viaTunnel }) : null;

  const overrides = new Overrides(lan.dataDir);
  const panelName = config.panel.enabled ? config.panel.name : null;

  // Имя панели — наш адрес; ручное решение из панели — сильнее всего; список —
  // сразу через VPN; остальное — самообучение (или напрямую, если выключено).
  const decide: Decide = async (name) => {
    const n = name.toLowerCase().replace(/\.$/, '');
    if (panelName && n === panelName) return { tunnel: true };
    const manual = overrides.match(n);
    if (manual) return { tunnel: manual === 'tunnel' };
    if (lists.match(name)) return { tunnel: true };
    if (!learner) return { tunnel: false };
    const d = await learner.decide(name);
    return { tunnel: d.via === 'tunnel', shortTtl: d.pending === true };
  };
  startDns(lan, decide, dnsLog);
  const sizes = lists.size();
  dnsLog.info(`обычный DNS: ${lan.upstream.join(', ')}; свой список — ${sizes.own} сайтов, общий — ${sizes.common}; самообучение ${learner ? 'включено' : 'выключено'}`);
  process.on('SIGTERM', () => process.exit(0));
} catch (error) {
  if (error instanceof ConfigError) log.error(`настройки (${CONFIG_PATH}): ${error.message}`);
  else log.error(`DNS не запустился: ${errorText(error)}`);
  process.exit(1);
}
