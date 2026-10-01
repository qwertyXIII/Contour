/*
 * Настройки кольца: умолчания движка, что из них — вид (его правят на экране
 * «Кольцо и звук» и хранят на сервере, ADR-0053), их проверка и кривые перехода.
 *
 * Вид приходит снаружи — с сервера или с ползунка, — поэтому каждое значение
 * проверяется здесь: число вне границ прижимается, чужой ключ и мусор
 * отбрасываются. Кольцо не должно ломаться от того, что в настройках лежит «abc».
 */

import { clamp } from './orb-layout.js';
import { parseHex } from './orb-color.js';

export const DEFAULTS = {
  count: 36,
  maxCount: 128,
  centerX: 256,
  centerY: 256,
  radius: 166,
  minInnerRadius: 82,
  gap: 4,
  minWidth: 5,
  maxWidth: 11,
  minLength: 5,
  maxLength: 66,
  reflowMs: 760,
  appearMs: 460,
  /** Отклик на звук: рост подхватывается почти сразу, затухание — медленнее. В секунду. */
  rise: 25,
  fall: 8,
  /** «Думает» — две головы: оборотов в секунду, ширина головы (доля круга), доля размаха. */
  thinkSpeed: 0.26,
  thinkWidth: 0.1,
  thinkReach: 0.8,
  /** Комета инструмента: оборотов в секунду, хвост (доля круга), доля размаха. */
  toolSpeed: 0.55,
  toolTail: 0.22,
  toolReach: 0.8,
  /** Свет занятости (обоих видов) появляется и гаснет за столько, а не вспышкой. */
  busyFadeMs: 500,
  /** Цвета света занятости; пусто — из темы (`--coral`, `--tool`). */
  thinkColor: '',
  toolColor: '',
  shapeTransitionMs: 850,
  shapeEasing: 'ease-in-out',
  shapeEffectStrength: 1,
};

export const EASINGS = ['linear', 'ease-out', 'ease-in-out', 'spring'];

/** Что из настроек — вид: границы, в которых кольцо ещё кольцо. */
const LOOK = {
  count: [1, DEFAULTS.maxCount],
  maxLength: [0, 240],
  gap: [0, 20],
  minWidth: [0.5, 30],
  maxWidth: [0.5, 30],
  rise: [0.5, 120],
  fall: [0.5, 120],
  thinkSpeed: [0, 5],
  thinkWidth: [0.01, 0.5],
  thinkReach: [0, 2],
  toolSpeed: [0, 5],
  toolTail: [0.01, 1],
  toolReach: [0, 2],
  busyFadeMs: [0, 3000],
  shapeTransitionMs: [0, 3000],
  shapeEffectStrength: [0, 1.5],
};
const COLORS = ['thinkColor', 'toolColor'];

/** Ключи вида, которые движок понимает. Экран и сервер пользуются ровно ими. */
export const LOOK_KEYS = [...Object.keys(LOOK), ...COLORS, 'shapeEasing'];

/** Проверить вид: вернуть только понятое движку и уже в его границах. */
export function sanitizeLook(patch = {}) {
  const clean = {};
  for (const [key, [min, max]] of Object.entries(LOOK)) {
    if (!(key in patch) || patch[key] === '' || patch[key] === null) continue;
    const value = Number(patch[key]);
    if (!Number.isFinite(value)) continue;
    clean[key] = key === 'count' ? Math.round(clamp(value, min, max)) : clamp(value, min, max);
  }
  for (const key of COLORS) {
    if (!(key in patch)) continue;
    const raw = String(patch[key] ?? '').trim();
    clean[key] = /^#?[0-9a-f]{6}$/i.test(raw) ? `#${raw.replace('#', '')}` : '';
  }
  if (EASINGS.includes(patch.shapeEasing)) clean.shapeEasing = patch.shapeEasing;
  return clean;
}

/** Настройки движка из опций: не-вид — как есть, вид — только проверенным. */
export function configOf(options = {}) {
  const rest = Object.fromEntries(Object.entries(options).filter(([key]) => !LOOK_KEYS.includes(key)));
  return { ...DEFAULTS, ...rest, ...sanitizeLook(options) };
}

/** Цвета занятости: свой — если задан, иначе из темы. */
export function busyPalette(config, theme) {
  return {
    thinking: config.thinkColor ? parseHex(config.thinkColor) : theme.thinking,
    tool: config.toolColor ? parseHex(config.toolColor) : theme.tool,
  };
}

/**
 * Доля перехода фигуры по времени. «Подпружинено» (владелец, 2026-09-29) — кривая
 * Безье с лёгким перелётом: фигура чуть проскакивает цель и возвращается.
 */
export function easeAmount(value, easing) {
  const t = clamp(value);
  if (easing === 'linear') return t;
  if (easing === 'ease-out') return 1 - (1 - t) ** 3;
  if (easing === 'spring') return cubicBezier(0.34, 1.36, 0.64, 1, t);
  return t * t * (3 - 2 * t);
}

/** `cubic-bezier(x1, y1, x2, y2)` в точке `x`: найти параметр по x, отдать y. */
export function cubicBezier(x1, y1, x2, y2, x) {
  const at = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let low = 0;
  let high = 1;
  let t = x;
  for (let step = 0; step < 30; step += 1) {
    const current = at(x1, x2, t);
    if (Math.abs(current - x) < 1e-6) break;
    if (current < x) low = t;
    else high = t;
    t = (low + high) / 2;
  }
  return at(y1, y2, t);
}
