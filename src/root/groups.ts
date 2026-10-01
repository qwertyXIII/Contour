import type { OutletConfig } from '../config.ts';
import { readOutlets, setOutletField } from './config-edit.ts';
import { run, systemctl, unitState } from './sys.ts';

/**
 * Группы соперников — сторона помощника от root.
 *
 * Соперники — выходы, которые нельзя держать вместе: AmneziaWG и OpenVPN одного
 * аккаунта у провайдера выбивают друг друга (владелец, 2026-10-01). В группе
 * работает ровно один; остальные включены в настройках, но их unit'ы стоят и
 * не стартуют при загрузке — это запасные. Кого поднять, когда работающий
 * упал, решает Contour (`outlets/rivals.ts`), а неравенство «не больше одного»
 * держит помощник: только он запускает unit'ы, и каждая команда сначала гасит
 * соперников, потом поднимает своего.
 */

export class GroupError extends Error {}

export type Member = { name: string; priority: number; enabled: boolean; running: boolean };

/** Кому работать в группе: работающий включённый остаётся; нет такого — включённый с меньшим приоритетом. */
export function keeper(members: Member[]): string | null {
  const enabled = members.filter((m) => m.enabled).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  return (enabled.find((m) => m.running) ?? enabled[0])?.name ?? null;
}

const units = (name: string): string[] => [`contour-netns@${name}.service`, `contour-socks@${name}.service`];

export async function isRunning(name: string): Promise<boolean> {
  const s = await unitState(units(name)[0] as string);
  return s === 'active' || s === 'activating';
}

/** Погасить и не поднимать при загрузке. Ошибки — мимо: погасить уже погашенное не беда. */
export async function stopUnits(name: string): Promise<void> {
  await run('systemctl', ['disable', '--now', ...[...units(name)].reverse()]);
}

export async function startUnits(name: string): Promise<void> {
  for (const u of units(name)) await systemctl('enable', '--now', u);
}

export async function members(configPath: string, group: string): Promise<Array<Member & { config: OutletConfig }>> {
  const list = readOutlets(configPath).filter((o) => o.group === group);
  return Promise.all(list.map(async (o) => ({ name: o.name, priority: o.priority, enabled: o.enabled, running: await isRunning(o.name), config: o })));
}

/**
 * Поднять выход вместо соперников. Не поднялся — вернуть того, кто работал:
 * группа без работающего выхода хуже группы со старым.
 */
export async function activate(configPath: string, name: string): Promise<void> {
  const all = readOutlets(configPath);
  const o = all.find((x) => x.name === name);
  if (!o) throw new GroupError(`выхода «${name}» нет`);
  if (!o.group) throw new GroupError(`«${name}» не в группе соперников — он и так работает, если включён`);
  if (!o.enabled) throw new GroupError(`«${name}» выключен — сначала включи`);
  const group = await members(configPath, o.group);
  const was = group.filter((m) => m.running && m.name !== name);
  for (const m of was) await stopUnits(m.name);
  try {
    await startUnits(name);
  } catch (error) {
    await stopUnits(name);
    for (const m of was) await startUnits(m.name).catch(() => undefined);
    throw error;
  }
}

/** Привести группу к «работает ровно один включённый» — после правки группы или вкл/выкл. */
export async function settle(configPath: string, group: string): Promise<void> {
  const list = await members(configPath, group);
  const keep = keeper(list);
  for (const m of list) if (m.running && m.name !== keep) await stopUnits(m.name);
  if (keep && !list.find((m) => m.name === keep)?.running) await startUnits(keep);
}

/**
 * Поставить выход в одну группу с другим (`withName`) или вывести из группы (null).
 * Имя группы — уже существующее у одного из двоих, иначе по имени второго.
 */
export async function setGroup(configPath: string, name: string, withName: string | null): Promise<string[]> {
  const all = readOutlets(configPath);
  const o = all.find((x) => x.name === name);
  if (!o) throw new GroupError(`выхода «${name}» нет`);
  if (o.kind !== 'netns') throw new GroupError('соперниками бывают только ядерные выходы: выходы mihomo живут в одном процессе');
  const touched = new Set<string>();
  if (withName === null) {
    if (!o.group) return [];
    const rest = all.filter((x) => x.group === o.group && x.name !== name);
    setOutletField(configPath, name, 'group', null);
    touched.add(o.group);
    // Один в группе — уже не группа.
    const freed = [o];
    if (rest.length === 1) {
      setOutletField(configPath, (rest[0] as OutletConfig).name, 'group', null);
      freed.push(rest[0] as OutletConfig);
    } else {
      await settle(configPath, o.group);
    }
    // Вне группы включённый выход работает всегда — как любой другой (соперничество снял владелец).
    for (const f of freed) if (f.enabled && !(await isRunning(f.name))) await startUnits(f.name);
    return [...touched];
  }
  const w = all.find((x) => x.name === withName);
  if (!w || w.name === name) throw new GroupError(`соперник «${withName}» — другой существующий выход`);
  if (w.kind !== 'netns') throw new GroupError('соперниками бывают только ядерные выходы');
  const group = w.group ?? o.group ?? w.name;
  if (o.group && o.group !== group) touched.add(o.group);
  setOutletField(configPath, name, 'group', group);
  setOutletField(configPath, w.name, 'group', group);
  touched.add(group);
  for (const g of touched) await settle(configPath, g);
  return [...touched];
}
