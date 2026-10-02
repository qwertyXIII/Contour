import { ConfigError, loadConfig } from '../config.ts';
import { errorText, log } from '../log.ts';
import { Learner } from './learn.ts';
import { Lists } from './lists.ts';
import { CompiledRules, rulesDir } from '../rules/compiled.ts';
import { Overrides } from './overrides.ts';
import { startDns, type Decide } from './server.ts';
import { makeTunnelProbe, readToken } from './tunnel-probe.ts';
import { TunnelResolver } from './tunnel-resolve.ts';
import { allowRequest, GatewayClients, gatewayHook } from './gateway.ts';
import { Subnets } from './subnets.ts';
import { hintSender } from '../inlets/hints.ts';
import { rootCall } from '../root/protocol.ts';

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
  const proxy = token ? { host: config.http.listen, port: config.http.port, user: 'contour-dns', token } : null;
  const viaTunnel = proxy ? makeTunnelProbe(proxy) : null;
  const learner = lan.learn && viaTunnel ? new Learner({ upstream: lan.upstream, dir: lan.dataDir, budgetMs: lan.probeBudgetMs, log: dnsLog, viaTunnel }) : null;

  const overrides = new Overrides(lan.dataDir);
  const rules = new CompiledRules(rulesDir(config));
  const panelName = config.panel.enabled ? config.panel.name : null;

  // Имя панели — наш адрес; дальше — правила Contour (ручное, загруженное);
  // их набора ещё нет — как до движка: ручное решение, список. Остальное —
  // самообучение (или напрямую, если выключено).
  const decide: Decide = async (name) => {
    const n = name.toLowerCase().replace(/\.$/, '');
    if (panelName && n === panelName) return { tunnel: true, local: true };
    const ruled = rules.dnsVia(n);
    if (ruled) return { tunnel: ruled.tunnel };
    if (ruled === undefined) {
      const manual = overrides.match(n);
      if (manual) return { tunnel: manual === 'tunnel' };
      if (lists.match(name)) return { tunnel: true };
    }
    if (!learner) return { tunnel: false };
    const d = await learner.decide(name);
    return { tunnel: d.via === 'tunnel', shortTtl: d.pending === true };
  };
  // Подсказки для портов игр: устройство получило наш адрес на имя — Contour узнает, куда вести.
  const hint = hintSender(lan.hintPort);
  // Устройства-шлюзы (src/gateway.ts): заблокированное — настоящими адресами через туннель, уже в наборе
  // своего класса. Куда имени — `route` (по умолчанию defaultRoute: заблокированное — «как сейчас»).
  const tunnelResolver = proxy ? new TunnelResolver(proxy) : null;
  const gateway = tunnelResolver ? gatewayHook({
    clients: new GatewayClients(undefined, undefined, () => rootCall<string[]>({ cmd: 'gateway.seen' }, 3_000)),
    resolve: (n) => tunnelResolver.resolve(n),
    allow: async (ips, ttl, route) => { await rootCall(allowRequest(ips, ttl, route), 3_000); },
    log: dnsLog,
  }) : undefined;
  // Подсети сервисов, что ходят по адресам (голос Discord, звонки), — помощнику для шлюза.
  new Subnets({
    urls: lan.subnetLists,
    skip: lan.subnetSkip,
    cacheDir: lan.dataDir,
    push: async (cidrs) => { await rootCall({ cmd: 'gateway.nets', cidrs }, 30_000); },
    log: dnsLog,
  }).start();
  startDns({ lan, decide, log: dnsLog, onOwn: (client, name) => { if (name !== panelName) hint(client, name); }, gateway });
  const sizes = lists.size();
  dnsLog.info(`обычный DNS: ${lan.upstream.join(', ')}; свой список — ${sizes.own} сайтов, общий — ${sizes.common}; самообучение ${learner ? 'включено' : 'выключено'}`);
  process.on('SIGTERM', () => process.exit(0));
} catch (error) {
  if (error instanceof ConfigError) log.error(`настройки (${CONFIG_PATH}): ${error.message}`);
  else log.error(`DNS не запустился: ${errorText(error)}`);
  process.exit(1);
}
