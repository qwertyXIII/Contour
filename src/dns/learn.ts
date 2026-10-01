import { Resolver } from 'node:dns/promises';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { errorText, type Logger } from '../log.ts';

/**
 * Самообучение: открывается ли сайт отсюда напрямую.
 *
 * Новое имя → разрешить у обычного DNS → соединиться с его адресом на :443 и
 * пройти рукопожатие TLS с этим именем (так режет ТСПУ: по имени в
 * приветствии). Вердикт:
 * - рукопожатие прошло, или сайт ответил хоть как-то по TLS (ошибка
 *   сертификата — тоже ответ) → **напрямую**, помним сутки;
 * - «соединение отвергнуто» (нет https на этом имени) или нет адреса →
 *   напрямую: это не блокировка, и сервисы не по https у такого имени
 *   сломались бы через наш вход;
 * - молчание или сброс (до или после приветствия) → проверить **через туннель**:
 *   открылся — через VPN, помним неделю; не открылся и там — напрямую (это не
 *   блокировка, а закрытый порт: сервер точного времени, почта — уведи их в VPN,
 *   и устройство потеряет их совсем).
 *
 * Ждать вердикта DNS-ответ может не дольше `budgetMs`: не успели — отвечаем
 * как есть, с коротким сроком жизни (`pending`), а проверка доигрывает в фоне.
 * Худшее — новый заблокированный сайт не откроется с первого раза и откроется
 * через полминуты; популярное заблокированное и так в общем списке.
 */

export type Via = 'tunnel' | 'direct';
type Entry = { via: Via; until: number; why: string };

const DIRECT_FOR_MS = 24 * 3_600_000;
const TUNNEL_FOR_MS = 7 * 24 * 3_600_000;
const PROBE_TIMEOUT_MS = 4_000;
const MAX_PROBES = 32;
const SAVE_DELAY_MS = 5_000;
const MAX_ENTRIES = 50_000;
/** Ни проверять, ни уводить в туннель: местные и служебные имена. */
const LOCAL = /(^|\.)(local|lan|home|internal|localdomain|arpa|home\.arpa)$|^[^.]+$/;

const TUNNEL_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);
const DIRECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'EREFUSED', 'ENOTIMP']);

export type ProbeResult = { via: Via; why: string };

/** Классификация ошибки проверки. Вынесено ради тестов. */
export function classify(error: unknown): ProbeResult {
  const code = (error as NodeJS.ErrnoException)?.code ?? '';
  if (code === 'PROBE_TIMEOUT') return { via: 'tunnel', why: 'молчит' };
  if (TUNNEL_CODES.has(code)) return { via: 'tunnel', why: `сброс (${code})` };
  if (DIRECT_CODES.has(code)) return { via: 'direct', why: `не https (${code})` };
  // Ошибки TLS (сертификат, протокол) — сервер ответил по TLS, значит, пускают.
  if (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS') || /certificate|self.signed/i.test(errorText(error))) {
    return { via: 'direct', why: 'ответил по TLS' };
  }
  return { via: 'tunnel', why: `ошибка ${code || errorText(error)}` };
}

function handshake(ip: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port: 443, servername: name, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('молчит'), { code: 'PROBE_TIMEOUT' }));
    }, PROBE_TIMEOUT_MS);
    socket.once('secureConnect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('error', (e) => { clearTimeout(timer); socket.destroy(); reject(e); });
  });
}

export class Learner {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<ProbeResult>>();
  private readonly resolver: Resolver;
  private readonly file: string;
  private readonly log: Logger;
  private readonly budgetMs: number;
  private saveTimer: NodeJS.Timeout | null = null;

  private readonly viaTunnel: ((name: string) => Promise<void>) | null;

  constructor(opts: { upstream: string[]; dir: string; budgetMs: number; log: Logger; viaTunnel: ((name: string) => Promise<void>) | null }) {
    this.viaTunnel = opts.viaTunnel;
    this.resolver = new Resolver({ timeout: 2_000, tries: 1 });
    this.resolver.setServers(opts.upstream);
    this.file = path.join(opts.dir, 'dns-learned.json');
    this.log = opts.log;
    this.budgetMs = opts.budgetMs;
    this.load();
  }

  /** Решение для имени; ждёт проверку не дольше бюджета. */
  async decide(name: string): Promise<{ via: Via; why: string; fresh: boolean; pending?: boolean }> {
    const n = name.toLowerCase().replace(/\.$/, '');
    if (LOCAL.test(n)) return { via: 'direct', why: 'местное имя', fresh: false };
    const known = this.entries.get(n);
    if (known && known.until > Date.now()) return { via: known.via, why: known.why, fresh: false };

    let job = this.inflight.get(n);
    if (!job) {
      if (this.inflight.size >= MAX_PROBES) return { via: 'direct', why: 'проверок слишком много — напрямую', fresh: false };
      job = this.probe(n).then((r) => { this.remember(n, r); return r; }).finally(() => this.inflight.delete(n));
      this.inflight.set(n, job);
    }
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), this.budgetMs).unref());
    const r = await Promise.race([job, timeout]);
    return r ? { ...r, fresh: true } : { via: 'direct', why: 'проверка не успела — пока напрямую, ненадолго', fresh: true, pending: true };
  }

  /** Все решения «через VPN» — для просмотра. */
  tunnelled(): Array<{ name: string; why: string; until: number }> {
    return [...this.entries].filter(([, e]) => e.via === 'tunnel' && e.until > Date.now()).map(([name, e]) => ({ name, why: e.why, until: e.until }));
  }

  private async probe(name: string): Promise<ProbeResult> {
    let ips: string[];
    try {
      ips = await this.resolver.resolve4(name);
    } catch (error) {
      return classify(error);
    }
    if (ips.length === 0) return { via: 'direct', why: 'нет адреса' };
    let direct: ProbeResult;
    try {
      await handshake(ips[0] as string, name);
      return { via: 'direct', why: 'открывается' };
    } catch (error) {
      direct = classify(error);
    }
    if (direct.via === 'direct' || !this.viaTunnel) return direct;
    try {
      await this.viaTunnel(name);
      return { via: 'tunnel', why: `напрямую ${direct.why}, через VPN открывается` };
    } catch (error) {
      return { via: 'direct', why: `напрямую ${direct.why}, через VPN тоже нет — не блокировка (${errorText(error)})` };
    }
  }

  private remember(name: string, r: ProbeResult): void {
    const before = this.entries.get(name);
    if (this.entries.size >= MAX_ENTRIES) this.prune();
    this.entries.set(name, { via: r.via, why: r.why, until: Date.now() + (r.via === 'tunnel' ? TUNNEL_FOR_MS : DIRECT_FOR_MS) });
    if (r.via === 'tunnel' && before?.via !== 'tunnel') this.log.info(`«${name}» напрямую не открылся (${r.why}) — теперь через VPN`);
    else if (r.via === 'direct' && before?.via === 'tunnel') this.log.info(`«${name}» снова открывается напрямую — убран из VPN`);
    this.scheduleSave();
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, e] of this.entries) if (e.until <= now) this.entries.delete(k);
    if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Entry>;
      const now = Date.now();
      for (const [k, e] of Object.entries(raw)) {
        if (e && (e.via === 'tunnel' || e.via === 'direct') && typeof e.until === 'number' && e.until > now) this.entries.set(k, e);
      }
      const t = [...this.entries.values()].filter((e) => e.via === 'tunnel').length;
      this.log.info(`самообучение: с диска ${this.entries.size} решений, через VPN — ${t}`);
    } catch {
      // первый запуск
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.entries)));
        renameSync(`${this.file}.tmp`, this.file);
      } catch (error) {
        this.log.warn(`самообучение: не сохранить ${this.file} — ${errorText(error)}`);
      }
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }
}
