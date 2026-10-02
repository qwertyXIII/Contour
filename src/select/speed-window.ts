/**
 * Окно замеров: последние N значений с моментом каждого.
 *
 * Окно с медианой, а не EWMA, — по трём причинам:
 * - у времени до первого байта тяжёлый правый хвост: сайт задумался, потерялся
 *   пакет, DoH промахнулся мимо кэша. Один выброс в 3 с при α = 0,2 сдвигает
 *   EWMA на 600 мс и тянется ещё десяток замеров — этого хватило бы, чтобы
 *   перекинуть сервис на другой выход. Медиана окна из 15 не замечает до 7 выбросов;
 * - «данных достаточно» — это «сколько свежих замеров», а у EWMA нет ни счёта,
 *   ни возраста без лишних полей;
 * - замеры стареют: окно отбрасывает старые по моменту, EWMA помнит их вечно.
 * Цена — 15 чисел на пару вместо двух; при пределе числа сервисов это мелочь.
 */

/** Значение и когда замерено. Кортеж, а не объект: в файле их тысячи. */
export type Sample = [value: number, at: number];

/** В конец; длиннее `cap` — выбросить самые старые. */
export function pushSample(window: Sample[], value: number, at: number, cap: number): void {
  window.push([value, at]);
  if (window.length > cap) window.splice(0, window.length - cap);
}

/** Значения не старше `maxAgeMs`. */
export function freshValues(window: readonly Sample[], now: number, maxAgeMs: number): number[] {
  const out: number[] = [];
  for (const [value, at] of window) if (now - at <= maxAgeMs) out.push(value);
  return out;
}

/** Квантиль с линейной интерполяцией; пусто — null. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  return a + ((sorted[hi] as number) - a) * (pos - lo);
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

/** Окно из файла: только пары конечных чисел, не больше `cap`. Мусор — пустое окно, не ошибка. */
export function cleanWindow(raw: unknown, cap: number): Sample[] {
  if (!Array.isArray(raw)) return [];
  const out: Sample[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [value, at] = item as unknown[];
    if (typeof value === 'number' && typeof at === 'number' && Number.isFinite(value) && Number.isFinite(at) && value >= 0) out.push([value, at]);
  }
  return out.slice(-cap);
}

/** Самый поздний момент в окнах; пусто — null. */
export function lastAt(...windows: ReadonlyArray<readonly Sample[]>): number | null {
  let last: number | null = null;
  for (const w of windows) for (const [, at] of w) if (last === null || at > last) last = at;
  return last;
}
