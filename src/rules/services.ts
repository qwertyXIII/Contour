import path from 'node:path';
import { RemoteList } from '../dns/remote-list.ts';
import type { Logger } from '../log.ts';
import { INDEX_LIMITS, ServiceIndex } from './service-index.ts';
import { formatV2flyItem, parseV2flyFile, V2FLY_NAME, type V2flyItem } from './v2fly.ts';

/**
 * Группы сервисов из v2fly domain-list-community: у TikTok десятки
 * несвязанных доменов, у OpenAI — openai.com, chatgpt.com, oaistatic.com,
 * и все они должны выходить в одной стране. Файлы `data/<name>` качаются по
 * одному `RemoteList` на файл — копия на диске, раз в сутки, нет GitHub —
 * по копии; `include:` открывает следующий файл, когда разобран тот, что
 * его называет. Нет ни сети, ни копии — сервис по основному домену.
 */

export const V2FLY_DATA = 'https://raw.githubusercontent.com/v2fly/domain-list-community/master/data/';

/**
 * Группы по умолчанию — уровень **учётки**: одна группа там, где один вход
 * на всё и где страна видна сервису (бан, отказ «не ваша страна», каталог по
 * стране). Поэтому `google` — вместе с YouTube и Gemini (один Google-аккаунт;
 * v2fly сам включает `youtube`), `meta` — Facebook, Instagram, WhatsApp,
 * Threads (Meta сводит их в одном центре аккаунтов), `x` — Twitter и xAI,
 * `microsoft` — с Bing, OneDrive, Xbox, Minecraft, но `github` отдельно (своя
 * учётка; граница — то, что он сам в наборе), `tiktok`, а не `bytedance`
 * (тот тянет Douyin и Lark — чужие учётки). Деньги и игры — PayPal, биржи,
 * Steam: там «телепортация» — блокировка средств. Одиночные домены (deepseek)
 * не нужны — им хватает основного домена.
 */
export const DEFAULT_SERVICE_GROUPS = [
  'openai', 'anthropic', 'google', 'perplexity', 'cursor', 'x',
  'meta', 'tiktok', 'telegram', 'discord', 'linkedin',
  'microsoft', 'github', 'apple', 'amazon',
  'netflix', 'spotify', 'steam',
  'paypal', 'binance', 'bybit', 'okx',
];

/**
 * Площадки чужих сайтов внутри групп: `aws` (CloudFront, S3 — у `amazon`),
 * `azure` (у `microsoft`), `firebase` (у `google`). Втянуть их — значит
 * склеить с учёткой Amazon всё, что лежит на CloudFront, и чужая беда одного
 * сайта (самообучение по сервису) легла бы на всю группу. Их имена остаются
 * основными доменами — с частным разделом суффиксов, по владельцу.
 */
export const DEFAULT_PLATFORMS = ['aws', 'azure', 'firebase'];

export type ServicesOptions = {
  /** Папка копий: `<папка>/<имя>.list`. */
  cacheDir: string;
  log: Logger;
  groups?: readonly string[];
  platforms?: readonly string[];
  /** Откуда качать `data/<name>`; для проверок — свой сервер. */
  baseUrl?: string;
  /** Предел файлов вместе с `include:` (300; набор по умолчанию — 76 файлов на 2026-10-02) и глубины `include:`. */
  maxFiles?: number;
  maxDepth?: number;
  /** Индекс поменялся (файл с диска или из сети) — тем, кто держит что-то по сервису. */
  onChange?: () => void;
};

const MAX_FILES = 300;
const WARN_EVERY_MS = 3_600_000;
/** Сводка — через минуту после первого отказа: за неё успевают отказать все файлы разом. */
const SUMMARY_DELAY_MS = 60_000;

export class Services {
  private readonly opts: ServicesOptions;
  private readonly groups: readonly string[];
  private readonly platforms: readonly string[];
  /** Где кончается группа: другие группы набора и площадки. */
  private readonly bounds: Set<string>;
  private readonly lists = new Map<string, RemoteList<V2flyItem>>();
  private readonly items = new Map<string, readonly V2flyItem[]>();
  private readonly quiet: Logger;
  private index: ServiceIndex;
  private dirty = false;
  private running = false;
  private failures = 0;
  private lastFailure = '';
  private warnedAt = 0;
  private summary: NodeJS.Timeout | null = null;

  constructor(opts: ServicesOptions) {
    this.opts = opts;
    this.groups = [...new Set(opts.groups ?? DEFAULT_SERVICE_GROUPS)].filter((g) => V2FLY_NAME.test(g));
    this.platforms = opts.platforms ?? DEFAULT_PLATFORMS;
    this.bounds = new Set([...this.groups, ...this.platforms]);
    this.index = new ServiceIndex(this.groups, new Map());
    // Восемьдесят файлов, а GitHub недоступен — восемьдесят строк в журнале каждый час. Одна — с числом.
    this.quiet = Object.create(opts.log, { warn: { value: (...args: unknown[]) => this.failed(args) } }) as Logger;
  }

  /** Копии с диска сразу, свежие — в фоне, потом раз в сутки. */
  start(): void {
    this.running = true;
    for (const g of this.groups) this.ensure(g, 0);
  }

  stop(): void {
    this.running = false;
    for (const list of this.lists.values()) list.stop();
    if (this.summary) clearTimeout(this.summary);
    this.summary = null;
  }

  /** Ключ прилипания: группа (`openai`), иначе основной домен (`example.co.uk`), IP — сам адрес. */
  serviceOf(host: string): string {
    return this.current().serviceOf(host);
  }

  /** Только группа, без основного домена: для панели «этот сайт — часть OpenAI». */
  groupOf(host: string): string | null {
    return this.current().groupOf(host);
  }

  stats(): { groups: Record<string, number>; files: number; loaded: number; skipped: number; missing: string[] } {
    const s = this.current().stats;
    return { groups: { ...s.names }, files: this.lists.size, loaded: this.items.size, skipped: s.skipped, missing: s.missing };
  }

  /** Пересборка — лениво, при первом вопросе после обновления: файлы приходят по одному, а спрашивают реже. */
  private current(): ServiceIndex {
    if (!this.dirty) return this.index;
    this.dirty = false;
    this.index = new ServiceIndex(this.groups, this.items, this.platforms, this.opts.maxDepth ?? INDEX_LIMITS.maxDepth);
    // Файл, на который больше никто не ссылается (upstream убрал `include:`), — не качать дальше.
    for (const name of this.items.keys()) {
      if (this.index.stats.reachable.has(name)) continue;
      this.lists.get(name)?.stop();
      this.lists.delete(name);
      this.items.delete(name);
    }
    return this.index;
  }

  private ensure(name: string, depth: number): void {
    const maxDepth = this.opts.maxDepth ?? INDEX_LIMITS.maxDepth;
    if (!this.running || this.lists.has(name) || depth > maxDepth || !V2FLY_NAME.test(name)) return;
    if (this.lists.size >= (this.opts.maxFiles ?? MAX_FILES)) {
      this.opts.log.warn(`группы сервисов: уже ${this.lists.size} файлов — «${name}» не беру`);
      return;
    }
    const list = new RemoteList<V2flyItem>({
      urls: [`${this.opts.baseUrl ?? V2FLY_DATA}${name}`],
      cacheFile: path.join(this.opts.cacheDir, `${name}.list`),
      parse: parseV2flyFile,
      key: formatV2flyItem,
      format: formatV2flyItem,
      onUpdate: (items) => this.loaded(name, items, depth),
      label: `группа сервисов «${name}»`,
      log: this.quiet,
    });
    // В карту — до `start`: копия с диска разбирается сразу, и её `include:` спросят, есть ли уже этот файл.
    this.lists.set(name, list);
    list.start();
  }

  private loaded(name: string, items: readonly V2flyItem[], depth: number): void {
    if (!this.lists.has(name)) return;
    this.items.set(name, items);
    this.dirty = true;
    for (const item of items) {
      if (item.kind === 'include' && !this.bounds.has(item.value)) this.ensure(item.value, depth + 1);
    }
    this.opts.onChange?.();
  }

  private failed(args: unknown[]): void {
    this.failures++;
    this.lastFailure = String(args[0]);
    if (this.summary || Date.now() - this.warnedAt < WARN_EVERY_MS) return;
    this.summary = setTimeout(() => {
      this.summary = null;
      this.warnedAt = Date.now();
      this.opts.log.warn(`группы сервисов: не обновились ${this.failures} из ${this.lists.size} файлов — работаю по копиям; последнее: ${this.lastFailure}`);
      this.failures = 0;
    }, SUMMARY_DELAY_MS);
    this.summary.unref();
  }
}
