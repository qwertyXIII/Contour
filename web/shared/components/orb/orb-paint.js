/*
 * Кадр одной капсулы: из цели (сколько внутрь и наружу) — геометрия, цвета,
 * прозрачность, и запись в SVG.
 *
 * Порядок наложения: сигнал зон → фигура (маска и базовый силуэт; звук двигает
 * только её видимые капсулы) → занятость поверх голосов → ручная правка капсулы →
 * плавный переход к цели. Ручная правка последней: её задал человек.
 */

import { clamp, turn } from './orb-layout.js';
import { blend, mix } from './orb-color.js';
import { busyLevel } from './orb-signals.js';

const WHITE = [255, 255, 255];
/** Край SVG от центра (512 / 2 минус запас на свечение). */
const EDGE = 248;

/** Прозрачность состояния в покое: idle почти невидим. */
export const MODE_FLOOR = {
  idle: 0.16, listening: 0.34, thinking: 0.34, speaking: 0.38, success: 0.4, error: 0.4,
};

function smoothstep(value) {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

/**
 * Рост подхватывается почти сразу, затухание — медленнее: иначе дребезг или кисель.
 * Скорости — `rise` и `fall` вида (в секунду).
 */
function approach(current, target, seconds, config) {
  const rate = target > current ? config.rise : config.fall;
  return current + (target - current) * (1 - Math.exp(-rate * seconds));
}

/** Сигнал зон → длины, ширина и цвета; тихая капсула белая, пик — цвета режима. */
function fromSignal(signal, config, frame) {
  const innerValue = smoothstep(signal.inner);
  const outerValue = smoothstep(signal.outer);
  const halfRange = (config.maxLength - config.minLength) / 2;
  const tint = frame.palette[frame.mode] ?? WHITE;
  const innerColor = signal.innerColor ?? mix(WHITE, tint, innerValue);
  const outerColor = signal.outerColor ?? mix(WHITE, tint, outerValue);
  return {
    innerValue, outerValue, halfRange,
    inner: signal.hasInner ? config.minLength / 2 + innerValue * halfRange : 0,
    outer: signal.hasOuter ? config.minLength / 2 + outerValue * halfRange : 0,
    width: config.minWidth + Math.max(innerValue, outerValue) * (config.maxWidth - config.minWidth),
    radius: config.radius,
    activity: Math.max(innerValue, outerValue),
    innerColor, outerColor, signalInner: innerColor, signalOuter: outerColor,
  };
}

/** Фигура задаёт силуэт; сила эффекта — насколько звук и зоны двигают её капсулы. */
function applyShape(v, capsule, index, count, frame) {
  const altered = frame.shape({
    id: capsule.id, index, count, angle: turn(capsule.angle),
    radius: v.radius, inner: v.inner, outer: v.outer, width: v.width,
  }) ?? {};
  v.radius = altered.radius ?? v.radius;
  const baseWidth = altered.width ?? v.width;
  const strength = frame.strength;
  if (baseWidth > 0) {
    v.inner = (altered.inner ?? v.inner) + v.innerValue * v.halfRange * strength;
    v.outer = (altered.outer ?? v.outer) + v.outerValue * v.halfRange * strength;
    v.width = baseWidth + Math.max(v.innerValue, v.outerValue) * 3 * strength;
    const share = Math.min(strength, 1.5) * 0.72;
    v.innerColor = blend(altered.innerColor ?? v.signalInner, v.signalInner, v.innerValue * share);
    v.outerColor = blend(altered.outerColor ?? v.signalOuter, v.signalOuter, v.outerValue * share);
  } else {
    v.inner = 0;
    v.outer = 0;
    v.width = 0;
  }
  v.activity = altered.activity ?? v.activity;
}

/** Занятость — бегущий свет своим цветом поверх того, что рисуют голоса. */
function applyBusy(v, capsule, config, frame) {
  if (!frame.busy || v.width <= 0) return;
  const level = busyLevel(frame.busy, turn(capsule.angle), frame.now, config) * (frame.busyFade ?? 1);
  if (level <= 0) return;
  const share = frame.busy === 'tool' ? config.toolReach : config.thinkReach;
  const reach = config.minLength / 2 + level * v.halfRange * share;
  v.inner = Math.max(v.inner, reach);
  v.outer = Math.max(v.outer, reach);
  v.width = Math.max(v.width, config.minWidth + level * (config.maxWidth - config.minWidth) * 0.6);
  v.innerColor = blend(v.innerColor, frame.busyColor, level);
  v.outerColor = blend(v.outerColor, frame.busyColor, level);
  v.activity = Math.max(v.activity, level);
}

function applyOverrides(v, capsule, config) {
  const override = capsule.overrides;
  v.radius = clamp(v.radius, config.minInnerRadius, EDGE);
  v.inner = clamp(override.inner ?? v.inner, 0, v.radius - config.minInnerRadius);
  v.outer = clamp(override.outer ?? v.outer, 0, EDGE - v.radius);
  v.width = clamp(override.width ?? v.width, 0, 60);
  v.innerColor = override.innerColor ?? v.innerColor;
  v.outerColor = override.outerColor ?? v.outerColor;
}

/** К цели — переходом фигуры, если он идёт, иначе сглаживанием. */
function settle(v, capsule, config, frame) {
  const from = frame.morph?.from.get(capsule.id);
  if (!frame.snap && from && frame.morphProgress < 1) {
    const t = frame.morphProgress;
    capsule.currentRadius = lerp(from.radius, v.radius, t);
    capsule.currentInner = lerp(from.inner, v.inner, t);
    capsule.currentOuter = lerp(from.outer, v.outer, t);
    capsule.currentWidth = lerp(from.width, v.width, t);
    v.innerColor = blend(from.innerColor, v.innerColor, t);
    v.outerColor = blend(from.outerColor, v.outerColor, t);
    v.activity = lerp(from.activity, v.activity, t);
    return;
  }
  const jump = frame.snap || Boolean(from);
  const step = (current, target) => (jump ? target : approach(current, target, frame.elapsed, config));
  capsule.currentRadius = step(capsule.currentRadius, v.radius);
  capsule.currentInner = step(capsule.currentInner, v.inner);
  capsule.currentOuter = step(capsule.currentOuter, v.outer);
  capsule.currentWidth = step(capsule.currentWidth, v.width);
}

/** Видимое сейчас — с появлением и угасанием капсулы. */
export function capsuleVisual(capsule, signal, index, count, config, frame) {
  const v = fromSignal(signal, config, frame);
  if (frame.shape) applyShape(v, capsule, index, count, frame);
  applyBusy(v, capsule, config, frame);
  applyOverrides(v, capsule, config);
  settle(v, capsule, config, frame);
  const retiring = capsule.retiringAt === null ? 1 : 1 - clamp((frame.now - capsule.retiringAt) / config.appearMs);
  const appearing = capsule.newbornAt === null ? 1 : clamp((frame.now - capsule.newbornAt) / config.appearMs);
  const visibility = frame.immediate ? 1 : retiring * appearing;
  const inner = Math.min(capsule.currentInner * visibility, capsule.currentRadius - config.minInnerRadius);
  const outer = Math.min(capsule.currentOuter * visibility, EDGE - capsule.currentRadius);
  return {
    angle: capsule.angle,
    radius: capsule.currentRadius,
    innerRadius: capsule.currentRadius - inner,
    width: capsule.currentWidth * visibility,
    inner, outer, visibility,
    activity: v.activity, innerColor: v.innerColor, outerColor: v.outerColor,
  };
}

/**
 * В SVG — только если что-то изменилось. Кадр идёт 60 раз в секунду, а в тишине
 * капсулы стоят: без этой проверки каждый кадр переписывал бы по десятку
 * атрибутов на каждую капсулу.
 */
export function writeCapsule(capsule, visual, width, config, floor) {
  const length = Math.max(0, visual.inner + visual.outer);
  const attrs = {
    transform: `rotate(${(turn(capsule.angle) * 360).toFixed(3)} ${config.centerX} ${config.centerY})`,
    opacity: ((floor + visual.activity * (1 - floor)) * visual.visibility).toFixed(3),
    x: (config.centerX - width / 2).toFixed(2),
    y: (config.centerY - visual.radius - visual.outer).toFixed(2),
    width: width.toFixed(2),
    height: length.toFixed(2),
    rx: (width / 2).toFixed(2),
  };
  capsule.lastInnerColor = visual.innerColor;
  capsule.lastOuterColor = visual.outerColor;
  capsule.lastActivity = visual.activity;
  // Ключ — ровно то, что пишется: иначе последняя мелкая перемена (0,04 → 0) не дошла бы.
  const key = `${Object.values(attrs).join('|')}|${visual.innerColor}|${visual.outerColor}`;
  if (capsule.written === key) return;
  capsule.written = key;
  capsule.group.setAttribute('transform', attrs.transform);
  capsule.group.setAttribute('opacity', attrs.opacity);
  for (const name of ['x', 'y', 'width', 'height', 'rx']) capsule.rect.setAttribute(name, attrs[name]);
  capsule.outerStop.setAttribute('stop-color', visual.outerColor);
  capsule.innerStop.setAttribute('stop-color', visual.innerColor);
}
