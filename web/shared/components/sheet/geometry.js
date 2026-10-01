// Где стоит лист: упоры, доля хода, резинка за упором и желе.
//
// Положение листа — одно число: высота видимой части в px (`pos`). Из него на
// кадре пишутся ровно две вещи: переменная --sheet-p (доля хода 0…1 — из неё CSS
// блока выводит вырез, отступы, скругления и цвета) и transform корня (уход вниз
// за нижний упор, растяжение за верхним, желе). Раскладку кадр не трогает:
// корень лежит в высоте верхнего упора, видимую часть вырезает clip-path.
import { SHEET } from '../../utils/constants.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function px(style, name, fallback = 0) {
  const value = parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

/** Резинка iOS: на сколько уйдёт лист, если палец ушёл за упор на `x` (d — размер окна). */
export function rubber(x, d) {
  if (d <= 0) return 0;
  const sign = Math.sign(x);
  const far = Math.abs(x);
  return sign * (1 - 1 / ((far * SHEET.rubber) / d + 1)) * d;
}

/**
 * Упоры — высоты видимой части по возрастанию — и край: высота, на которой лист
 * встаёт вплотную к краям окна.
 *
 * - Панель разговора (sheet_layered): закрытая (--sheet-closed блока) и весь
 *   корень — он и так во весь экран, высоту задаёт приложение.
 * - Прочие: корень в естественной высоте с потолком (max-height блока). Есть узлы
 *   [data-sheet-peek] — нижний упор по низу последнего из них, верхний — всё
 *   содержимое; нет — один упор. Край одного упора — потолок: лист в высоту
 *   окна касается краёв, короткий — плавает.
 *
 * Меряет раскладку — звать при открытии и по sheet:measure, не на кадре.
 * Спрятанный корень (hidden) — null: мерить нечего.
 */
export function measure(root) {
  const style = getComputedStyle(root);
  if (root.classList.contains(SHEET.class.layered)) {
    const full = root.offsetHeight;
    if (!full) return null;
    const closed = Math.min(px(style, '--sheet-closed', 0), full);
    return { detents: [closed, full], edge: full };
  }
  root.style.removeProperty('--sheet-h');
  const height = root.offsetHeight;
  if (!height) return null;
  const ceiling = parseFloat(style.maxHeight) || height;
  const top = root.getBoundingClientRect().top;
  const peeks = root.querySelectorAll(SHEET.peek);
  const last = peeks[peeks.length - 1];
  const peek = last ? last.getBoundingClientRect().bottom - top + px(style, '--sheet-peek-pad') : 0;
  // Свёрнутый должен быть заметно ниже раскрытого, иначе второй упор — дрожь на месте.
  const detents = peek > 0 && peek < height - px(style, '--sheet-peek-min') ? [Math.round(peek), height] : [height];
  return { detents, edge: detents.length > 1 ? height : ceiling };
}

/**
 * Записать размеры упоров блоку: из них CSS выводит вырез по --sheet-p. Только
 * перемены — переменные наследуются, и запись той же строки на каждый жест
 * пересчитывала бы стили всего, что внутри.
 */
export function applyLayout(root, layout) {
  const set = (name, value) => { if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value); };
  set('--sheet-h', `${layout.detents.at(-1)}px`);
  set('--sheet-low', `${layout.detents[0]}px`);
}

/** Доля хода: 0 — нижний упор, 1 — край. */
export function progress(pos, { detents, edge }) {
  const low = detents[0];
  const inside = clamp(pos, low, detents.at(-1));
  return edge > low ? clamp((inside - low) / (edge - low), 0, 1) : 1;
}

/**
 * Кадр: доля хода — в --sheet-p, остальное — transform. За нижним упором лист
 * уходит вниз целиком (закрыть вопрос, резинка панели), за верхним — растёт от
 * низа (резинка, отскок пружины); `jelly` — растяжение от скорости: вверх —
 * вытягивается, вниз — сжимается и раздаётся вбок. `lift` — подъём над клавиатурой.
 * Пишет только перемены: одинаковая строка — тоже запись и пересчёт стилей.
 * `followers` — части, которым долю пишем рядом с корнем (SHEET.followers).
 */
export function render(root, layout, { pos, jelly = 0, lift = 0 }, last, followers = []) {
  const low = layout.detents[0];
  const top = layout.detents.at(-1);
  const inside = clamp(pos, low, top);
  const p = progress(pos, layout).toFixed(4);
  const down = Math.max(0, inside - pos);
  const grow = top > 0 ? Math.max(0, pos - inside) / top : 0;
  const { max, stretch, keep } = SHEET.jelly;
  // Растяжение за упором и желе вместе — не больше stretch: «немного вытягивается».
  const sy = clamp((1 + grow) * (1 + jelly), 1 - max, 1 + stretch);
  const sx = 1 - jelly * keep;
  const shift = down - lift;
  const still = Math.abs(shift) < 0.01 && Math.abs(sy - 1) < 1e-4 && Math.abs(sx - 1) < 1e-4;
  const transform = still ? '' : `translate3d(0, ${shift.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  if (p !== last.p) {
    root.style.setProperty('--sheet-p', p);
    for (const el of followers) el.style.setProperty('--sheet-p', p);
  }
  if (transform !== last.transform) root.style.transform = transform;
  last.p = p;
  last.transform = transform;
  return Number(p);
}

/**
 * Перелёт пружины за упор — мягче, резинкой: бросок пальцем разгоняет пружину, и
 * без неё лист улетал бы за упор на десятки пикселей. Уход вниз закрываемого
 * вопроса не смягчается — он должен уйти за край.
 */
export function soften(pos, { detents }, { below = true } = {}) {
  const low = detents[0];
  const top = detents.at(-1);
  if (pos > top) return top + rubber(pos - top, top);
  if (below && pos < low) return low + rubber(pos - low, top);
  return pos;
}

/** Желе на кадр: к растяжению от скорости (px/мс, рост — плюс) со сглаживанием. */
export function jellyStep(current, velocity) {
  const { gain, max, smooth } = SHEET.jelly;
  const target = clamp(velocity * gain, -max, max);
  return current + (target - current) * smooth;
}
