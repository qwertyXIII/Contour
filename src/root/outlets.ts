import { chownSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OutletConfig, OutletProtocol } from '../config.ts';
import { describeLink, parseLink } from '../outlets/links.ts';
import { decodeVpnLink, describeProfile, parseWgConf } from '../outlets/profile.ts';
import { addOutlet, freeBridge, readOutlets, removeOutlet, setOutletField } from './config-edit.ts';
import type { AddSource, OutletRuntime, OvpnAuth, RootStatus } from './protocol.ts';
import { activate, isRunning, setGroup, settle } from './groups.ts';
import { groupId, netnsRuntime, run, systemctl, unitState } from './sys.ts';
import { checkOvpn } from './ovpn-check.ts';

/**
 * Команды помощника над выходами. Каждая проверяет вход сама: помощник от root
 * не верит панели. Ошибка посреди добавления откатывает сделанное — выход либо
 * добавлен целиком, либо его нет.
 */

export const CONFIG_PATH = '/etc/contour/contour.yaml';
export const KEYS = '/etc/contour/keys';
const REMOVED = path.join(KEYS, 'removed');
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_TEXT = 200 * 1024;

export class CommandError extends Error {}

/**
 * Перезапуск Contour — после ответа, а не до: панель живёт внутри Contour, и
 * перезапуск до ответа оборвал бы её запрос на полуслове. Панель увидит
 * короткий обрыв и подождёт, пока Contour вернётся.
 */
function restartContourSoon(): void {
  setTimeout(() => { void systemctl('restart', 'contour.service').catch(() => undefined); }, 500).unref();
}

function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new CommandError('имя выхода: латиница в нижнем регистре, цифры, «-» и «_», до 32 знаков');
  return name;
}

function find(name: string): OutletConfig {
  const o = readOutlets(CONFIG_PATH).find((x) => x.name === name);
  if (!o) throw new CommandError(`выхода «${name}» нет`);
  return o;
}

/** Файл ключа: root:contour 640 — Contour читает, никто другой. */
function writeKey(file: string, text: string): void {
  mkdirSync(KEYS, { recursive: true });
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o640 });
  chownSync(file, 0, groupId('contour'));
}

/** Секрет только для root (логин и пароль OpenVPN): 600, Contour его не читает — нужен лишь openvpn. */
function writeSecret(file: string, text: string): void {
  mkdirSync(KEYS, { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  chownSync(file, 0, 0);
}

/** `secrets` — файлы только для root; при откате уезжают вместе с остальными. */
type Planned = { entry: Record<string, unknown>; files: Array<[string, string]>; secrets?: Array<[string, string]>; netns: boolean; about: string };

/** Логин и пароль — по строке в файле: без переводов строк и нулей, иначе openvpn прочтёт не то. */
function checkAuth(auth: unknown): OvpnAuth | null {
  if (auth === undefined || auth === null) return null;
  const ok = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\r\n\0]/.test(v);
  const a = auth as Partial<OvpnAuth>;
  if (!ok(a.user) || !ok(a.pass)) throw new CommandError('логин и пароль — по одной строке, до 256 знаков');
  return { user: a.user, pass: a.pass };
}

function planConf(name: string, raw: string, priority: number, bridge: number): Planned {
  const text = raw.trim().startsWith('vpn://') ? decodeVpnLink(raw).conf : raw;
  const profile = parseWgConf(text);
  if (!profile.peer.allowedIps.includes('0.0.0.0/0')) throw new CommandError('AllowedIPs без 0.0.0.0/0 — это split-tunnel, выходом в интернет он не будет');
  if (profile.addresses.length === 0) throw new CommandError('в конфиге нет Address');
  const protocol: OutletProtocol = Object.keys(profile.amnezia).length > 0 ? 'amneziawg' : 'wireguard';
  const conf = path.join(KEYS, `${name}.conf`);
  return {
    entry: { name, kind: 'netns', bridge, protocol, conf, priority, enabled: true },
    files: [[conf, text], [path.join(KEYS, `${name}.netns`), `PROTO=${protocol}\nBRIDGE=${bridge}\n`]],
    netns: true,
    about: describeProfile({ ...profile, addresses: profile.addresses }),
  };
}

function planOvpn(name: string, text: string, priority: number, bridge: number, auth: OvpnAuth | null): Planned {
  const about = checkOvpn(text, auth !== null);
  const conf = path.join(KEYS, `${name}.ovpn`);
  return {
    entry: { name, kind: 'netns', bridge, protocol: 'openvpn', conf, priority, enabled: true },
    files: [[conf, text], [path.join(KEYS, `${name}.netns`), `PROTO=openvpn\nBRIDGE=${bridge}\n`]],
    secrets: auth ? [[path.join(KEYS, `${name}.auth`), `${auth.user}\n${auth.pass}\n`]] : [],
    netns: true,
    about: auth ? `${about}, с логином` : about,
  };
}

function planLink(name: string, text: string, priority: number): Planned {
  const link = parseLink(text);
  const conf = path.join(KEYS, `${name}.link`);
  return { entry: { name, kind: 'mihomo', protocol: 'link', conf, priority, enabled: true }, files: [[conf, text.trim()]], netns: false, about: describeLink(link) };
}

function planSubscription(name: string, text: string, priority: number): Planned {
  const url = text.trim();
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new CommandError('подписка — одна ссылка http(s)://');
  const conf = path.join(KEYS, `${name}.sub`);
  return { entry: { name, kind: 'mihomo', protocol: 'subscription', conf, priority, enabled: true }, files: [[conf, url]], netns: false, about: `подписка ${new URL(url).host}` };
}

function plan(name: string, source: AddSource, text: string, priority: number, auth: OvpnAuth | null): Planned {
  const bridge = freeBridge(readOutlets(CONFIG_PATH));
  if (auth && source !== 'ovpn') throw new CommandError('логин и пароль бывают только у OpenVPN');
  if (source === 'conf') return planConf(name, text, priority, bridge);
  if (source === 'ovpn') return planOvpn(name, text, priority, bridge, auth);
  if (source === 'link') return planLink(name, text, priority);
  if (source === 'subscription') return planSubscription(name, text, priority);
  throw new CommandError('источник: conf, ovpn, link или subscription');
}

export async function addOutletCmd(args: { name: unknown; source: unknown; text: unknown; priority?: unknown; auth?: unknown }): Promise<{ about: string }> {
  const name = checkName(args.name);
  if (typeof args.text !== 'string' || args.text.trim() === '' || args.text.length > MAX_TEXT) throw new CommandError('ключ пустой или длиннее 200 КБ');
  const priority = typeof args.priority === 'number' && Number.isInteger(args.priority) && args.priority >= 0 && args.priority <= 10_000 ? args.priority : 100;
  if (readOutlets(CONFIG_PATH).some((o) => o.name === name)) throw new CommandError(`выход «${name}» уже есть`);
  const p = plan(name, args.source as AddSource, args.text, priority, checkAuth(args.auth));

  for (const [file, text] of p.files) writeKey(file, text);
  for (const [file, text] of p.secrets ?? []) writeSecret(file, text);
  try {
    if (p.netns) {
      await systemctl('enable', '--now', `contour-netns@${name}.service`);
      await systemctl('enable', '--now', `contour-socks@${name}.service`);
    }
    addOutlet(CONFIG_PATH, p.entry);
  } catch (error) {
    await rollback(name, p);
    throw error;
  }
  restartContourSoon();
  return { about: p.about };
}

async function rollback(name: string, p: Planned): Promise<void> {
  if (p.netns) await run('systemctl', ['disable', '--now', `contour-socks@${name}.service`, `contour-netns@${name}.service`]);
  for (const [file] of [...p.files, ...(p.secrets ?? [])]) if (existsSync(file)) moveAway(file);
}

/** Удалённое не стирается — уезжает в keys/removed с отметкой времени: ошибку можно отменить руками. */
function moveAway(file: string): void {
  mkdirSync(REMOVED, { recursive: true, mode: 0o700 });
  renameSync(file, path.join(REMOVED, `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(file)}`));
}

export async function removeOutletCmd(args: { name: unknown }): Promise<void> {
  const name = checkName(args.name);
  const o = find(name);
  if (o.kind === 'netns') await run('systemctl', ['disable', '--now', `contour-socks@${name}.service`, `contour-netns@${name}.service`]);
  removeOutlet(CONFIG_PATH, name);
  for (const f of readdirSync(KEYS)) if (f.startsWith(`${name}.`)) moveAway(path.join(KEYS, f));
  // Удалили работавшего соперника — группа поднимает следующего.
  if (o.group) await settle(CONFIG_PATH, o.group);
  restartContourSoon();
}

export async function restartOutletCmd(args: { name: unknown }): Promise<void> {
  const name = checkName(args.name);
  const o = find(name);
  if (o.group && !(await isRunning(name))) throw new CommandError(`«${name}» — запасной: поднять его вместо соперника — «Сделать основным»`);
  if (o.kind === 'netns') {
    await systemctl('restart', `contour-netns@${name}.service`);
    await systemctl('restart', `contour-socks@${name}.service`);
  } else {
    restartContourSoon();
  }
}

export async function enableOutletCmd(args: { name: unknown; enabled: unknown }): Promise<void> {
  const name = checkName(args.name);
  if (typeof args.enabled !== 'boolean') throw new CommandError('enabled — true или false');
  const o = find(name);
  setOutletField(CONFIG_PATH, name, 'enabled', args.enabled);
  if (o.group) {
    // В группе соперников включённый становится запасным, если кто-то уже работает;
    // выключенный работавший уступает место следующему.
    await settle(CONFIG_PATH, o.group);
  } else if (o.kind === 'netns') {
    const verb = args.enabled ? 'enable' : 'disable';
    await systemctl(verb, '--now', `contour-netns@${name}.service`);
    await systemctl(verb, '--now', `contour-socks@${name}.service`);
  }
  restartContourSoon();
}

/** Поднять выход вместо соперников по группе. Contour не перезапускается: о смене он знает сам — он её и попросил. */
export async function activateOutletCmd(args: { name: unknown }): Promise<void> {
  await activate(CONFIG_PATH, checkName(args.name));
}

export async function groupOutletCmd(args: { name: unknown; with: unknown }): Promise<void> {
  const name = checkName(args.name);
  const other = args.with === null ? null : checkName(args.with);
  await setGroup(CONFIG_PATH, name, other);
  restartContourSoon();
}

export async function priorityOutletCmd(args: { name: unknown; priority: unknown }): Promise<void> {
  const name = checkName(args.name);
  const p = args.priority;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 10_000) throw new CommandError('приоритет — целое от 0 до 10000');
  find(name);
  setOutletField(CONFIG_PATH, name, 'priority', p);
  restartContourSoon();
}

const UNITS = ['contour.service', 'contour-dns.service', 'contour-addr.service', 'contour-root.service'];

export function restartContourCmd(): void {
  restartContourSoon();
}

export async function statusCmd(): Promise<RootStatus> {
  const units: Record<string, string> = {};
  for (const u of UNITS) units[u] = await unitState(u);
  const outlets: OutletRuntime[] = [];
  for (const o of readOutlets(CONFIG_PATH)) {
    const base: OutletRuntime = { name: o.name, kind: o.kind, protocol: o.protocol, enabled: o.enabled, priority: o.priority, group: o.group, about: o.protocol };
    if (o.kind === 'netns' && o.bridge !== null) {
      Object.assign(base, await netnsRuntime(o.name, o.bridge, o.protocol));
      units[`contour-netns@${o.name}.service`] = await unitState(`contour-netns@${o.name}.service`);
      units[`contour-socks@${o.name}.service`] = await unitState(`contour-socks@${o.name}.service`);
    }
    outlets.push(base);
  }
  return { units, outlets };
}
