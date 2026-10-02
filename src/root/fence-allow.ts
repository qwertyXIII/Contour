import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatCidr, parseCidr } from '../cidr.ts';
import { isPrivateV4 } from '../inlets/fence.ts';
import { readOutlets, CONFIG_PATH } from './config-edit.ts';
import { CommandError } from './outlets.ts';
import { run, unitState } from './sys.ts';

/**
 * Исключения ограды SOCKS внутри namespace выхода — команда `outlet.fence`.
 *
 * Ограда в namespace режет частные сети (`FENCE_V4` в `contour-netns.sh`): UDP
 * раздачи приходит туда мимо Contour. Единственное исключение — подсети правил
 * «только через этот выход» (корпоративная сеть владельца, решение 2026-10-02):
 * Contour присылает весь набор «выход → подсети», помощник кладёт файл на
 * выход (`/etc/contour/fence-allow/<имя>`) и пересобирает SOCKS тех выходов,
 * у которых набор сменился, — `contour-netns socks` с проверкой `mihomo -t` и
 * откатом. Только частные подсети: публичные ограда и так пропускает.
 */

export const FENCE_ALLOW_DIR = '/etc/contour/fence-allow';
const NETNS = '/opt/contour/sbin/contour-netns';
const MAX_NETS = 64;

function clean(nets: unknown): string[] {
  if (!Array.isArray(nets) || nets.length > MAX_NETS) throw new CommandError(`подсети — список до ${MAX_NETS}`);
  return [...new Set(nets.map((n) => {
    const c = typeof n === 'string' ? parseCidr(n) : null;
    if (!c || c.bits < 8) throw new CommandError(`«${String(n).slice(0, 40)}» — не подсеть IPv4 (не шире /8)`);
    const text = formatCidr(c);
    if (!isPrivateV4(text.split('/')[0] as string)) throw new CommandError(`${text} — не частная: исключение ограды нужно только частным`);
    return text;
  }))].sort();
}

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Весь набор разом; выход не назван — исключений у него нет. Возвращает, чьи SOCKS пересобраны. */
export async function setFenceAllow(args: { outlets: unknown }, dir = FENCE_ALLOW_DIR): Promise<{ changed: string[]; failed: string[] }> {
  if (!args.outlets || typeof args.outlets !== 'object') throw new CommandError('outlets — {выход: [подсети]}');
  const netns = new Set(readOutlets(CONFIG_PATH).filter((o) => o.kind === 'netns').map((o) => o.name));
  const wanted = new Map<string, string>();
  for (const [name, nets] of Object.entries(args.outlets as Record<string, unknown>)) {
    if (!netns.has(name)) throw new CommandError(`«${name}» — не выход в namespace`);
    const list = clean(nets);
    if (list.length > 0) wanted.set(name, `${list.join('\n')}\n`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const changed: string[] = [];
  for (const name of new Set([...netns, ...readdirSync(dir)])) {
    const file = path.join(dir, name);
    const want = wanted.get(name) ?? '';
    if (read(file) === want) continue;
    if (want) writeFileSync(file, want, { mode: 0o644 });
    else rmSync(file, { force: true });
    if (netns.has(name)) changed.push(name);
  }
  // Пересобрать SOCKS поднятых: у неподнятого конфиг соберётся при подъёме.
  const failed: string[] = [];
  for (const name of changed) {
    if ((await unitState(`contour-socks@${name}.service`)) !== 'active') continue;
    const r = await run(NETNS, ['socks', name]);
    if (r.code !== 0) failed.push(name);
  }
  return { changed, failed };
}
