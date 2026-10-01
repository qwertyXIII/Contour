// Данные графика из таблицы: первая колонка — подписи по оси X, заголовки
// остальных — ряды. data-series у заголовка закрепляет цвет за рядом, иначе
// — по порядку колонок. Значение — data-value у ячейки или её текст.
const SLOTS = 8;

function parse(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).replace(/[\s  ]/g, '').replace(',', '.');
  if (text === '' || text === '—' || text === '-') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** { categories: string[], series: [{ name, slot, values: (number|null)[], hidden }] } */
export function readTable(table) {
  const head = [...(table.tHead?.rows[0]?.cells ?? [])];
  const series = head.slice(1).map((cell, index) => ({
    name: cell.textContent.trim(),
    slot: Math.min(SLOTS, Number(cell.dataset.series) || index + 1),
    values: [],
    hidden: false,
  }));
  const categories = [];
  [...(table.tBodies[0]?.rows ?? [])].forEach((row) => {
    const [label, ...cells] = row.cells;
    categories.push(label?.textContent.trim() ?? '');
    series.forEach((item, index) => item.values.push(parse(cells[index]?.dataset.value ?? cells[index]?.textContent)));
  });
  return { categories, series };
}

/** Классы ячейкам таблицы: у блока нет селекторов по тегам. */
export function markCells(table) {
  table.querySelectorAll('th, td').forEach((cell) => {
    cell.classList.add('chart__cell');
    if (cell.tagName === 'TH') cell.classList.add('chart__cell_head');
  });
}

export const colorOf = (slot) => `var(--color-series-${slot})`;
