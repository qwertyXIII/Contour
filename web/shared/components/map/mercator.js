// Проекция Web Mercator — та же, что у Яндекса, OSM и Google: точки ложатся
// одинаково у любого провайдера. Координаты везде — [долгота, широта].
import { MAP } from '../../utils/constants.js';

const MAX_LAT = 85.05112878;

/** [lon, lat] → доли мира [0…1, 0…1] (x вправо, y вниз). */
export function project([lon, lat]) {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

/** Доли мира → [lon, lat]. */
export function unproject([x, y]) {
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return [x * 360 - 180, lat];
}

/** Рамка вокруг точек: [[minLon, minLat], [maxLon, maxLat]] или null. */
export function boundsOf(points) {
  if (!points.length) return null;
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
}

/** Вписать рамку в поле width × height с отступом: { center, zoom }. */
export function fitBounds([[west, south], [east, north]], width, height, padding = MAP.fitPadding) {
  const [x1, y1] = project([west, north]);
  const [x2, y2] = project([east, south]);
  const spanX = Math.max(x2 - x1, 1e-9);
  const spanY = Math.max(y2 - y1, 1e-9);
  const fit = Math.min((width - padding * 2) / (spanX * MAP.tileSize), (height - padding * 2) / (spanY * MAP.tileSize));
  const zoom = Math.max(MAP.minZoom, Math.min(MAP.maxZoom, Math.log2(Math.max(fit, 1e-9))));
  return { center: unproject([(x1 + x2) / 2, (y1 + y2) / 2]), zoom };
}

/** «82.92,55.03 82.93,55.04» → [[82.92, 55.03], [82.93, 55.04]]. */
export function parsePoints(text = '') {
  return text.trim().split(/\s+/).filter(Boolean).map((pair) => pair.split(',').map(Number))
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}
