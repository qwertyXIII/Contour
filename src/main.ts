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
import { makeDial, type Blocked, type FenceAllow } from './outlets/connect.ts';
import { OutletDns } from './outlets/outlet-dns.ts';
import { buildMihomoConfig } from './outlets/mihomo-config.ts';
import { runMihomo, type MihomoHandle } from './outlets/mihomo.ts';
import { prepareOutlets, reloadNetnsPassword, type Outlet } from './outlets/outlet.ts';
import { PortProbe } from './outlets/ports.ts';
import { Rivals } from './outlets/rivals.ts';
import { rootCall } from './root/protocol.ts';
import { Resolver } from './outlets/resolver.ts';
import { Chooser, type ExitNeed } from './select/chooser.ts';
import { Auth } from './panel/auth.ts';
import { GatewayAddresses } from './panel/addresses.ts';
import { Devices } from './panel/devices.ts';
import { createPanel, type Panel } from './panel/server.ts';
import { Sites } from './panel/sites.ts';
import { speedTest, type SpeedResult } from './panel/speedtest.ts';
import { PanelState } from './panel/state.ts';
import type { PanelRules } from './panel/rules-routes.ts';
import { startRules } from './rules/index.ts';
import { siteOf } from './rules/service-index.ts';
import { OutcomeBook } from './select/outcomes.ts';
import { SpeedBook } from './select/speed.ts';
import { SpeedProbe } from './select/speed-probe.ts';
import { startShare, type Share } from './share/index.ts';
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
    const kernel = prepared.outlets.find((o) => !o.direct && !prepared.mihomo.some((m) => m.outlet === o));
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
  // Исключение ограды частных адресов и DNS выхода для имён — у правил («только через»); они поднимаются позже.
  let fenceAllow: FenceAllow = () => false;
  let internalDns: (outlet: string, host: string) => string[] = () => [];
  let blocked: Blocked = () => {};
  const outletDns = new OutletDns();
  const resolver = new Resolver({ internal: (o, name) => internalDns(o.name, name), warn: (text) => log.warn(text) });
  const dial = makeDial(resolver, config.health.connectTimeoutSec * 1000, (ip, o) => fenceAllow(ip, o), (o, host, ips) => blocked(o, host, ips));
  // Соперники — до проверки живости: запасной не поднят, и проверка его не трогает.
  let recheck: ((o: Outlet) => void) | null = null;
  let shareRefresh: (() => void) | null = null;
  let rulesRefresh: (() => void) | null = null;
  let serviceOf: (host: string) => string = siteOf;
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
      // Край раздачи ведёт UDP прямо в SOCKS выходов — у поднятого запасного пароль только теперь.
      shareRefresh?.();
    },
  });
  await rivals.init();
  rivals.start();
  // Самообучение: что открывается через какой выход и страну (select/outcomes.ts);
  // замеры скорости для правил «самый быстрый» (select/speed.ts) и их редкая проба.
  const outcomes = new OutcomeBook({ file: path.join(STATE_DIR, 'outlet-outcomes.json'), log });
  const speed = new SpeedBook({ file: path.join(STATE_DIR, 'outlet-speed.json'), log });
  const health = startHealth(outlets, {
    intervalMs: config.health.intervalSec * 1000,
    connectTimeoutMs: config.health.connectTimeoutSec * 1000,
    probeHost: config.health.probeHost,
    probePath: config.health.probePath,
    ipHost: config.health.ipHost,
    ipIntervalMs: config.health.ipIntervalSec * 1000,
    countryHost: config.health.countryHost,
    // Край раздачи ведёт UDP «страны» прямо в выходы этой страны, а правила «через
    // страну» есть только там, где есть выход, — узнали страну, пересобрать то и другое.
    onCountry: () => { shareRefresh?.(); rulesRefresh?.(); },
    onAlive: (o) => outcomes.exitAlive(o.name),
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
    // Сервис — у правил (группы v2fly или основной домен); правила поднимаются позже.
    serviceOf: (host) => serviceOf(host),
    outcomes,
    speed,
  });
  const speedProbe = new SpeedProbe(speed, {
    log,
    outlets: () => outlets,
    download: async (name, bytes) => {
      const o = outlets.find((x) => x.name === name);
      if (!o) throw new Error('выхода нет');
      const r = await speedTest(o, dial, { bytes, maxMs: 8_000 });
      return { bytes: r.bytes, ms: r.bodyMs, firstByteMs: r.firstByteMs };
    },
  });
  speedProbe.start();
  const consumers = new Consumers(config.tokens, log);
  consumers.load();
  consumers.startFlushing();

  const meter = new Meter({ dir: STATE_DIR, log });
  meter.start();
  const sites = new Sites({ dnsDir: config.lan.dataDir, own: config.lan.domains });
  // Правила «что + куда» — до входов: прокси, SNI и раздача ведут по ним. Свои
  // сайты стран — у раздачи, она поднимается позже (её край ходит в прокси).
  let share: Share | null = null;
  const rules = startRules(config, { sites, outlets, countrySites: () => share?.store.settings().countrySites ?? {}, outletDns: (name) => outletDns.servers(name), log });
  const route = rules.route;
  serviceOf = (host) => rules.services.serviceOf(host);
  fenceAllow = (ip, o) => !o.direct && rules.allowsPrivate(ip, o.name);
  internalDns = (outlet, host) => rules.internalDns(outlet, host);
  blocked = (o, host, ips) => { if (!o.direct) rules.blocked(o.name, host, ips); };
  rulesRefresh = () => rules.book.rebuild();
  // Запись сайтов телефона раздачи — у раздачи, она поднимается позже: вход зовёт её по имени.
  const server = await startHttpInlet({ ...config.http, chooser, consumers, log, meter, ports, route, speed, trace: (who, host, port, o) => share?.trace.note(who, host, port, o) });
  share = startShare(config, { consumers, outlets, countryList: (code) => rules.book.countryList(code), ruleset: () => rules.book.rules(), allowTcp: () => rules.allowNets(), log });
  // Край перезапускается, только когда сменились его исключения ограды: телефоны при этом переподключаются.
  let allowed = rules.allowNets().join(' ');
  rules.book.onChange(() => {
    const now = rules.allowNets().join(' ');
    if (now !== allowed) { allowed = now; shareRefresh?.(); }
  });
  share?.store.onChange(() => rules.book.rebuild());
  shareRefresh = share ? () => share?.edge.refresh() : null;
  const panelRules = { book: rules.book, lists: rules.lists, route, order: (host: string, need: ExitNeed) => chooser.order(host, undefined, Date.now(), need), hints: () => rules.hints(), applyHint: (name: string) => rules.applyHint(name) };
  const panel = config.panel.enabled ? startPanel(config, { outlets, meter, dial, ports, rivals, sites, share, rules: panelRules }) : null;
  const panelHosts = new Set([config.panel.name, config.lan.address]);
  const lanServers = config.lan.enabled
    ? startLanInlet(config.lan, { chooser, consumers, log, meter, ports, route, speed }, panel ? { hosts: panelHosts, take: panel.take } : null)
    : [];
  // Порты игр — по подсказкам DNS (inlets/hints.ts, game-ports.ts).
  const hints = new Hints();
  const hintSocket = config.lan.enabled && config.lan.ports.length > 0 ? hints.listen(config.lan.hintPort, log) : null;
  const gameServers = hintSocket ? startGamePorts(config.lan, hints, { chooser, consumers, log, meter, ports, speed }) : [];
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
    rules.stop();
    outcomes.stop();
    speedProbe.stop();
    speed.stop();
    panel?.server.close();
    server.close();
    server.closeAllConnections();
    for (const s of [...lanServers, ...gameServers]) s.close();
    hintSocket?.close();
    void Promise.allSettled([mihomo?.stop(), share?.stop()]).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 7_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function startPanel(config: ReturnType<typeof loadConfig>, live: { outlets: Outlet[]; meter: Meter; dial: ReturnType<typeof makeDial>; ports: PortProbe; rivals: Rivals; sites: Sites; share: Share | null; rules: PanelRules }): Panel {
  const speeds = new Map<string, SpeedResult>();
  const devices = new Devices(config.panel.dataDir);
  const auth = new Auth(config.panel.passwordFile, config.panel.dataDir);
  if (!auth.configured()) log.warn(`панель: нет пароля (${config.panel.passwordFile}) — войти нельзя; задать: sudo bash deploy/panel-password.sh`);
  const state = new PanelState({ config, outlets: live.outlets, meter: live.meter, devices, speeds, addresses: new GatewayAddresses(config.panel.dataDir), share: live.share?.store ?? null });
  return createPanel({
    listen: config.panel.listen,
    port: config.panel.port,
    log: log.child({ src: 'panel' }),
    auth, state, devices, speeds,
    sites: live.sites,
    share: live.share,
    rules: live.rules,
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
