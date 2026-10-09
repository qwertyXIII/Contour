import type { Socket } from 'node:net';
import type { LanClient } from '../config.ts';
import type { Chooser } from '../select/chooser.ts';

/**
 * Состояние для клиента входа: `GET http://<адрес Contour>/__contour/status`.
 *
 * Проверке перед ходом у клиента (шлюз агентов) надо отличать три поломки, а не
 * валить их в одну строку: соединение не открылось — Contour не отвечает;
 * `503` здесь — Contour жив, но живого выхода в стране клиента нет (в другую
 * страну он не уйдёт); `200` — выход есть, дальше дело сайта. Только клиентам
 * входа: дому это не нужно, а состав выходов — не для всех.
 */

export const STATUS_PATH = '/__contour/status';
const STATUS_LINE = /^GET \/__contour\/status(?:[?\s])/;
/** Ключ выбора: под ним не живёт ни один сайт, прилипание его не касается. */
const STATUS_HOST = 'contour-status.invalid';

export type ClientStatus = {
  ok: boolean;
  client: string;
  country: string | null;
  outlets: Array<{ name: string; country: string | null; state: string }>;
};

export function isStatusRequest(head: Buffer): boolean {
  return STATUS_LINE.test(head.subarray(0, 64).toString('latin1'));
}

/** Выходы, которые выбор попробовал бы для клиента; годен хоть один живой (или ещё не проверенный после запуска). */
export function clientStatus(client: LanClient, chooser: Pick<Chooser, 'order'>, now = Date.now()): ClientStatus {
  const need = client.country ? { country: client.country } : {};
  const outlets = chooser.order(STATUS_HOST, 443, now, need).map((o) => ({ name: o.name, country: o.country ?? null, state: o.state }));
  return { ok: outlets.some((o) => o.state === 'alive' || o.state === 'unknown'), client: client.name, country: client.country, outlets };
}

export function replyStatus(socket: Socket, status: ClientStatus): void {
  const json = JSON.stringify(status);
  socket.end(`HTTP/1.1 ${status.ok ? '200 OK' : '503 Service Unavailable'}\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
