import type http from 'node:http';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Consumers } from '../consumers.ts';
import { errorText, type Logger } from '../log.ts';
import { outletCountries, type Outlet } from '../outlets/outlet.ts';
import type { Sites } from '../panel/sites.ts';
import type { UdpOutlet } from './edge-config.ts';
import { Edge } from './edge.ts';
import { ShareRules } from './rules.ts';
import { startShareServer } from './server.ts';
import { deviceCountries, ShareStore } from './store.ts';

/**
 * Раздача целиком: устройства, край, правила по ссылке. Contour без неё
 * работает как раньше (`share.enabled: false`), и сбой края — запись в журнале,
 * а не падение: прокси для программ и дом от раздачи не зависят.
 */

/**
 * `ports` — куда nginx ведёт домен раздачи: `/` — край, `/list/` — правила.
 * `countries()` — страны, которые можно открыть телефону: страны выходов (их
 * узнают на ходу, по адресу), суженные `share.countries`.
 */
export type Share = {
  store: ShareStore; edge: Edge; rules: ShareRules; outlets: Outlet[]; ports: { edge: number; list: number };
  allowed: readonly string[] | null; countries(): string[]; stop(): Promise<void>;
};


/**
 * Ядерные выходы для UDP — по приоритету, без запасных: namespace запасного не
 * поднят, и группа «первый живой» до первой проверки слала бы UDP в никуда
 * (живьём 2026-10-02: запасной `ext` стоял первым). Поднялся запасной — край
 * пересобирается (`refresh`), и он уже не запасной.
 */
function udpOutlets(config: Config, outlets: Outlet[]): UdpOutlet[] {
  const netns = new Set(config.outlets.filter((c) => c.kind === 'netns' && c.enabled).map((c) => c.name));
  return outlets.filter((o) => (o.direct || (netns.has(o.name) && o.socks.pass)) && o.state !== 'standby')
    .sort((a, b) => a.priority - b.priority)
    .map((o) => ({ name: o.name, direct: o.direct, onRequest: o.onRequest, country: o.country, socks: { ...o.socks } }));
}

/**
 * UDP стран, открытых хоть одному включённому устройству: выходы этой страны,
 * прямой — тоже (`DIRECT` с края). Страны без выхода сейчас — тоже (UDP туда
 * отвергается, TCP — «нет выхода в стране»): пропал выход ненадолго — сервер в
 * телефоне и его правила не перестраиваются.
 */
function countryUdp(config: Config, outlets: Outlet[], store: ShareStore): Array<{ code: string; udp: UdpOutlet[] }> {
  const all = udpOutlets(config, outlets);
  const codes = new Set(store.devices().filter((d) => d.enabled).flatMap((d) => deviceCountries(d, config.share.countries)));
  return [...codes].sort().map((code) => ({ code, udp: all.filter((o) => o.country === code) }));
}

/** `countryList` — готовый список страны у книги правил (`RuleBook.countryList`). */
export function startShare(config: Config, deps: { consumers: Consumers; sites: Sites; outlets: Outlet[]; countryList: (code: string) => string[]; allowTcp?: () => string[]; log: Logger }): Share | null {
  if (!config.share.enabled) return null;
  const log = deps.log.child({ src: 'share' });
  let store: ShareStore;
  try {
    store = new ShareStore(config.share.dir);
  } catch (error) {
    log.error(`раздача выключена: не открыть ${config.share.dir} — ${errorText(error)}`);
    return null;
  }
  deps.consumers.useShare(() => store.proxyTokens());
  const edge = new Edge({
    store,
    bin: config.mihomo.bin,
    dir: path.join(config.share.dir, 'edge'),
    listen: config.share.listen,
    port: config.share.port,
    controller: config.share.controller,
    proxy: { host: config.http.listen === '0.0.0.0' ? '127.0.0.1' : config.http.listen, port: config.http.port },
    udp: () => udpOutlets(config, deps.outlets).filter((o) => !o.onRequest),
    countries: () => countryUdp(config, deps.outlets, store),
    probeUrl: `http://${config.health.probeHost}${config.health.probePath}`,
    allowTcp: deps.allowTcp,
    log,
  });
  edge.start();
  const rules = new ShareRules({ sites: deps.sites, dnsDir: config.lan.dataDir, skip: config.lan.subnetSkip, store, countryList: deps.countryList });
  const allowed = config.share.countries;
  const server: http.Server = startShareServer({ listen: config.share.listen, port: config.share.listPort, store, rules, allowed, log });
  return {
    store,
    edge,
    rules,
    outlets: deps.outlets,
    ports: { edge: config.share.port, list: config.share.listPort },
    allowed,
    countries: () => outletCountries(deps.outlets, allowed),
    async stop() {
      server.close();
      await edge.stop();
    },
  };
}
