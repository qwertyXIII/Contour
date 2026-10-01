import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config.ts';
import { log } from '../src/log.ts';
import { newOutlet } from '../src/outlets/outlet.ts';
import { PortProbe } from '../src/outlets/ports.ts';
import { Rivals } from '../src/outlets/rivals.ts';
import { Auth, hashPassword } from '../src/panel/auth.ts';
import { GatewayAddresses } from '../src/panel/addresses.ts';
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
ext.ports = { filter: 'filtered', pass: new Set([80, 443, 8443]), cut: new Set([5222, 9339, 25565]), checkedAt: Date.now() - 3_600_000 };
// Соперник ext: тот же аккаунт по OpenVPN — работает он, ext запасной.
const ovpn = mk('corp_ext', 5);
ovpn.state = 'alive'; ovpn.latencyMs = 957; ovpn.externalIp = '198.51.100.20'; ovpn.checkedAt = Date.now();
ovpn.ports = { filter: 'all', pass: new Set(), cut: new Set(), checkedAt: Date.now() - 600_000 };
ext.state = 'standby';
const outlets = [ovpn, ext, spare];
const noDial = async (): Promise<never> => { throw new Error('в проверке выходов нет'); };

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
const state = new PanelState({ config, outlets, meter, devices, speeds, addresses: new GatewayAddresses(dir) });
// Помощника от root в проверке нет — его ответ подставлен, кэш не истекает.
const rt = (name: string, protocol: string, priority: number, group: string | null) => ({ name, kind: 'netns' as const, protocol, enabled: true, priority, group, about: protocol });
(state as unknown as { root: unknown }).root = {
  at: Number.MAX_SAFE_INTEGER,
  error: null,
  data: {
    units: { 'contour.service': 'active', 'contour-dns.service': 'active' },
    outlets: [rt('corp_ext', 'openvpn', 5, 'corp'), rt('ext', 'amneziawg', 10, 'corp'), rt('nl-reality', 'wireguard', 50, null)],
  },
};
createPanel({
  listen: '127.0.0.1',
  port: Number(process.env.PORT ?? 18191),
  log,
  auth: new Auth(passwordFile, dir),
  state,
  devices,
  sites: new Sites({ dnsDir: dir, own: config.lan.domains }),
  speeds,
  meter,
  outlets,
  dial: noDial,
  ports: new PortProbe(outlets, { dial: noDial, host: 'portquiz.net', intervalMs: 86_400_000, needed: [9339], file: path.join(dir, 'outlet-ports.json'), log }),
  rivals: new Rivals(outlets, [], { log, activate: async () => { throw new Error('в проверке помощника нет'); }, isRunning: async () => true, onActivated: () => {} }),
});
