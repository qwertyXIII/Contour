/*
 * Геометрия кольца — чистые функции без DOM (их проверяют тесты в node).
 *
 * Углы упорядоченного кольца не сворачиваются в [0, 2π): капсула, ушедшая за
 * полный оборот, остаётся «после» последней, и порядок по кругу не рвётся.
 */

export const TAU = Math.PI * 2;

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/** Угол в радианах → доля оборота от верхней точки по часовой стрелке, 0…1. */
export function turn(angle) {
  return ((angle + Math.PI / 2) / TAU % 1 + 1) % 1;
}

/** Какие капсулы убрать при уменьшении числа: случайные среди незащищённых. */
export function removalCandidates(capsules, amount, random = Math.random) {
  const free = capsules.filter((capsule) => !capsule.protected && !capsule.retiring);
  if (amount > free.length) return null;
  for (let index = free.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(clamp(random(), 0, 0.999999) * (index + 1));
    [free[index], free[swap]] = [free[swap], free[index]];
  }
  return free.slice(0, amount);
}

/** Новые капсулы — в середины случайных промежутков, порядок сохраняется. */
export function insertAngles(angles, amount, random = Math.random) {
  const result = [...angles];
  for (let added = 0; added < amount; added += 1) {
    if (!result.length) {
      result.push(-Math.PI / 2);
      continue;
    }
    const gap = Math.floor(clamp(random(), 0, 0.999999) * result.length);
    const next = gap === result.length - 1 ? result[0] + TAU : result[gap + 1];
    result.splice(gap + 1, 0, (result[gap] + next) / 2);
  }
  return result;
}

/** Равномерная раскладка: ориентация прежняя, суммарный поворот — наименьший. */
export function evenAngles(angles) {
  if (!angles.length) return [];
  const step = TAU / angles.length;
  const origin = angles.reduce((sum, angle, index) => sum + angle - index * step, 0) / angles.length;
  return angles.map((_, index) => origin + index * step);
}

/**
 * Ширина, при которой капсулы не касаются.
 *
 * Капсула со скруглёнными концами остаётся в своём угловом секторе (половина
 * расстояния до соседей), и по половине зазора оставлено с каждой стороны. Мера
 * — ближайший к центру конец: там сектор уже всего. Нарочно с запасом: зазор
 * гарантирован во время движения, а не только в покое.
 */
export function safeWidths(capsules, gap) {
  const count = capsules.length;
  if (count === 0) return [];
  if (count === 1) return [Infinity];
  return capsules.map((capsule, index) => {
    const previous = index ? capsules[index - 1].angle : capsules[count - 1].angle - TAU;
    const next = index < count - 1 ? capsules[index + 1].angle : capsules[0].angle + TAU;
    const halfSector = Math.min(capsule.angle - previous, next - capsule.angle) / 2;
    const innerRadius = Math.max(0, capsule.innerRadius);
    return Math.max(0, 2 * innerRadius * Math.sin(Math.max(0, halfSector)) - gap);
  });
}

/** Лежит ли доля оборота в дуге [start, end); дуга может переходить через верх. */
export function inArc(position, start, end) {
  if (Math.abs(end - start) >= 1) return true;
  const first = ((start % 1) + 1) % 1;
  const last = ((end % 1) + 1) % 1;
  if (first === last) return false;
  return first < last
    ? position >= first && position < last
    : position >= first || position < last;
}
