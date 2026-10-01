import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Logger } from './log.ts';
import { SHARE_PREFIX } from './share/store.ts';

/**
 * Потребители — те, кому выдан токен.
 *
 * Файл `tokens`: строка `имя:токен`, пустые и `#` пропускаются. Перечитывается
 * сам, когда меняется на диске (не чаще раза в 5 с), — отзыв токена не
 * требует перезапуска. Трафик считается по имени и раз в минуту уходит точкой
 * графика: «Alter — 1,2 ГБ за сутки» складывается из них.
 *
 * Второй источник — устройства раздачи (`share/store.ts`): за них в прокси
 * ходит край под именем `share.<id>`. Эти имена — только оттуда: строка с таким
 * именем в файле не действует.
 */

export type Usage = { up: number; down: number; connections: number };

const RECHECK_MS = 5_000;
const FLUSH_MS = 60_000;

export class Consumers {
  private tokens = new Map<string, Buffer>();
  private mtimeMs = -1;
  private checkedAt = 0;
  private readonly usage = new Map<string, Usage>();
  private readonly pending = new Map<string, Usage>();
  private timer: NodeJS.Timeout | null = null;
  private readonly path: string;
  private readonly log: Logger;
  private extra: () => ReadonlyMap<string, Buffer> = () => new Map();

  constructor(path: string, log: Logger) {
    this.path = path;
    this.log = log;
  }

  /** Пароли устройств раздачи — спрашиваются на каждом входе, отключение действует сразу. */
  useShare(source: () => ReadonlyMap<string, Buffer>): void {
    this.extra = source;
  }

  load(): void {
    let text: string;
    try {
      this.mtimeMs = statSync(this.path).mtimeMs;
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      throw new Error(`не прочитать токены ${this.path}: ${(error as Error).message}`);
    }
    const next = new Map<string, Buffer>();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const colon = trimmed.indexOf(':');
      const name = colon > 0 ? trimmed.slice(0, colon).trim() : '';
      const token = colon > 0 ? trimmed.slice(colon + 1).trim() : '';
      if (!name || token.length < 16) {
        this.log.warn(`токены: строка пропущена — нужен вид «имя:токен», токен не короче 16 знаков`);
        continue;
      }
      next.set(name, Buffer.from(token));
    }
    this.tokens = next;
    this.log.info(`потребителей с токенами: ${next.size}${next.size ? ` (${[...next.keys()].join(', ')})` : ''}`);
  }

  private refresh(): void {
    const now = Date.now();
    if (now - this.checkedAt < RECHECK_MS) return;
    this.checkedAt = now;
    try {
      if (statSync(this.path).mtimeMs !== this.mtimeMs) this.load();
    } catch (error) {
      this.log.warn(`токены: ${(error as Error).message}`);
    }
  }

  /** Имя потребителя по заголовку `Proxy-Authorization`, либо null. */
  authorize(header: string | undefined): string | null {
    if (!header) return null;
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
    if (!m) return null;
    const pair = Buffer.from(m[1] as string, 'base64').toString('utf8');
    const colon = pair.indexOf(':');
    if (colon <= 0) return null;
    const name = pair.slice(0, colon);
    const given = Buffer.from(pair.slice(colon + 1));
    this.refresh();
    const expected = name.startsWith(SHARE_PREFIX) ? this.extra().get(name) : this.tokens.get(name);
    if (!expected || expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return name;
  }

  account(name: string, up: number, down: number): void {
    for (const map of [this.usage, this.pending]) {
      const u = map.get(name) ?? { up: 0, down: 0, connections: 0 };
      u.up += up;
      u.down += down;
      u.connections += 1;
      map.set(name, u);
    }
  }

  /** Накопленный трафик с запуска — для экрана. */
  totals(): Map<string, Usage> {
    return new Map(this.usage);
  }

  /** Раз в минуту — точка графика по каждому, у кого что-то было. */
  startFlushing(): void {
    this.timer = setInterval(() => {
      if (this.pending.size === 0) return;
      const bytes: Record<string, number> = {};
      const connections: Record<string, number> = {};
      for (const [name, u] of this.pending) {
        bytes[name] = u.up + u.down;
        connections[name] = u.connections;
      }
      this.pending.clear();
      this.log.graph('consumer.bytes', bytes);
      this.log.graph('consumer.connections', connections);
    }, FLUSH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
