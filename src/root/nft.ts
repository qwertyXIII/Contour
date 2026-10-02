import { run, runInput } from './sys.ts';

/**
 * Общее у сторон шлюза в помощнике (`gateway.ts` — устройства и правила,
 * `gateway-classes.ts` — классы маршрута, `gateway-routes.ts` — их таблицы):
 * имя таблицы nft и запуск команд одной транзакцией.
 */

export class GatewayError extends Error {}

export const TABLE = 'contour_gw';

export const hex = (n: number): string => `0x${n.toString(16)}`;

/** Команды nft одной транзакцией (`nft -f -`): либо всё, либо ничего. */
export async function nft(text: string): Promise<void> {
  const r = await runInput('nft', ['-f', '-'], text);
  if (r.code !== 0) throw new GatewayError(`nft: ${(r.err || r.out).trim().split('\n').slice(0, 3).join(' · ')}`);
}

export async function tableExists(): Promise<boolean> {
  return (await run('nft', ['list', 'table', 'ip', TABLE])).code === 0;
}

/** Элементы набора как есть из `nft -j`: адрес, MAC или число; нет набора — пусто. */
export async function setElements(set: string): Promise<unknown[]> {
  const r = await run('nft', ['-j', 'list', 'set', 'ip', TABLE, set]);
  if (r.code !== 0) return [];
  try {
    const items = (JSON.parse(r.out) as { nftables?: Array<{ set?: { elem?: unknown[] } }> }).nftables ?? [];
    return items.flatMap((i) => i.set?.elem ?? []);
  } catch {
    return [];
  }
}
