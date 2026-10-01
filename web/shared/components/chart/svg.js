// Построение SVG без строк разметки: s('path', { class, d, style: { '--mark-color': … } }).
const NS = 'http://www.w3.org/2000/svg';

export function s(tag, attrs = {}, ...children) {
  const element = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (key === 'style') Object.entries(value).forEach(([name, v]) => element.style.setProperty(name, v));
    else if (key === 'text') element.textContent = value;
    else element.setAttribute(key, String(value));
  });
  element.append(...children.filter(Boolean));
  return element;
}

const round = (value) => Math.round(value * 100) / 100;

/** Столбик: скругление r только сверху (у конца с данными), у оси — прямой угол. */
export function barPath(x, y, width, height, radius = 4) {
  if (height <= 0 || width <= 0) return '';
  const r = Math.min(radius, width / 2, height);
  const [l, t, w, h] = [x, y, width, height].map(round);
  return `M${l} ${round(t + h)}V${round(t + r)}A${r} ${r} 0 0 1 ${round(l + r)} ${t}H${round(l + w - r)}A${r} ${r} 0 0 1 ${round(l + w)} ${round(t + r)}V${round(t + h)}Z`;
}

/** Прямоугольник без скруглений — внутренний сегмент стопки. */
export function rectPath(x, y, width, height) {
  if (height <= 0 || width <= 0) return '';
  const [l, t, w, h] = [x, y, width, height].map(round);
  return `M${l} ${t}H${round(l + w)}V${round(t + h)}H${l}Z`;
}

/**
 * Плавная линия через точки без выбросов за данные (монотонная кубическая,
 * Фриц — Карлсон): между двумя точками кривая не уходит выше большей и ниже
 * меньшей — плавность не выдумывает пиков, которых не было.
 */
export function smoothPath(points) {
  if (points.length < 2) return points.length ? `M${round(points[0].x)} ${round(points[0].y)}` : '';
  const n = points.length;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1].x - points[i].x);
    slope.push((points[i + 1].y - points[i].y) / dx[i]);
  }
  const tangent = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) {
    tangent.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  }
  tangent.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) { tangent[i] = 0; tangent[i + 1] = 0; continue; }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const len = a * a + b * b;
    if (len > 9) {
      const k = 3 / Math.sqrt(len);
      tangent[i] = k * a * slope[i];
      tangent[i + 1] = k * b * slope[i];
    }
  }
  let d = `M${round(points[0].x)} ${round(points[0].y)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const p = points[i];
    const q = points[i + 1];
    const h = dx[i] / 3;
    d += `C${round(p.x + h)} ${round(p.y + tangent[i] * h)} ${round(q.x - h)} ${round(q.y - tangent[i + 1] * h)} ${round(q.x)} ${round(q.y)}`;
  }
  return d;
}
