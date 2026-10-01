// Раскладка альбома: какие плитки в какой строке. Чистая функция, без DOM.
//
// Высота строки при заданной ширине — (ширина − промежутки) / сумма пропорций,
// поэтому строку можно оценить до загрузки картинок. Разрезы выбираются
// перебором (динамикой по префиксам): штраф строки — квадрат отклонения её
// высоты от желаемой, в долях желаемой. Четыре горизонтальных фото дают 2 + 2,
// портрет с двумя горизонтальными — портрет отдельно или рядом, что ближе.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * @param {number[]} ratios — ширина / высота каждой плитки
 * @param {{ width: number, gap: number, maxPerRow: number, targetShare: number,
 *   minRatio: number, maxRatio: number, singleMin: number }} options
 * @returns {{ share: number, rowGaps: number, fit: number }[]} — на каждую плитку
 */
export function layoutAlbum(ratios, { width, gap, maxPerRow, targetShare, minRatio, maxRatio, singleMin }) {
  const fit = ratios.map((ratio) => clamp(ratio > 0 ? ratio : 1, minRatio, maxRatio));
  const target = width * targetShare;
  const best = [{ cost: 0, from: 0 }];

  for (let end = 1; end <= fit.length; end += 1) {
    best[end] = { cost: Infinity, from: end - 1 };
    for (let size = 1; size <= Math.min(maxPerRow, end); size += 1) {
      const start = end - size;
      const height = rowHeight(fit, start, end, { width, gap, singleMin });
      const cost = best[start].cost + ((height - target) / target) ** 2;
      if (cost < best[end].cost) best[end] = { cost, from: start };
    }
  }

  const result = [];
  for (let end = fit.length; end > 0; end = best[end].from) {
    const start = best[end].from;
    const row = rowFit(fit, start, end, singleMin);
    const sum = row.reduce((total, ratio) => total + ratio, 0);
    result.unshift(...row.map((ratio) => ({ share: ratio / sum, rowGaps: end - start - 1, fit: ratio })));
  }
  return result;
}

// Одна плитка в строке — портрет не должен стать столбом во всю ширину.
function rowFit(fit, start, end, singleMin) {
  const row = fit.slice(start, end);
  return row.length === 1 ? [Math.max(row[0], singleMin)] : row;
}

function rowHeight(fit, start, end, { width, gap, singleMin }) {
  const sum = rowFit(fit, start, end, singleMin).reduce((total, ratio) => total + ratio, 0);
  return (width - gap * (end - start - 1)) / sum;
}
