/*
 * Цвета кольца: палитра из CSS-переменных и смешивание.
 *
 * Значения берутся из переменных приложения, а не дублируются здесь: «поправил в
 * styles.css, а кольцо осталось прежним» — ровно тот разъезд, которого мы избегаем.
 */

import { clamp } from './orb-layout.js';

const WHITE = [255, 255, 255];

/** `#fe6344` → [254, 99, 68]; не hex — запасной цвет. */
export function parseHex(raw, fallback = WHITE) {
  const hex = String(raw ?? '').trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return fallback;
  const number = Number.parseInt(hex, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

/** `{ имя: '--переменная' }` → `{ имя: [r, g, b] }`. */
export function readPalette(variables) {
  const root = getComputedStyle(document.documentElement);
  const palette = {};
  for (const [name, variable] of Object.entries(variables)) {
    palette[name] = parseHex(root.getPropertyValue(variable));
  }
  return palette;
}

export function rgb(channels) {
  return `rgb(${channels.join(',')})`;
}

/** [254, 99, 68] → `#fe6344`. */
export function toHex(channels) {
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

export function mix(from, to, amount) {
  const value = clamp(amount);
  return `rgb(${from.map((channel, index) => Math.round(channel + (to[index] - channel) * value)).join(',')})`;
}

/** Цвет-строка (`#rrggbb` или `rgb(…)`) → каналы. */
function channels(value) {
  const raw = String(value ?? '').trim();
  if (/^#[\da-f]{6}$/i.test(raw)) return parseHex(raw);
  const rgb = raw.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i);
  return rgb ? rgb.slice(1).map(Number) : WHITE;
}

/** Смешать два цвета-строки. */
export function blend(from, to, amount) {
  return mix(channels(from), channels(to), amount);
}
