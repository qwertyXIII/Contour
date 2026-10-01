import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config.ts';
import { log } from '../src/log.ts';
import { newOutlet } from '../src/outlets/outlet.ts';
import { Auth, hashPassword } from '../src/panel/auth.ts';
import { Devices } from '../src/panel/devices.ts';
import { createPanel } from '../src/panel/server.ts';
import { Sites } from '../src/panel/sites.ts';
import type { SpeedResult } from '../src/panel/speedtest.ts';
import { PanelState } from '../src/panel/state.ts';
import { Meter } from '../src/stats/meter.ts';

/**
 * Панель на выдуманных данных — проверить страницу в браузере, не трогая
 * живой Contour: свои временные файлы, свой порт, пароль `smoke-password`.
 * Помощника от root нет — панель честно скажет, что он недоступен.
 *
 *   PORT=18191 node scripts/panel-smoke.ts
 */

const dir = mkdtempSync(path.join(tmpdir(), 'contour-panel-'));
const passwordFile = path.join(dir, 'panel.json');
writeFileSync(passwordFile, JSON.stringify(await hashPassword('smoke-password')));
writeFileSync(path.join(dir, 'dns-learned.json'), JSON.stringify({ 'www.linkedin.com': { via: 'tunnel', why: 'напрямую молчит, через VPN открывается', until: Date.now() + 86_400_000 } }));
writeFileSync(path.join(dir, 'blocked-domains.lst'), 'instagram.com\nx.com\n');

const mk = (name: string, priority: number) => newOutlet({ name, kind: 'netns', bridge: 1, protocol: 'amneziawg', conf: '/x', env: null, dns: [], mtu: null, priority, enabled: true }, 1);
const ext = mk('ext', 10);
ext.state = 'alive'; ext.latencyMs = 372; ext.externalIp = '198.51.100.30'; ext.checkedAt = Date.now();
const spare = mk('nl-reality', 50);
spare.state = 'dead'; spare.lastError = 'молчит';
const outlets = [ext, spare];

const meter = new Meter({ dir, log });
const now = Date.now();
(meter as unknown as { history: unknown[] }).history = Array.from({ length: 24 * 60 }, (_, i) => ({
  t: Math.floor((now - (24 * 60 - i) * 60_000) / 60_000) * 60_000,
  all: Math.round(2e7 * (1 + Math.sin(i / 90))),
  byOutlet: { ext: Math.round(2e7 * (1 + Math.sin(i / 90))) },
  byWho: {},
}));
setInterval(() => {
  meter.add('lan:192.168.0.105', 'ext', 'rr3---sn-abc.googlevideo.com', 20_000, 2_500_000);
  meter.add('alter', 'ext', 'x.com', 500, 12_000);
}, 200).unref();

const config = { ...DEFAULTS, lan: { ...DEFAULTS.lan, enabled: true } };
const speeds = new Map<string, SpeedResult>();
const devices = new Devices(dir);
createPanel({
  listen: '127.0.0.1',
  port: Number(process.env.PORT ?? 18191),
  log,
  auth: new Auth(passwordFile, dir),
  state: new PanelState({ config, outlets, meter, devices, speeds }),
  devices,
  sites: new Sites({ dnsDir: dir, own: config.lan.domains }),
  speeds,
  meter,
  outlets,
  dial: async () => { throw new Error('в проверке выходов нет'); },
});
