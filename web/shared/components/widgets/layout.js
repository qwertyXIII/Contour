// Раскладка виджетов — чистые функции над списком { id, w, h, x, y }.
// x, y — клетка левого верхнего угла от нуля; w, h — размер в клетках.
// У каждого виджета свои координаты, пустые клетки допустимы.

const SIZE = /widgets__item_size_(\d)x(\d)/;

/** Размер виджета из модификатора widgets__item_size_WxH; без него — 1×1. */
export function sizeOf(element) {
  const match = element.className.match(SIZE);
  return match ? { w: Number(match[1]), h: Number(match[2]) } : { w: 1, h: 1 };
}

export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Сколько строк занято. */
export function rowsOf(layout) {
  return layout.reduce((max, item) => Math.max(max, item.y + item.h), 0);
}

/** По строкам, внутри строки — слева направо: так раскладку «читают». */
export function readingOrder(layout) {
  return [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
}

function free(placed, candidate) {
  return !placed.some((other) => overlaps(other, candidate));
}

// Первая свободная клетка по порядку чтения, где виджет помещается целиком.
function firstFit(placed, item, cols) {
  const w = Math.min(item.w, cols);
  for (let y = 0; ; y += 1) {
    for (let x = 0; x + w <= cols; x += 1) {
      const candidate = { ...item, w, x, y };
      if (free(placed, candidate)) return candidate;
    }
  }
}

/** Уложить виджеты по порядку без дыр — первая раскладка и раскладка для новой ширины. */
export function pack(items, cols) {
  const placed = [];
  items.forEach((item) => placed.push(firstFit(placed, item, cols)));
  return placed;
}

/** Раскладка для другого числа колонок: тот же порядок чтения, уложенный заново. */
export function adapt(layout, cols) {
  return pack(readingOrder(layout), cols);
}

/**
 * Привести чужую (сохранённую) раскладку к виджетам на экране: неизвестные
 * убрать, новые доложить, размер взять нынешний. Налезающие или не
 * влезающие по ширине — уложить заново, остальные остаются на своих местах.
 */
export function normalize(saved, items, cols) {
  const sizes = new Map(items.map((item) => [item.id, item]));
  const placed = [];
  const rest = [];
  readingOrder(saved.filter((item) => sizes.has(item.id))).forEach((item) => {
    const { w, h } = sizes.get(item.id);
    const candidate = { id: item.id, w, h, x: Math.trunc(item.x), y: Math.trunc(item.y) };
    const inside = candidate.x >= 0 && candidate.y >= 0 && candidate.x + w <= cols;
    if (inside && free(placed, candidate)) placed.push(candidate);
    else rest.push(candidate);
  });
  const known = new Set(placed.map((item) => item.id));
  items.filter((item) => !known.has(item.id) && !rest.some((r) => r.id === item.id)).forEach((item) => rest.push(item));
  rest.forEach((item) => placed.push(firstFit(placed, item, cols)));
  return placed;
}

// Ближайшая к исходному месту свободная клетка: сначала по расстоянию,
// при равенстве — выше, потом левее.
function nearestFree(placed, item, cols) {
  const limit = rowsOf(placed) + item.h + 1;
  let best = null;
  for (let y = 0; y <= limit; y += 1) {
    for (let x = 0; x + item.w <= cols; x += 1) {
      const candidate = { ...item, x, y };
      if (!free(placed, candidate)) continue;
      const score = Math.abs(x - item.x) + Math.abs(y - item.y);
      if (!best || score < best.score) best = { score, candidate };
    }
  }
  return best ? best.candidate : firstFit(placed, item, cols);
}

const STEPS = {
  down: (item, by) => ({ ...item, y: by.y + by.h }),
  up: (item, by) => ({ ...item, y: by.y - item.h }),
  right: (item, by) => ({ ...item, x: by.x + by.w }),
  left: (item, by) => ({ ...item, x: by.x - item.w }),
};

function inside(item, cols) {
  return item.x >= 0 && item.y >= 0 && item.x + item.w <= cols;
}

// Вытолкнуть виджет из-под blocker в сторону dir; кого он задел — толкнуть
// дальше в ту же сторону (цепочкой). Не вышло (упёрлись в край или в
// неподвижное) — null. layout — Map id → виджет, меняется только копия.
function shove(layout, id, blocker, dir, cols, locked) {
  const moved = STEPS[dir](layout.get(id), blocker);
  if (!inside(moved, cols)) return null;
  const next = new Map(layout).set(id, moved);
  const guard = new Set(locked).add(id);
  for (const other of next.values()) {
    if (other.id === id || !overlaps(other, moved)) continue;
    if (guard.has(other.id)) return null;
    const pushed = shove(next, other.id, moved, dir, cols, guard);
    if (!pushed) return null;
    pushed.forEach((value, key) => next.set(key, value));
  }
  return next;
}

function cost(from, to) {
  let total = 0;
  to.forEach((item, key) => {
    const was = from.get(key);
    total += Math.abs(item.x - was.x) + Math.abs(item.y - was.y);
  });
  return total;
}

// Куда убрать виджет из-под брошенного: четыре стороны с толчком по цепочке
// и «перейти в ближайшую свободную клетку». Берётся вариант, при котором
// всё сдвинулось меньше всего; при равенстве — первый по порядку предпочтений.
function makeRoom(layout, id, dropped, cols, prefer) {
  const locked = new Set([dropped.id]);
  const options = prefer.map((dir) => shove(layout, id, dropped, dir, cols, locked)).filter(Boolean);
  const others = [...layout.values()].filter((item) => item.id !== id);
  options.push(new Map(layout).set(id, nearestFree(others, layout.get(id), cols)));
  return options.reduce((best, option) => (cost(layout, option) < cost(layout, best) ? option : best));
}

// Порядок сторон: сначала туда, откуда пришёл перетаскиваемый (там освободилось), потом вниз.
function preference(from, to) {
  const toward = [];
  if (from.x < to.x) toward.push('left');
  if (from.x > to.x) toward.push('right');
  if (from.y < to.y) toward.push('up');
  if (from.y > to.y) toward.push('down');
  return [...new Set([...toward, 'down', 'right', 'left', 'up'])];
}

/**
 * Поставить виджет id в клетку target. Кто оказался под ним — отходит:
 * сдвигается в сторону, толкая соседей по цепочке, или переходит на
 * ближайшее свободное место — что сдвинет меньше. Не задетые не двигаются.
 * Считается всегда от раскладки начала перетаскивания: увёл виджет дальше —
 * соседи возвращаются на свои места.
 */
export function place(start, id, target, cols) {
  const moving = start.find((item) => item.id === id);
  if (!moving) return start;
  const dropped = { ...moving, x: Math.max(0, Math.min(cols - moving.w, target.x)), y: Math.max(0, target.y) };
  let layout = new Map(start.map((item) => [item.id, item])).set(id, dropped);
  const prefer = preference(moving, dropped);
  readingOrder(start).forEach(({ id: other }) => {
    if (other === id || !overlaps(layout.get(other), dropped)) return;
    layout = makeRoom(layout, other, dropped, cols, prefer);
  });
  return start.map((item) => layout.get(item.id));
}

/** Одинаковы ли раскладки (по местам). */
export function same(a, b) {
  const byId = new Map(b.map((item) => [item.id, item]));
  return a.length === b.length && a.every((item) => {
    const other = byId.get(item.id);
    return other && other.x === item.x && other.y === item.y;
  });
}
