// Линии: плавные (монотонная кубическая), 2px; у формы area — заливка 10%.
// Пропуск в данных (пустая ячейка) рвёт линию, а не рисует ноль.
// У конца — точка с кольцом цвета фона и подпись ряда (не больше четырёх
// рядов): сблизившиеся подписи разводятся и тянут к линии тонкую выноску.
import { s, smoothPath } from './svg.js';
import { colorOf } from './data.js';

const LABEL_GAP = 14;

export function linesMax(series) {
  return Math.max(0, ...series.flatMap((item) => item.values.filter((value) => value !== null)));
}

function runs(values, x, y) {
  const out = [];
  let run = [];
  values.forEach((value, i) => {
    if (value === null) {
      if (run.length) out.push(run);
      run = [];
      return;
    }
    run.push({ x: x(i), y: y(value) });
  });
  if (run.length) out.push(run);
  return out;
}

function drawSeries(layer, item, { form, x, scale, base }) {
  const color = { '--mark-color': colorOf(item.slot) };
  const parts = runs(item.values, x, scale);
  parts.forEach((run) => {
    const line = smoothPath(run);
    if (form === 'area' && run.length > 1) {
      const last = run[run.length - 1];
      layer.append(s('path', { class: 'chart__area', d: `${line}L${last.x} ${base}L${run[0].x} ${base}Z`, style: color }));
    }
    layer.append(s('path', { class: 'chart__line', d: line, pathLength: 1, style: color }));
  });
  const lastRun = parts[parts.length - 1];
  const end = lastRun?.[lastRun.length - 1];
  if (end) layer.append(s('circle', { class: 'chart__dot', cx: end.x, cy: end.y, r: 4, style: color }));
  return end;
}

// Подписи у концов: по порядку сверху вниз, не ближе LABEL_GAP друг к другу.
function spread(ends, top, bottom) {
  const sorted = [...ends].sort((a, b) => a.y - b.y);
  sorted.forEach((end, i) => { end.at = Math.max(end.y, i ? sorted[i - 1].at + LABEL_GAP : top); });
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const limit = i === sorted.length - 1 ? bottom : sorted[i + 1].at - LABEL_GAP;
    sorted[i].at = Math.min(sorted[i].at, limit);
  }
  return sorted;
}

function drawLabels(layer, ends, frame) {
  spread(ends, frame.top + 4, frame.top + frame.height).forEach((end) => {
    const x = end.point.x + 10;
    if (Math.abs(end.at - end.y) > 2) layer.append(s('path', { class: 'chart__leader', d: `M${end.point.x + 5} ${end.y}L${x - 2} ${end.at}` }));
    layer.append(s('text', { class: 'chart__label', x, y: end.at + 4, text: end.name }));
  });
}

/** Нарисовать линии; вернуть x по номеру точки и номер по x — для перекрестия. */
export function drawLines(layer, { form, frame, count, series, scale, labels }) {
  const step = count > 1 ? frame.width / (count - 1) : 0;
  const x = (i) => (count > 1 ? frame.left + i * step : frame.left + frame.width / 2);
  const base = scale(0);
  const ends = [];
  series.forEach((item) => {
    const point = drawSeries(layer, item, { form, x, scale, base });
    if (point) ends.push({ point, y: point.y, name: item.name });
  });
  if (labels) drawLabels(layer, ends, frame);
  return {
    centerOf: x,
    indexAt: (px) => (count > 1 ? Math.max(0, Math.min(count - 1, Math.round((px - frame.left) / step))) : 0),
  };
}
