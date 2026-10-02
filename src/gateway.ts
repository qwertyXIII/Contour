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

/**
 * Куда вести адрес устройства-шлюза (решает движок правил, `dns/gateway.ts`):
 * - `tunnel` — как сейчас: все поднятые туннели по приоритету (`vpn_dst`,
 *   `vpn_net`, таблица 2701);
 * - `direct` — как сейчас «напрямую»: настоящие адреса обычного DNS, в наборы
 *   ничего не кладётся;
 * - иначе — имя класса, объявленного движком правил (`GatewayClass`).
 */
export type GatewayRoute = string;
export const ROUTE_TUNNEL = 'tunnel';
export const ROUTE_DIRECT = 'direct';

/**
 * Класс маршрута — упорядоченный список выходов; придумывает его движок
 * правил, помощник только исполняет: «через страну DE» — выходы DE по
 * приоритету, «только через corp_ext» — он один. Путь — первый поднятый
 * выход списка; упал — следующий; ни одного — `unreachable`: не другой выход
 * и не напрямую. Прямой выход (`direct.name`) в списке — путь через роутер,
 * как у прокси с просьбой его страны.
 */
export type GatewayClass = {
  name: string;
  outlets: string[];
  /**
   * «Только через эти выходы»: прямого выхода в списке быть не может, зато
   * можно частные подсети — единственное исключение из ограды (корпоративная
   * сеть — только корпоративными туннелями, никогда напрямую).
   */
  only?: boolean;
  /** Для показа и журнала: ради какой страны класс (`DE`). */
  country?: string;
  /** Постоянные подсети класса — как `vpn_net` у «как сейчас». */
  nets?: string[];
};

/** Объявленные классы со слотами — пишет только помощник (root:contour 640). */
export const GATEWAY_CLASSES_FILE = '/etc/contour/gateway-classes.json';
/** Слот класса → метка `GW_CLASS_MARK + слот`, таблица и приоритет правила `GW_CLASS_TABLE + слот` — рядом с 2701. */
export const GW_CLASS_MARK = 0x2d0;
export const GW_CLASS_TABLE = 2702;
export const GW_MAX_CLASSES = 32;

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
