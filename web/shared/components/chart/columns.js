// Столбики нескольких рядов в трёх формах:
//   stacked — стопкой: часть и целое, между сегментами зазор 2px;
//   grouped — рядом: сравнить ряды в одной точке, между столбиками 2px;
//   layered — внахлёст: задний шире, каждый следующий уже и отделён кольцом
//             цвета фона — видно все, даже если передний выше заднего.
import { barPath, rectPath, s } from './svg.js';
import { colorOf } from './data.js';

const GAP = 2;
const THICK = 24;

/** Верх шкалы: у стопки — сумма в точке, у остальных — наибольшее значение. */
export function columnsMax(form, series, count) {
  let max = 0;
  for (let i = 0; i < count; i += 1) {
    const values = series.map((item) => item.values[i] ?? 0);
    max = Math.max(max, form === 'stacked' ? values.reduce((a, b) => a + Math.max(0, b), 0) : Math.max(0, ...values));
  }
  return max;
}

function bar(d, slot, index, extra = '') {
  return d && s('path', { class: `chart__bar${extra}`, d, style: { '--mark-color': colorOf(slot), '--i': index } });
}

function stacked(i, cx, band, series, scale) {
  const width = Math.min(THICK, band * 0.56);
  const x = cx - width / 2;
  const present = series.filter((item) => (item.values[i] ?? 0) > 0);
  let sum = 0;
  return present.map((item, k) => {
    const value = item.values[i];
    const top = scale(sum + value);
    const height = scale(sum) - top;
    sum += value;
    if (k === present.length - 1) return bar(barPath(x, top, width, height), item.slot, i);
    const gap = height > GAP + 1 ? GAP : 0;
    return bar(rectPath(x, top + gap, width, height - gap), item.slot, i);
  });
}

function grouped(i, cx, band, series, scale) {
  const count = series.length;
  const width = Math.min(THICK, (band * 0.8 - (count - 1) * GAP) / count);
  const start = cx - (count * width + (count - 1) * GAP) / 2;
  return series.map((item, k) => {
    const value = item.values[i];
    if (value === null || value <= 0) return null;
    const top = scale(value);
    return bar(barPath(start + k * (width + GAP), top, width, scale(0) - top), item.slot, i);
  });
}

function layered(i, cx, band, series, scale) {
  const widest = Math.min(THICK, band * 0.62);
  const step = widest / (series.length + 1);
  return series.map((item, k) => {
    const value = item.values[i];
    if (value === null || value <= 0) return null;
    const width = widest - k * step;
    const top = scale(value);
    return bar(barPath(cx - width / 2, top, width, scale(0) - top), item.slot, i, k ? ' chart__bar_front' : '');
  });
}

const FORMS = { stacked, grouped, layered };

/** Нарисовать столбцы в layer; вернуть середину столбца по номеру — для подсказки. */
export function drawColumns(layer, { form, frame, count, series, scale }) {
  const band = frame.width / count;
  const draw = FORMS[form] ?? grouped;
  for (let i = 0; i < count; i += 1) {
    const cx = frame.left + band * (i + 0.5);
    const group = s('g', { class: 'chart__col', 'data-index': i });
    group.append(...draw(i, cx, band, series, scale).filter(Boolean));
    layer.append(group);
  }
  return {
    centerOf: (i) => frame.left + band * (i + 0.5),
    indexAt: (x) => Math.max(0, Math.min(count - 1, Math.floor((x - frame.left) / band))),
  };
}
