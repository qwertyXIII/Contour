import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCidr } from '../cidr.ts';
import { COUNTRY_LISTS } from '../config-lists.ts';
import { parseList } from '../dns/lists.ts';
import { RemoteList } from '../dns/remote-list.ts';
import { readJson, writeJson } from '../json-file.ts';
import type { Logger } from '../log.ts';
import type { Sites } from '../panel/sites.ts';
import { RuleSet, type RuleSource } from './engine.ts';
import type { Action, Entry } from './types.ts';

/**
 * Книга правил процесса Contour: собирает источники в один набор и кладёт его
 * файлом для процесса DNS (`COMPILED_FILE`), чтобы у прокси, DNS, шлюза и
 * телефона были одни правила, а DNS работал по последней копии, даже когда
 * Contour лежит.
 *
 * Встроенные источники — то, что было и до движка, с тем же поведением:
 * - ручные решения панели (`overrides.json` папки DNS) — слой «ручное»;
 * - свои сайты стран из раздачи (панель, чипы) — «ручное», «через страну»;
 * - свой список (`lan.domains`), общий список (копия DNS) и подсети сервисов —
 *   «загруженное», «через туннель»;
 * - готовые списки стран (`COUNTRY_LISTS`) — «загруженное», «через страну»,
 *   только для стран, где есть выход: правило «через страну» без выхода в ней
 *   отказывало бы, а не вело через туннель (сервер друга без российского выхода);
 * - выученное «через VPN» процессом DNS — «выученное». Выученное «напрямую» в
 *   набор не идёт: для прокси это было бы «напрямую» вместо туннеля, а DNS
 *   решает его сам, своим самообучением.
 * Свои списки владельца (по ссылке, файлом, руками) — `extra`.
 */

export const COMPILED_FILE = 'rules.json';
/** Как часто пересобирать: файлы DNS меняются сами (выученное, общий список). */
const REBUILD_MS = 30_000;

export type Compiled = { version: 1; directCountry: string | null; sources: RuleSource[] };

export type BookOptions = {
  sites: Sites;
  /** Подсети сервисов, что ходят по адресам (без частных и Cloudflare) — как у шлюза. */
  subnets: () => string[];
  /** Страны, где есть выход. */
  countries: () => string[];
  /** Страна прямого выхода — DNS отдаёт её сайтам настоящие адреса. */
  directCountry: () => string | null;
  /** Свои сайты стран (раздача). */
  countrySites: () => Record<string, string[]>;
  /** Свои списки владельца — слои и действия у них свои. */
  extra?: () => RuleSource[];
  /** Папка книги: набор для DNS и копии списков стран. */
  dir: string;
  log: Logger;
};

const TUNNEL: Action = { target: { kind: 'tunnel' } };
const domains = (names: Iterable<string>, action: Action): Entry[] => [...names].map((name) => ({ match: { kind: 'domain', name, exact: false }, action }));

export class RuleBook {
  private readonly opts: BookOptions;
  private readonly lists = new Map<string, { remote: RemoteList<string>; names: string[] }>();
  private set: RuleSet = new RuleSet([]);
  private hash = '';
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: BookOptions) {
    this.opts = opts;
  }

  start(): void {
    this.rebuild();
    this.timer = setInterval(() => this.rebuild(), REBUILD_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const l of this.lists.values()) l.remote.stop();
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  rules(): RuleSet {
    return this.set;
  }

  /** Готовый список страны (`COUNTRY_LISTS`): первый спрос читает копию и ставит скачивание. */
  countryList(code: string): string[] {
    const urls = COUNTRY_LISTS[code];
    if (!urls || urls.length === 0) return [];
    let l = this.lists.get(code);
    if (!l) {
      const held = { names: [] as string[] };
      const remote = new RemoteList<string>({
        urls,
        cacheFile: path.join(this.opts.dir, `country-${code.toLowerCase()}.lst`),
        parse: parseList,
        key: (n) => n,
        format: (n) => n,
        onUpdate: (names, from) => {
          held.names = names;
          if (from === 'net') { this.opts.log.info(`список сайтов страны ${code}: ${names.length}`); this.rebuild(); }
        },
        label: `список сайтов ${code}`,
        log: this.opts.log,
      });
      l = { remote, get names() { return held.names; } };
      this.lists.set(code, l);
      remote.start();
    }
    return l.names;
  }

  /** Собрать заново; набор сменился — файл для DNS и слушателям. */
  rebuild(): void {
    const compiled: Compiled = { version: 1, directCountry: this.opts.directCountry(), sources: this.sources() };
    const hash = createHash('sha256').update(JSON.stringify(compiled)).digest('hex');
    if (hash === this.hash) return;
    this.hash = hash;
    this.set = new RuleSet(compiled.sources);
    try {
      writeJson(path.join(this.opts.dir, COMPILED_FILE), compiled);
    } catch (error) {
      this.opts.log.warn(`правила: не записать набор для DNS — ${(error as Error).message}`);
    }
    for (const fn of this.listeners) fn();
  }

  private sources(): RuleSource[] {
    const { sites } = this.opts;
    const manual = Object.entries(sites.overrides()).map(([name, via]): Entry => ({ match: { kind: 'domain', name, exact: false }, action: via === 'direct' ? { target: { kind: 'direct' } } : TUNNEL }));
    const countries = new Set(this.opts.countries());
    const byCountry = (code: string): Action => ({ target: { kind: 'country', country: code } });
    const own = Object.entries(this.opts.countrySites()).filter(([code]) => countries.has(code)).map(([code, names]): RuleSource => ({ layer: 'manual', source: `свои сайты ${code}`, entries: domains(names, byCountry(code)) }));
    const nets = this.opts.subnets().map((c) => parseCidr(c)).filter((c) => c !== null).map((c): Entry => ({ match: { kind: 'cidr', ...c }, action: TUNNEL }));
    const learned = sites.learned().filter((l) => l.via === 'tunnel').map((l) => l.name);
    return [
      { layer: 'manual', source: 'ручные решения', entries: manual },
      ...own,
      ...(this.opts.extra?.() ?? []),
      { layer: 'loaded', source: 'свой список', entries: domains(sites.ownNames(), TUNNEL) },
      { layer: 'loaded', source: 'общий список', entries: domains(sites.commonNames(), TUNNEL) },
      { layer: 'loaded', source: 'подсети сервисов', entries: nets },
      ...[...countries].filter((code) => COUNTRY_LISTS[code]).map((code): RuleSource => ({ layer: 'loaded', source: `список страны ${code}`, entries: domains(this.countryList(code), byCountry(code)) })),
      { layer: 'learned', source: 'выученное', entries: domains(learned, TUNNEL) },
    ];
  }
}

/** Набор для процесса DNS: копия, что положил Contour; нет её — пустой (DNS решает сам). */
export function readCompiled(dir: string): Compiled | null {
  const c = readJson<Compiled | null>(path.join(dir, COMPILED_FILE), null);
  return c && c.version === 1 && Array.isArray(c.sources) ? c : null;
}
