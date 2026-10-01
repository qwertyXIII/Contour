/*
 * Что показывает каждая капсула: зоны кольца и их источники.
 *
 * Зона — дуга кольца (доли оборота от верха по часовой, 0…1), сторона капсулы
 * (`inner` — внутрь, `outer` — наружу, `both`) и источник: `spectrum` — спектр от
 * `setSource`, `wave` — двусторонняя волна от `setWaveSource`, `progress` — доля
 * выполненного, или функция `(count, ctx) → числа 0…1 | {inner, outer}`. Поздняя
 * зона перекрывает раннюю только на своей стороне — так «внутрь — ты, наружу —
 * Alter» собирается из двух зон на всё кольцо.
 *
 * Нет ни одного живого источника — капсулы заняты синтетикой по режиму, чтобы
 * кольцо жило и без микрофона. Подключённый источник, вернувший пустой кадр, —
 * это тишина, а не повод тихо включить синтетику за спиной у микрофона.
 */

import { clamp, inArc, turn } from './orb-layout.js';
import { DEFAULTS } from './orb-config.js';

export const DEFAULT_REGIONS = [{ start: 0, end: 1, band: 'both', source: 'spectrum' }];

const BANDS = ['inner', 'outer', 'both'];

export function normalizeRegions(next) {
  return next.map((region) => ({
    start: Number.isFinite(region.start) ? region.start : 0,
    end: Number.isFinite(region.end) ? region.end : 1,
    band: BANDS.includes(region.band) ? region.band : 'both',
    source: region.source ?? 'spectrum',
    value: region.value,
    color: region.color,
    innerColor: region.innerColor,
    outerColor: region.outerColor,
  }));
}

/** Число — обе стороны поровну; пара — каждая своя. */
function sourceValue(value) {
  if (typeof value === 'number') {
    const level = clamp(value);
    return { inner: level, outer: level };
  }
  return { inner: clamp(value?.inner ?? 0), outer: clamp(value?.outer ?? 0) };
}

/** Чем занята капсула, когда живого звука нет. `ctx` — режим, фаза, время, вид. */
function synthetic(index, count, ctx) {
  const { mode, phase, now, random, look = DEFAULTS } = ctx;
  const x = count > 0 ? index / count : 0;
  const waveA = (Math.sin(phase + x * Math.PI * 4) + 1) / 2;
  const waveB = (Math.sin(phase * 1.52 - x * Math.PI * 7) + 1) / 2;
  if (mode === 'listening') return 0.05 + waveA * 0.16;
  if (mode === 'speaking') {
    // Огибающая по кругу: в «носу» волны громче, к краям спадает — иначе
    // получается ровный забор, который не читается как речь.
    const envelope = 0.35 + 0.65 * Math.sin(Math.PI * x) ** 0.28;
    return clamp(0.08 + random() * 0.48 * envelope + waveA * 0.18 + waveB * 0.1);
  }
  if (mode === 'thinking') return twinHeads(x, now, look);
  if (mode === 'success') return Math.max(0, Math.sin(now % 1200 / 1200 * Math.PI));
  if (mode === 'error') {
    const pulse = Math.max(0, Math.sin(now % 700 / 700 * Math.PI * 2));
    return index % 2 ? pulse * 0.45 : pulse;
  }
  return 0;
}

/**
 * Две бегущие по кругу головы в противофазе — «крутится, но не отвечает».
 * Скорость — оборотов в секунду, ширина головы — доля круга (вид, ADR-0053).
 */
function twinHeads(position, now, look) {
  const head = (now * look.thinkSpeed / 1000) % 1;
  const distance = (center) => Math.min(Math.abs(position - center), 1 - Math.abs(position - center));
  const falloff = 1 / Math.max(0.01, look.thinkWidth);
  return clamp(Math.max(1 - distance(head) * falloff, 1 - distance((head + 0.5) % 1) * falloff));
}

/** Комета с хвостом — одна, быстрее голов «думает»: идёт вызов инструмента. */
function comet(position, now, look) {
  const head = (now * look.toolSpeed / 1000) % 1;
  const behind = (head - position + 1) % 1;
  const tail = Math.max(0.01, look.toolTail);
  return behind < tail ? (1 - behind / tail) ** 2 : 0;
}

/**
 * Занятость поверх голосов (решение владельца: вызов инструмента видно, даже пока
 * кто-то говорит): `thinking` — две головы, `tool` — комета. `position` — доля оборота.
 */
export function busyLevel(busy, position, now, look = DEFAULTS) {
  if (busy === 'tool') return comet(position, now, look);
  if (busy === 'thinking') return twinHeads(position, now, look);
  return 0;
}

function samples(region, count, ctx) {
  let values = null;
  const live = typeof region.source === 'function'
    || (region.source === 'spectrum' && Boolean(ctx.source))
    || (region.source === 'wave' && Boolean(ctx.waveSource));
  try {
    if (typeof region.source === 'function') values = region.source(count, ctx);
    else if (region.source === 'spectrum') values = ctx.source?.(count);
    else if (region.source === 'wave') values = ctx.waveSource?.(count);
  } catch (error) {
    console.warn('Источник кольца упал:', error);
  }
  if (Array.isArray(values) && values.length >= count) return values;
  if (live) return new Array(count).fill(0);
  if (region.source === 'progress') {
    const value = clamp(typeof region.value === 'function' ? region.value() : region.value ?? ctx.progress);
    return Array.from({ length: count }, (_, index) => clamp(value * count - index));
  }
  if (region.source === 'wave') return demoWave(count, ctx.phase);
  return Array.from({ length: count }, (_, index) => synthetic(index, count, ctx));
}

function demoWave(count, phase) {
  return Array.from({ length: count }, (_, index) => {
    const signed = Math.sin(phase * 1.9 + index * 0.71) * (0.25 + 0.55 * Math.sin(phase * 0.47 + index * 0.23) ** 2);
    return { inner: Math.max(0, -signed), outer: Math.max(0, signed) };
  });
}

/** Цель каждой капсулы: сколько внутрь и наружу и каким цветом — по всем зонам. */
export function regionTargets(capsules, regions, ctx) {
  const result = new Map(capsules.map((capsule) => [capsule.id, {
    inner: 0, outer: 0, hasInner: false, hasOuter: false, innerColor: null, outerColor: null,
  }]));
  for (const region of regions) {
    const members = capsules.filter((capsule) => inArc(turn(capsule.angle), region.start, region.end));
    const values = samples(region, members.length, ctx);
    members.forEach((capsule, index) => apply(result.get(capsule.id), region, sourceValue(values[index])));
  }
  return result;
}

function apply(target, region, value) {
  // Волна на одной стороне отвечает на оба знака; разводит знаки по сторонам
  // только двусторонняя зона.
  const oneSidedWave = region.source === 'wave' && region.band !== 'both';
  const magnitude = Math.max(value.inner, value.outer);
  if (region.band === 'inner' || region.band === 'both') {
    target.inner = oneSidedWave ? magnitude : value.inner;
    target.hasInner = true;
    target.innerColor = region.innerColor ?? region.color ?? null;
  }
  if (region.band === 'outer' || region.band === 'both') {
    target.outer = oneSidedWave ? magnitude : value.outer;
    target.hasOuter = true;
    target.outerColor = region.outerColor ?? region.color ?? null;
  }
}
