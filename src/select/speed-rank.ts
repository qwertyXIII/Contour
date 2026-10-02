import type { OutletState } from '../outlets/outlet.ts';
import { median } from './speed-window.ts';

/**
 * Порядок выходов для режима «самый быстрый» — среди уже отобранных кандидатов.
 *
 * Страну и прилипание решает не это место: кандидаты приходят уже одной страны
 * (прилипание к стране важнее скорости — за «телепортацию» выкидывают из
 * учёток), здесь выбирается выход внутри неё. Гонки нет и не будет: никаких
 * соединений отсюда не открывается, только счёт по замерам, которые уже есть.
 *
 * Сравнение всегда парное — с опорным выходом (текущий, а нет его — первый по
 * порядку выбора) — и на самом точном уровне, где данных хватает обоим:
 * 1. TTFB этого сервиса через оба выхода (`minSamples` свежих у каждого);
 * 2. TTFB выхода в целом — но **по общим сервисам**: медиана отношений по
 *    сервисам, у которых замеров хватает через оба (`minPairs` таких). Сырая
 *    медиана всех замеров выхода сравнивала бы не выходы, а то, какие сайты
 *    через них ходили: основной везёт всё подряд, запасной — что досталось
 *    при отказе. Сырая медиана — только для панели;
 * 3. задержка до выхода (`latencyMs` проверки живости) — парная по построению:
 *    один и тот же адрес через каждый выход.
 *
 * Пропускная способность — вторым критерием, не общим счётом: курса «сколько
 * мегабит стоит миллисекунда» нет, и любое число было бы выдумкой. Она:
 * - **запрещает** переход на выход, который отвечает быстрее, но качает меньше
 *   половины текущего (`throughputGuard`): живой пример — AWG в mihomo, 35 КБ/с
 *   при нормальной задержке (README, 2026-10-01);
 * - **сама решает**, когда по задержке выходы наравне (новый не хуже текущего
 *   больше чем на `margin`), а качает он в `throughputGain` раз больше.
 *
 * Гистерезис: от текущего уходим, только если новый лучше заметно — на `margin`
 * и не меньше чем на `minGainMs` (25% от 40 мс — уже шум). Нет текущего —
 * первый выбор, дёргать нечего: хватает «лучше на `minGainMs`».
 */

export type Candidate = {
  name: string;
  latencyMs: number | null;
  state: OutletState;
  /** Когда мерили `latencyMs` — чтобы копить замеры задержки, а не верить последнему. */
  checkedAt?: number | null;
  /** Проверок подряд без успеха: при провале `latencyMs` — прошлая, в окно её не кладём. */
  failures?: number;
};

export type RankTuning = {
  /** Насколько новый выход должен быть лучше текущего: 0,25 — на 25%. */
  margin: number;
  minGainMs: number;
  /** Свежих замеров TTFB пары сервис × выход, чтобы на неё полагаться. */
  minSamples: number;
  /** Общих сервисов, чтобы сравнить выходы в целом. */
  minPairs: number;
  /** Качает меньше этой доли текущего — не переходим, как бы быстро ни отвечал. */
  throughputGuard: number;
  /** Во сколько раз больше качает, чтобы перейти при равной задержке. */
  throughputGain: number;
  /** Замеров скорости у обоих, чтобы скорость сама решала. */
  minTransfers: number;
};

export const RANK_DEFAULTS: RankTuning = {
  margin: 0.25,
  minGainMs: 20,
  minSamples: 5,
  minPairs: 3,
  throughputGuard: 0.5,
  throughputGain: 1.5,
  minTransfers: 3,
};

/** Что ранжированию нужно от замеров; отвечает `SpeedBook` из своих окон. */
export type RankData = {
  /** Свежие TTFB сервиса через выход, мс. */
  ttfb(service: string, outlet: string): number[];
  /** TTFB выходов по общим сервисам: отношение b/a, выигрыш b в мс, сколько сервисов. */
  paired(a: string, b: string): Paired | null;
  /** Задержка до выхода, мс: медиана последних проверок или последняя. */
  latency(c: Candidate): number | null;
  /** Скорость выхода, байт/с, и по скольким замерам. */
  throughput(outlet: string): { bps: number; count: number } | null;
};

export type Paired = { ratio: number; gainMs: number; count: number };

export type Ranked<C> = {
  order: C[];
  leader: string | null;
  /** Первым стал не `current` — повод для строки в журнале. */
  switched: boolean;
  reason: string;
};

type Level = 'service' | 'outlet' | 'latency';
type Compare = { level: Level; ratio: number; gainMs: number; text: string };
type Option<C> = { c: C; cmp: Compare | null; tpRatio: number | null; veto: boolean; win: 'ttfb' | 'throughput' | null };

const ms = (n: number): string => `${Math.round(n)} мс`;
const pct = (ratio: number): number => Math.round(Math.abs(1 - ratio) * 100);
const fmt = (n: number): string => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const mbit = (bps: number): string => `${fmt((bps * 8) / 1e6)} Мбит/с`;
/** «в 1,5 раза», «в 4 раза», «в 5 раз», «в 12 раз». */
const times = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  const whole = Number.isInteger(r) ? r % 100 : null;
  const few = whole === null || (whole % 10 >= 2 && whole % 10 <= 4 && (whole < 12 || whole > 14));
  return `в ${fmt(r)} ${few ? 'раза' : 'раз'}`;
};

/** Медиана отношений TTFB `b`/`a` по тем из `services`, где замеров хватает через оба выхода. */
export function pairedTtfb(ttfb: RankData['ttfb'], services: Iterable<string>, a: string, b: string, minSamples: number): Paired | null {
  const ratios: number[] = [];
  const gains: number[] = [];
  for (const s of services) {
    const va = ttfb(s, a);
    const vb = ttfb(s, b);
    if (va.length < minSamples || vb.length < minSamples) continue;
    const ma = median(va) as number;
    const mb = median(vb) as number;
    ratios.push(mb / Math.max(ma, 1));
    gains.push(ma - mb);
  }
  if (ratios.length === 0) return null;
  return { ratio: median(ratios) as number, gainMs: median(gains) as number, count: ratios.length };
}

/** `c` против опорного `ref` на самом точном уровне, где данных хватает обоим. */
function compare(data: RankData, t: RankTuning, service: string, ref: Candidate, c: Candidate): Compare | null {
  if (service) {
    const a = data.ttfb(service, ref.name);
    const b = data.ttfb(service, c.name);
    if (a.length >= t.minSamples && b.length >= t.minSamples) {
      const ma = median(a) as number;
      const mb = median(b) as number;
      return { level: 'service', ratio: mb / Math.max(ma, 1), gainMs: ma - mb, text: `TTFB ${service}: «${c.name}» ${ms(mb)}, «${ref.name}» ${ms(ma)}` };
    }
  }
  const p = data.paired(ref.name, c.name);
  if (p && p.count >= t.minPairs) {
    return { level: 'outlet', ratio: p.ratio, gainMs: p.gainMs, text: `TTFB по ${p.count} общим сервисам: у «${c.name}» медианно на ${ms(Math.abs(p.gainMs))} ${p.gainMs >= 0 ? 'меньше' : 'больше'}` };
  }
  const la = data.latency(ref);
  const lb = data.latency(c);
  if (la !== null && lb !== null) {
    return { level: 'latency', ratio: lb / Math.max(la, 1), gainMs: la - lb, text: `задержка: «${c.name}» ${ms(lb)}, «${ref.name}» ${ms(la)}` };
  }
  return null;
}

function weigh<C extends Candidate>(data: RankData, t: RankTuning, service: string, ref: C, c: C, hold: boolean): Option<C> {
  const cmp = compare(data, t, service, ref, c);
  const tc = data.throughput(c.name);
  const tr = data.throughput(ref.name);
  const tpRatio = tc && tr ? tc.bps / Math.max(tr.bps, 1) : null;
  // Запрет — уже по одному замеру: ошибка в эту сторону стоит только «остались, где были».
  const veto = tpRatio !== null && tpRatio < t.throughputGuard;
  const faster = cmp !== null && (hold ? cmp.ratio <= 1 - t.margin : cmp.ratio < 1) && cmp.gainMs >= t.minGainMs;
  const pulls = tc !== null && tr !== null && tpRatio !== null && tc.count >= t.minTransfers && tr.count >= t.minTransfers
    && tpRatio >= t.throughputGain && (cmp === null || cmp.ratio <= 1 + t.margin);
  return { c, cmp, tpRatio, veto, win: faster && !veto ? 'ttfb' : pulls ? 'throughput' : null };
}

function switchReason<C extends Candidate>(win: Option<C>, ref: C, data: RankData): string {
  const { c, cmp } = win;
  if (win.win === 'ttfb' && cmp) return `«${c.name}» быстрее «${ref.name}» на ${pct(cmp.ratio)}%: ${cmp.text}`;
  const tc = data.throughput(c.name)?.bps ?? 0;
  const tr = data.throughput(ref.name)?.bps ?? 0;
  return `«${c.name}» качает быстрее «${ref.name}» ${times(win.tpRatio ?? 0)}: ${mbit(tc)} против ${mbit(tr)}; ${cmp ? cmp.text : 'задержку не сравнить'}`;
}

function stayReason<C extends Candidate>(options: Option<C>[], ref: C, t: RankTuning, data: RankData, hold: boolean): string {
  const known = options.filter((o) => o.cmp !== null).sort((a, b) => (a.cmp as Compare).ratio - (b.cmp as Compare).ratio);
  const best = known[0];
  if (!best || !best.cmp) return `«${ref.name}»: сравнить не с чем — данных о скорости нет`;
  const head = hold ? `остаёмся на «${ref.name}»` : `«${ref.name}» — первый по порядку`;
  if (best.cmp.ratio >= 1) return `${head}: другие не быстрее — ${best.cmp.text}`;
  if (best.veto) {
    const tc = data.throughput(best.c.name)?.bps ?? 0;
    const tr = data.throughput(ref.name)?.bps ?? 0;
    return `${head}: «${best.c.name}» отвечает быстрее на ${pct(best.cmp.ratio)}% (${best.cmp.text}), но качает медленнее — ${mbit(tc)} против ${mbit(tr)}`;
  }
  const need = hold ? `нужно от ${Math.round(t.margin * 100)}% и ${ms(t.minGainMs)}` : `нужно от ${ms(t.minGainMs)}`;
  return `${head}: «${best.c.name}» быстрее лишь на ${pct(best.cmp.ratio)}% (${best.cmp.text}), ${need}`;
}

/**
 * Порядок кандидатов: годные (не мёртвые и не запасные) — раньше; группы
 * `tierOf` (например, `portRank`: выход, который режет порт, не обгонит того,
 * кто пропускает) не смешиваются; в лучшей группе первым — самый быстрый с
 * учётом гистерезиса, остальные её — по скорости относительно опорного,
 * несравнимые — после, как пришли. Прочие группы и негодные — как пришли.
 */
export function rankBy<C extends Candidate>(data: RankData, t: RankTuning, service: string, candidates: readonly C[], current?: string | null, tierOf: (c: C) => number = () => 0): Ranked<C> {
  const usable = candidates.filter((c) => c.state !== 'dead' && c.state !== 'standby');
  if (usable.length === 0) {
    return { order: [...candidates], leader: candidates[0]?.name ?? null, switched: false, reason: 'живых выходов нет — порядок как был' };
  }
  const rest = candidates.filter((c) => !usable.includes(c));
  const tiers = new Map(usable.map((c) => [c, tierOf(c)]));
  const tier = (c: C): number => tiers.get(c) ?? 0;
  const tiered = usable.map((c, i) => ({ c, i })).sort((a, b) => tier(a.c) - tier(b.c) || a.i - b.i).map((x) => x.c);
  const bestTier = tier(tiered[0] as C);
  const pool = tiered.filter((c) => tier(c) === bestTier);
  const lower = tiered.filter((c) => tier(c) !== bestTier);
  const cur = pool.find((c) => c.name === current) ?? null;
  const ref = cur ?? (pool[0] as C);
  const hold = cur !== null;
  const lost = current && !cur ? `«${current}» сейчас не годится — ` : '';

  const options = pool.filter((c) => c !== ref).map((c) => weigh(data, t, service, ref, c, hold));
  const winners = options.filter((o) => o.win !== null)
    .sort((a, b) => (a.cmp?.ratio ?? 1) - (b.cmp?.ratio ?? 1) || (b.tpRatio ?? 0) - (a.tpRatio ?? 0));
  const win = winners[0];
  const leader = win ? win.c : ref;

  const ratio = (c: C): number => (c === ref ? 1 : options.find((o) => o.c === c)?.cmp?.ratio ?? Infinity);
  const tail = pool.filter((c) => c !== leader).map((c, i) => ({ c, i })).sort((a, b) => ratio(a.c) - ratio(b.c) || a.i - b.i).map((x) => x.c);
  const reason = pool.length === 1
    ? `«${ref.name}» — один подходящий выход`
    : win ? switchReason(win, ref, data) : stayReason(options, ref, t, data, hold);
  return {
    order: [leader, ...tail, ...lower, ...rest],
    leader: leader.name,
    switched: Boolean(current) && leader.name !== current,
    reason: lost + reason,
  };
}
