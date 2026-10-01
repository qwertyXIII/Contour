// Шкала значений: «красивый» верх и деления (0 · 1 000 · 2 000…) и подписи чисел.

/** Деления от нуля до «красивого» верха не меньше max. */
export function niceTicks(max, steps = 4) {
  const top = max > 0 ? max : 1;
  const raw = top / steps;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  const nice = [1, 2, 2.5, 5, 10].find((step) => residual <= step) ?? 10;
  const step = nice * magnitude;
  const ceiling = Math.ceil(top / step - 1e-9) * step;
  const ticks = [];
  for (let value = 0; value <= ceiling + step / 2; value += step) ticks.push(Math.round(value * 1e6) / 1e6);
  return { max: ceiling, ticks };
}

const plain = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });

/** Подпись деления: крупные — «12 тыс.», мелкие — как есть. */
export function tickLabel(value) {
  return Math.abs(value) >= 10000 ? compact.format(value) : plain.format(value);
}

/** Значение в подсказке: полностью, с единицей. */
export function valueLabel(value, unit = '') {
  return value === null ? '—' : `${plain.format(value)}${unit}`;
}
