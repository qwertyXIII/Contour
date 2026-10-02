import { statSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import { COMPILED_FILE, readCompiled } from './book.ts';
import type { GatewayRoute } from '../gateway.ts';
import { RuleSet } from './engine.ts';
import { routeOf } from './gateway.ts';

/**
 * Правила в процессе DNS — копия, которую кладёт Contour (`RuleBook`):
 * перечитывается, когда файл сменился (проверка не чаще `CHECK_MS`).
 * Файла ещё нет — `null`: DNS решает, как до движка (ручные решения, списки,
 * самообучение).
 */

const CHECK_MS = 2_000;

/** Папка правил — внутри папки DNS: её читают оба процесса. */
export const rulesDir = (config: Pick<Config, 'lan'>): string => path.join(config.lan.dataDir, 'rules');

/** Как DNS отвечает по правилу: настоящими адресами (`tunnel: false`) или нашим (через SNI Contour). */
export type DnsVia = { tunnel: boolean; source: string };

export class CompiledRules {
  private readonly file: string;
  private readonly dir: string;
  private set: RuleSet | null = null;
  private directCountry: string | null = null;
  private mtime = 0;
  private checked = 0;

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, COMPILED_FILE);
  }

  /**
   * Решение по имени для DNS: «напрямую» и «через страну прямого выхода» —
   * настоящие адреса (в стране сервера её сайты и так видят местный адрес);
   * остальное — наш адрес: вести через выход решает Contour по тем же правилам.
   * Правила нет — `null`; набора ещё нет — `undefined`.
   */
  dnsVia(name: string, now = Date.now()): DnsVia | null | undefined {
    const set = this.rules(now);
    if (!set) return undefined;
    const d = set.decideName(name);
    // Выученное DNS знает лучше копии: оно у него живое, с проверкой и сроком.
    if (!d || d.layer === 'learned') return null;
    const t = d.action.target;
    const direct = t.kind === 'direct' || (t.kind === 'country' && t.country === this.directCountry);
    return { tunnel: !direct, source: d.source };
  }

  /**
   * Класс маршрута шлюза для имени (`rules/gateway.ts`); правила нет — `null`:
   * решит прежнее «куда» (заблокированное — «как сейчас», режим устройства).
   */
  gatewayRoute(name: string, now = Date.now()): GatewayRoute | null {
    const d = this.rules(now)?.decideName(name);
    return d && d.layer !== 'learned' ? routeOf(d.action) : null;
  }

  rules(now = Date.now()): RuleSet | null {
    if (now - this.checked >= CHECK_MS) {
      this.checked = now;
      let mtime = 0;
      try {
        mtime = statSync(this.file).mtimeMs;
      } catch {
        // Contour ещё не положил набор.
      }
      if (mtime !== this.mtime) {
        this.mtime = mtime;
        const c = readCompiled(this.dir);
        this.set = c ? new RuleSet(c.sources) : null;
        this.directCountry = c?.directCountry ?? null;
      }
    }
    return this.set;
  }
}
