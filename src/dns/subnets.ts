import path from 'node:path';
import { formatCidr, overlaps, parseCidr, parseCidrList, type Cidr } from '../cidr.ts';
import { PRIVATE_V4 } from '../inlets/fence.ts';
import { errorText, type Logger } from '../log.ts';
import { RemoteList } from './remote-list.ts';

/**
 * Подсети для шлюза (`src/gateway.ts`): сервисы, которые ходят по адресам, а не
 * по именам. Голос Discord — живьём 2026-10-02: в режиме «всё через VPN» голос
 * пошёл, в «заблокированное» — нет: адрес голосового сервера Discord сообщает
 * внутри своего протокола, и в набор по DNS он не попадает.
 *
 * Списки скачивает DNS (он и так ведёт списки), отдаёт помощнику от root
 * (`gateway.nets`), тот хранит их у себя в файле и кладёт в набор nft — шлюз
 * поднимается с ними и без DNS. Помощник не принял (старый, недоступен) —
 * повтор каждые 5 минут.
 */

/** Копия списков подсетей (до отбора `pickSubnets`) — её читают и правила раздачи. */
export const SUBNETS_FILE = 'gateway-subnets.lst';
const MAX_NETS = 4_096;
const PUSH_RETRY_MS = 5 * 60_000;
const PRIVATE: Cidr[] = PRIVATE_V4.map(([net, bits]) => parseCidr(`${net}/${bits}`) as Cidr);

/** Что из списков идёт в шлюз: без частных сетей, без `skip`, не шире /8, не больше 4096. */
export function pickSubnets(list: Cidr[], skip: Cidr[]): { nets: Cidr[]; skipped: number } {
  let skipped = 0;
  const nets: Cidr[] = [];
  for (const c of list) {
    if (c.bits < 8 || PRIVATE.some((p) => overlaps(c, p))) continue;
    if (skip.some((s) => overlaps(c, s))) { skipped += 1; continue; }
    if (nets.length < MAX_NETS) nets.push(c);
  }
  return { nets, skipped };
}

export type SubnetsOptions = {
  urls: string[];
  skip: string[];
  cacheDir: string;
  /** Отдать помощнику от root. */
  push: (cidrs: string[]) => Promise<void>;
  log: Logger;
};

export class Subnets {
  private readonly remote: RemoteList<Cidr>;
  private readonly opts: SubnetsOptions;
  private pending: string[] | null = null;
  private retry: NodeJS.Timeout | null = null;
  private failing = false;

  constructor(opts: SubnetsOptions) {
    this.opts = opts;
    const skip = opts.skip.map((s) => parseCidr(s)).filter((c): c is Cidr => c !== null);
    this.remote = new RemoteList<Cidr>({
      urls: opts.urls,
      cacheFile: path.join(opts.cacheDir, SUBNETS_FILE),
      parse: parseCidrList,
      key: formatCidr,
      format: formatCidr,
      onUpdate: (list, from) => {
        const { nets, skipped } = pickSubnets(list, skip);
        if (from === 'net') opts.log.info(`подсети шлюза: ${nets.length} (из ${list.length}; Cloudflare и прочие из «skip» — ${skipped} мимо)`);
        this.pending = nets.map(formatCidr);
        void this.push();
      },
      label: 'подсети шлюза',
      log: opts.log,
    });
  }

  start(): void {
    this.remote.start();
  }

  stop(): void {
    this.remote.stop();
    if (this.retry) clearTimeout(this.retry);
  }

  private async push(): Promise<void> {
    if (!this.pending) return;
    const cidrs = this.pending;
    try {
      await this.opts.push(cidrs);
      if (this.pending === cidrs) this.pending = null;
      if (this.failing) this.opts.log.info(`подсети шлюза помощник принял: ${cidrs.length}`);
      this.failing = false;
    } catch (error) {
      // Одна строка на серию отказов: помощник может быть не обновлён часами.
      if (!this.failing) this.opts.log.warn(`подсети шлюза помощнику не отдать: ${errorText(error)} — повторяю каждые 5 минут`);
      this.failing = true;
      if (this.retry) clearTimeout(this.retry);
      this.retry = setTimeout(() => { void this.push(); }, PUSH_RETRY_MS);
      this.retry.unref();
    }
  }
}
