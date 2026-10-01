import type http from 'node:http';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Consumers } from '../consumers.ts';
import { errorText, type Logger } from '../log.ts';
import type { Sites } from '../panel/sites.ts';
import { Edge } from './edge.ts';
import { ShareRules } from './rules.ts';
import { startShareServer } from './server.ts';
import { ShareStore } from './store.ts';

/**
 * Раздача целиком: устройства, край, правила по ссылке. Contour без неё
 * работает как раньше (`share.enabled: false`), и сбой края — запись в журнале,
 * а не падение: прокси для программ и дом от раздачи не зависят.
 */

/** `ports` — куда nginx ведёт домен раздачи: `/` — край, `/list/` — правила. */
export type Share = { store: ShareStore; edge: Edge; ports: { edge: number; list: number }; stop(): Promise<void> };

export function startShare(config: Config, deps: { consumers: Consumers; sites: Sites; log: Logger }): Share | null {
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
    log,
  });
  edge.start();
  const rules = new ShareRules({ sites: deps.sites, dnsDir: config.lan.dataDir, skip: config.lan.subnetSkip });
  const server: http.Server = startShareServer({ listen: config.share.listen, port: config.share.listPort, store, rules, log });
  return {
    store,
    edge,
    ports: { edge: config.share.port, list: config.share.listPort },
    async stop() {
      server.close();
      await edge.stop();
    },
  };
}
