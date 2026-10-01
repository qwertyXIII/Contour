import dgram from 'node:dgram';
import { errorText, type Logger } from '../log.ts';
import { matchesDomain } from './lan-match.ts';

/**
 * Подсказки от DNS: какое имя устройство только что спросило.
 *
 * У игр (Brawl Stars — TCP 9339) нет имени в соединении: ни SNI, ни Host.
 * Но DNS знает, что это устройство секунду назад спросило
 * `game.brawlstarsgame.com` и получило наш адрес. `contour-dns` шлёт такую
 * подсказку датаграммой на `127.0.0.1:<hintPort>`, Contour держит последние
 * имена каждого устройства несколько минут и по ним решает, куда вести.
 * Отдельные процессы — поэтому датаграмма, а не общий файл: подсказка нужна
 * через миллисекунды, а теряется — не беда (следующий DNS-запрос пришлёт новую).
 */

export type Hint = { name: string; t: number };
export type PortRule = { port: number; hosts: string[] };

const TTL_MS = 10 * 60_000;
const PER_CLIENT = 40;
/** `game.brawlstarsgame.com`, `gamea.clashofclans.com` — но не `game-assets.…`. */
const GAME_SERVER = /^game[a-z0-9]*\./;

export class Hints {
  private readonly byClient = new Map<string, Hint[]>();

  add(client: string, name: string, now = Date.now()): void {
    const list = (this.byClient.get(client) ?? []).filter((h) => h.name !== name && now - h.t < TTL_MS);
    list.push({ name, t: now });
    if (list.length > PER_CLIENT) list.splice(0, list.length - PER_CLIENT);
    this.byClient.set(client, list);
  }

  /**
   * Куда вести соединение устройства на порт правила: среди недавних имён этого
   * устройства — подходящие правилу; первыми — игровые сервера (у Supercell
   * это `game.` и `gamea.`, а рядом в DNS — картинки и магазин, в том числе
   * `game-assets.`), дальше — самое свежее.
   */
  pick(client: string, rule: PortRule, now = Date.now()): string | null {
    const fresh = (this.byClient.get(client) ?? []).filter((h) => now - h.t < TTL_MS && matchesDomain(h.name, rule.hosts));
    if (fresh.length === 0) return null;
    fresh.sort((a, b) => Number(GAME_SERVER.test(b.name)) - Number(GAME_SERVER.test(a.name)) || b.t - a.t);
    return fresh[0]?.name ?? null;
  }

  /** Слушать подсказки от `contour-dns`. Только с 127.0.0.1 — больше ниоткуда. */
  listen(port: number, log: Logger): dgram.Socket {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== '127.0.0.1') return;
      try {
        const j = JSON.parse(msg.toString()) as { c?: unknown; n?: unknown };
        if (typeof j.c === 'string' && typeof j.n === 'string') this.add(j.c, j.n);
      } catch {
        // мусор — молча мимо
      }
    });
    socket.on('error', (e) => log.error(`подсказки DNS: ${errorText(e)}`));
    socket.bind(port, '127.0.0.1', () => log.info(`подсказки DNS слушают 127.0.0.1:${port}/udp`));
    return socket;
  }
}

/** Отправитель подсказок — для `contour-dns`. */
export function hintSender(port: number): (client: string, name: string) => void {
  const socket = dgram.createSocket('udp4');
  socket.unref();
  return (client, name) => {
    socket.send(JSON.stringify({ c: client, n: name }), port, '127.0.0.1', () => undefined);
  };
}
