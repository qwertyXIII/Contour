// Цвет для пикера: HEX ↔ RGB ↔ HSV. Чистые функции — без DOM.
// HSV: h — 0…360, s и v — 0…1. RGB — 0…255.

/** «#abc», «abc», «#AABBCC» → «#aabbcc»; не цвет — null. */
export function normalizeHex(text) {
  const raw = String(text ?? '').trim().replace(/^#/, '').toLowerCase();
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw;
  return /^[0-9a-f]{6}$/.test(full) ? `#${full}` : null;
}

export function hexToRgb(hex) {
  const value = normalizeHex(hex) ?? '#000000';
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
}

export function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
}

export function rgbToHsv([r, g, b]) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const delta = max - Math.min(rn, gn, bn);
  let h = 0;
  if (delta) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? delta / max : 0, v: max };
}

export function hsvToRgb({ h, s, v }) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export const hsvToHex = (hsv) => rgbToHex(hsvToRgb(hsv));
export const hexToHsv = (hex) => rgbToHsv(hexToRgb(hex));
