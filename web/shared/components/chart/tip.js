// Подсказка графика: все видимые ряды в точке, значение главное.
import { h } from '../../utils/dom.js';
import { colorOf } from './data.js';
import { valueLabel } from './scale.js';

export function tipContent({ category, series, index, unit, total }) {
  const rows = series.map((item) => h('div', { class: 'chart__tip-row' },
    h('span', { class: 'chart__tip-key', style: { '--key-color': colorOf(item.slot) } }),
    h('span', { class: 'chart__tip-value', text: valueLabel(item.values[index], unit) }),
    h('span', { class: 'chart__tip-name', text: series.length > 1 ? item.name : '' })));
  const sum = total ? h('div', { class: 'chart__tip-total', text: `Всего ${valueLabel(series.reduce((acc, item) => acc + (item.values[index] ?? 0), 0), unit)}` }) : null;
  return [h('div', { class: 'chart__tip-head', text: category }), ...rows, sum];
}

/** Поставить подсказку справа от точки, а у правого края — слева. */
export function placeTip(tip, x, top, width) {
  const box = tip.offsetWidth;
  const left = x + 12 + box > width ? x - 12 - box : x + 12;
  tip.style.setProperty('--tip-x', `${Math.max(0, left)}px`);
  tip.style.setProperty('--tip-y', `${top}px`);
}
