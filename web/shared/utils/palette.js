// Главные цвета картинки — для кольца в голосовом режиме: обложка трека
// переливается по кругу своими цветами. Картинка уменьшается до PALETTE.sample
// точек, точки раскладываются по корзинам оттенка (вес — сочность), серое и
// тёмное не в счёт; из самых тяжёлых корзин — средние цвета, поднятые по
// яркости, чтобы светиться на чёрном. Итог — по кругу оттенков: переливы
// между соседями плавные.
//
// Чужая картинка отдаёт пиксели, только если её сайт разрешил (CORS). Нет
// разрешения — пустой список: цвета берёт хозяин (акцент).
import { PALETTE } from './constants.js';
import { hsvToHex, rgbToHsv } from './color.js';
import { h } from './dom.js';

const cache = new Map();

/** Главные цвета картинки по адресу — обещание списка #rrggbb (до PALETTE.count). */
export function imageColors(src) {
  if (!src) return Promise.resolve([]);
  if (!cache.has(src)) cache.set(src, load(src).then(pixelsOf).then(dominantColors).catch(() => []));
  return cache.get(src);
}

function load(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', reject, { once: true });
    image.src = src;
  });
}

// Пиксели уменьшенной копии; у картинки без разрешения CORS браузер бросает.
function pixelsOf(image) {
  const size = PALETTE.sample;
  const canvas = h('canvas', { width: size, height: size });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, size, size);
  return context.getImageData(0, 0, size, size).data;
}

/** RGBA-пиксели → главные цвета. Чистая функция: её проверяют без картинки. */
export function dominantColors(data) {
  const points = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] >= 128 && Math.max(data[i], data[i + 1], data[i + 2]) >= PALETTE.minValue * 255) {
      points.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  if (!points.length) return data.length ? [...PALETTE.plain] : [];
  const vivid = groups(points)
    .filter((group) => group.size >= points.length * PALETTE.minShare)
    .sort((a, b) => b.size - a.size)
    .map((group) => rgbToHsv(group.rgb))
    .filter((hsv) => hsv.s >= PALETTE.minSaturation);
  const kept = [];
  vivid.forEach((hsv) => {
    if (kept.length < PALETTE.count && !kept.some((other) => hueGap(other.h, hsv.h) < PALETTE.mergeHue)) kept.push(hsv);
  });
  if (!kept.length) return [...PALETTE.plain];
  const colors = kept.map(lift);
  if (colors.length === 1) colors.push(shade(colors[0]));
  return colors.sort((a, b) => a.h - b.h).map(hsvToHex);
}

// k-средних по RGB. Начало — точки, ровно разложенные по яркости: одна и та же
// картинка всегда даёт одни и те же цвета.
function groups(points) {
  const light = ([r, g, b]) => r * 0.3 + g * 0.59 + b * 0.11;
  const sorted = [...points].sort((a, b) => light(a) - light(b));
  let centers = Array.from({ length: PALETTE.groups }, (_, i) => sorted[Math.floor(((i + 0.5) * sorted.length) / PALETTE.groups)]);
  let sizes = [];
  for (let round = 0; round < PALETTE.rounds; round += 1) {
    const sums = centers.map(() => [0, 0, 0]);
    sizes = centers.map(() => 0);
    points.forEach((point) => {
      const i = nearest(centers, point);
      sums[i][0] += point[0];
      sums[i][1] += point[1];
      sums[i][2] += point[2];
      sizes[i] += 1;
    });
    centers = centers.map((center, i) => (sizes[i] ? sums[i].map((sum) => sum / sizes[i]) : center));
  }
  return centers.map((rgb, i) => ({ rgb, size: sizes[i] }));
}

function nearest(centers, [r, g, b]) {
  let best = 0;
  let distance = Infinity;
  centers.forEach(([cr, cg, cb], i) => {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
}

function hueGap(a, b) {
  const gap = Math.abs(a - b) % 360;
  return Math.min(gap, 360 - gap);
}

// Светиться на чёрном: светлее, сочнее, но тёмное — по-прежнему темнее светлого.
function lift({ h: hue, s, v }) {
  const [base, range] = PALETTE.lift.value;
  const [low, high] = PALETTE.lift.saturation;
  return { h: hue, s: Math.min(high, Math.max(low, s * PALETTE.lift.boost)), v: base + range * v };
}

function shade({ h: hue, s, v }) {
  const { hue: turn, saturation, value } = PALETTE.shade;
  return { h: (hue + turn) % 360, s: Math.min(1, s + saturation), v: v * value };
}
