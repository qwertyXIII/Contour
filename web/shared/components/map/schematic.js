// Схематический провайдер карты: без подложки и без сети — тихий фон, линия
// маршрута и метки на токенах. Сейчас он единственный; дальше — запасной вид,
// когда настоящей карты нет (нет ключа, нет сети, телевизор без провайдера).
// Не двигается и не масштабируется пальцем: это рисунок, а не карта.
import { MAP } from '../../utils/constants.js';
import { drawable } from '../../utils/motion.js';
import { fitBounds, project } from './mercator.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, className) {
  const el = document.createElementNS(SVG_NS, tag);
  el.setAttribute('class', className);
  return el;
}

export function createSchematicMap(container, { center = [0, 0], zoom = MAP.minZoom } = {}) {
  const root = svg('svg', 'map__svg');
  root.setAttribute('aria-hidden', 'true');
  const casing = svg('path', 'map__route-casing');
  const line = svg('path', 'map__route');
  root.append(casing, line);
  container.append(root);
  // Долю пути линия держит сама (pathLength): пересчёт d при смене размера её не сбрасывает.
  const drawShare = drawable([casing, line]);

  let view = { center, zoom };
  let markers = [];
  let route = null;

  const draw = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;
    const { center: [lon, lat], zoom: z } = view.bounds ? fitBounds(view.bounds, width, height, view.padding) : view;
    const scale = MAP.tileSize * 2 ** z;
    const [cx, cy] = project([lon, lat]);
    const toPx = (point) => {
      const [x, y] = project(point);
      return [(x - cx) * scale + width / 2, (y - cy) * scale + height / 2];
    };
    root.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const d = route?.points?.length ? route.points.map((p, i) => `${i ? 'L' : 'M'}${toPx(p).map((v) => v.toFixed(1)).join(' ')}`).join('') : '';
    casing.setAttribute('d', d);
    line.setAttribute('d', d);
    markers.forEach(({ at, el }) => {
      const [x, y] = toPx(at);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    });
  };

  const observer = new ResizeObserver(draw);
  observer.observe(container);

  return {
    attribution: MAP.labels.schematic,
    setView(next) { view = next; draw(); },
    setMarkers(list) { markers = list; draw(); },
    setRoute(next) { route = next; draw(); },
    // Провести линию до доли пути 0…1 — появление маршрута ведёт блок map.
    drawRoute(share) { drawShare(share); },
    // Цвета — токены, схема перекрашивается вместе с темой сама.
    setTheme() {},
    destroy() {
      observer.disconnect();
      root.remove();
    },
  };
}
