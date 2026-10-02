import type { Cidr } from '../cidr.ts';
import type { Action, Entry, Match } from './types.ts';

/**
 * Решение по правилам: какое правило берёт имя или адрес.
 *
 * Порядок — решение владельца 2026-10-02: ручное сильнее загруженного,
 * загруженное сильнее выученного, точное сильнее широкого. Слой — первым:
 * ручное «напрямую» для `.example.com` перебивает загруженное `a.example.com`
 * («ручное сильнее»), а внутри слоя побеждает самое точное: имя целиком
 * сильнее суффикса, длинный суффикс — короткого, длинный префикс подсети —
 * короткого. Внутри слоя при равной точности — источник, что раньше в списке.
 *
 * Не совпало ничего — `null`: умолчание у каждого входа своё (прокси —
 * туннель, DNS и телефон — напрямую), движок его не выдумывает.
 */

export const LAYERS = ['manual', 'loaded', 'learned'] as const;
export type Layer = (typeof LAYERS)[number];

/** Источник правил для набора: слой, имя (для журнала и панели) и правила. */
export type RuleSource = { layer: Layer; source: string; entries: Entry[] };

export type Decision = { action: Action; layer: Layer; source: string; match: Match };

type Hit = { action: Action; source: string; match: Match };
/** Индекс одного слоя: имена целиком, суффиксы, подсети по длине префикса. */
type LayerIndex = { exact: Map<string, Hit>; suffix: Map<string, Hit>; nets: Map<number, Map<number, Hit>> };

const mask = (bits: number): number => (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0);

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n * 256 + Number(p)) >>> 0;
  }
  return n;
}

const clean = (name: string): string => name.toLowerCase().replace(/\.$/, '');

export class RuleSet {
  private readonly layers = new Map<Layer, LayerIndex>();
  readonly size: number;

  constructor(sources: RuleSource[]) {
    let size = 0;
    for (const layer of LAYERS) this.layers.set(layer, { exact: new Map(), suffix: new Map(), nets: new Map() });
    for (const s of sources) {
      const index = this.layers.get(s.layer) as LayerIndex;
      for (const e of s.entries) {
        size += 1;
        const hit: Hit = { action: e.action, source: s.source, match: e.match };
        // Первый источник побеждает при равной точности: `set` только если места нет.
        if (e.match.kind === 'domain') {
          const map = e.match.exact ? index.exact : index.suffix;
          const key = clean(e.match.name);
          if (!map.has(key)) map.set(key, hit);
        } else {
          let byNet = index.nets.get(e.match.bits);
          if (!byNet) index.nets.set(e.match.bits, (byNet = new Map()));
          const key = (e.match.net & mask(e.match.bits)) >>> 0;
          if (!byNet.has(key)) byNet.set(key, hit);
        }
      }
    }
    this.size = size;
  }

  /** Имя сайта; голый IPv4 — как адрес. */
  decide(host: string): Decision | null {
    const ip = ipv4ToInt(host.replace(/^\[|\]$/g, ''));
    return ip === null ? this.decideName(host) : this.decideIp(ip);
  }

  decideName(host: string): Decision | null {
    const name = clean(host);
    for (const layer of LAYERS) {
      const index = this.layers.get(layer) as LayerIndex;
      const exact = index.exact.get(name);
      if (exact) return { ...exact, layer };
      // Суффиксы — от самого длинного: «a.b.example.com», «b.example.com», «example.com», «com».
      for (let at = 0; ;) {
        const hit = index.suffix.get(name.slice(at));
        if (hit) return { ...hit, layer };
        const dot = name.indexOf('.', at);
        if (dot < 0) break;
        at = dot + 1;
      }
    }
    return null;
  }

  decideIp(ip: number): Decision | null {
    for (const layer of LAYERS) {
      const index = this.layers.get(layer) as LayerIndex;
      let best: Hit | null = null;
      let bestBits = -1;
      for (const [bits, byNet] of index.nets) {
        if (bits <= bestBits) continue;
        const hit = byNet.get((ip & mask(bits)) >>> 0);
        if (hit) { best = hit; bestBits = bits; }
      }
      if (best) return { ...best, layer };
    }
    return null;
  }

  /** Подсети правил «только через эти выходы» — единственное исключение из ограды частных адресов. */
  onlyNets(): Array<Cidr & { outlets: string[] }> {
    const out: Array<Cidr & { outlets: string[] }> = [];
    for (const index of this.layers.values()) {
      for (const byNet of index.nets.values()) {
        for (const hit of byNet.values()) {
          if (hit.match.kind === 'cidr' && hit.action.target.kind === 'only') out.push({ net: hit.match.net, bits: hit.match.bits, outlets: hit.action.target.outlets });
        }
      }
    }
    return out;
  }

  /** Все правила слоями — для конфига телефона и панели. */
  *entries(): Generator<{ layer: Layer; source: string; entry: Entry }> {
    for (const layer of LAYERS) {
      const index = this.layers.get(layer) as LayerIndex;
      for (const map of [index.exact, index.suffix]) for (const hit of map.values()) yield { layer, source: hit.source, entry: { match: hit.match, action: hit.action } };
      for (const byNet of index.nets.values()) for (const hit of byNet.values()) yield { layer, source: hit.source, entry: { match: hit.match, action: hit.action } };
    }
  }
}
