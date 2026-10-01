import { readFileSync } from 'node:fs';
import { MAC } from './arp.ts';

/**
 * Шлюз для устройств домашней сети — то, что общее у трёх сторон.
 *
 * Устройство вручную ставит маршрутизатором `lan.address`, и ядро сервера само
 * пересылает его пакеты: заблокированное — в туннель выхода, остальное —
 * напрямую к роутеру. Любой протокол и порт: голос Discord, бои, QUIC.
 *
 * - помощник от root (`root/gateway.ts`) пишет этот файл и правила nft;
 * - `contour-dns` (`dns/gateway.ts`) читает его, чтобы знать, кто шлюз, и
 *   кладёт адреса заблокированных имён в набор «через VPN»;
 * - панель показывает режимы и меняет их через помощника.
 *
 * Режим — по MAC (`arp.ts`): адрес устройство в режиме шлюза ставит себе
 * вручную и может поменять, MAC остаётся.
 */

/** `blocked` — через VPN только заблокированное; `all` — всё (и без VPN — никак). Нет записи — шлюз выключен. */
export type GatewayMode = 'blocked' | 'all';
export type GatewayState = { devices: Record<string, GatewayMode> };

/** root:contour 640 — DNS и Contour читают, пишет только помощник. */
export const GATEWAY_FILE = '/etc/contour/gateway.json';
/** Подсети «через VPN» для режима `blocked` (голос Discord, звонки) — пишет помощник по слову DNS (`dns/subnets.ts`). */
export const GATEWAY_NETS_FILE = '/etc/contour/gateway-nets.json';

/** Метка соединения «через VPN» и «напрямую» и таблица маршрутов шлюза. Та же таблица — в deploy/contour-netns.sh. */
export const GW_MARK_VPN = 0x2c1;
export const GW_MARK_DIRECT = 0x2c2;
export const GW_TABLE = 2701;

export function parseGateway(text: string): GatewayState {
  const devices: Record<string, GatewayMode> = {};
  try {
    const raw = (JSON.parse(text) as { devices?: Record<string, unknown> }).devices ?? {};
    for (const [mac, mode] of Object.entries(raw)) {
      const m = mac.toLowerCase();
      if (MAC.test(m) && (mode === 'blocked' || mode === 'all')) devices[m] = mode;
    }
  } catch {
    // мусор — шлюз выключен, а не упал
  }
  return { devices };
}

export function readGateway(file = GATEWAY_FILE): GatewayState {
  try {
    return parseGateway(readFileSync(file, 'utf8'));
  } catch {
    return { devices: {} };
  }
}
