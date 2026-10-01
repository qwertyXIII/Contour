/*
 * Фигуры из капсул кольца: сердце, куб, Play, Pause, звезда, многоугольники и
 * прочее. Каждый видимый штрих — по-прежнему капсула кольца: фигура задаёт каждой
 * капсуле расстояние от центра, длину внутрь и наружу, ширину и цвета.
 *
 * Пока не применяются (решение владельца 2026-09-29): пригодятся с музыкой.
 * Проверяются тестами; включаются `orb.setShape(shapeFor(id))`.
 */

const TAU = Math.PI * 2;
const CORAL = '#fe6344';
const PEACH = '#ffae91';
const WHITE = '#fff5ef';

export const SHAPE_PRESETS = [
  { id: 'circle', label: 'Кольцо', hint: 'Исходный орб Alter', mark: true },
  { id: 'heart', label: 'Сердце', hint: 'Ясная выемка сверху и острый кончик снизу', mark: false },
  { id: 'cube', label: 'Куб', hint: 'Шестиугольник и три внутренние грани', mark: false },
  { id: 'play', label: 'Play ▶', hint: 'Треугольная кнопка из радиальных штрихов', mark: false },
  { id: 'pause', label: 'Pause ❚❚', hint: 'Два прямоугольника из капсул', mark: false },
  { id: 'star', label: 'Звезда', hint: 'Пять острых лучей', mark: false },
  { id: 'triangle', label: 'Треугольник', hint: 'Контур из трёх граней', mark: false },
  { id: 'square', label: 'Квадрат', hint: 'Четыре прямые стороны', mark: false },
  { id: 'diamond', label: 'Ромб', hint: 'Вытянутый четырёхугольник', mark: false },
  { id: 'hexagon', label: 'Шестиугольник', hint: 'Шесть ровных граней', mark: false },
  { id: 'pentagon', label: 'Пятиугольник', hint: 'Пять ровных граней', mark: false },
  { id: 'octagon', label: 'Восьмиугольник', hint: 'Восемь ровных граней', mark: false },
  { id: 'shield', label: 'Щит', hint: 'Широкие плечи и нижнее остриё', mark: false },
  { id: 'drop', label: 'Капля', hint: 'Заострённый верх и округлый низ', mark: false },
  { id: 'moon', label: 'Полумесяц', hint: 'Дуга с вырезанной серединой', mark: false },
  { id: 'sun', label: 'Солнце', hint: 'Двенадцать коротких лучей', mark: false },
  { id: 'gear', label: 'Шестерня', hint: 'Восемь мягких зубцов', mark: false },
  { id: 'spiral', label: 'Спираль', hint: 'Один виток от центра к краю', mark: false },
  { id: 'flower', label: 'Цветок', hint: 'Шесть мягких лепестков', mark: false },
];

export function shapePreset(id) {
  return SHAPE_PRESETS.find((preset) => preset.id === id) ?? SHAPE_PRESETS[0];
}

function ray(angle) {
  const theta = angle * TAU;
  return { x: Math.sin(theta), y: -Math.cos(theta) };
}

function cross(a, b) { return a.x * b.y - a.y * b.x; }

export function polygonRadius(vertices, angle) {
  const direction = ray(angle);
  let radius = Infinity;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    const edge = { x: b.x - a.x, y: b.y - a.y };
    const denominator = cross(direction, edge);
    if (Math.abs(denominator) < 1e-9) continue;
    const distance = cross(a, edge) / denominator;
    const alongEdge = cross(a, direction) / denominator;
    if (distance > 0 && alongEdge >= -1e-8 && alongEdge <= 1 + 1e-8) {
      radius = Math.min(radius, distance);
    }
  }
  return Number.isFinite(radius) ? radius : null;
}

function rayRectangle(direction, rect) {
  let enter = 0;
  let exit = Infinity;
  for (const axis of ['x', 'y']) {
    const component = direction[axis];
    const low = rect[`${axis}Min`];
    const high = rect[`${axis}Max`];
    if (Math.abs(component) < 1e-9) {
      if (low > 0 || high < 0) return null;
      continue;
    }
    const a = low / component;
    const b = high / component;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
  }
  return exit > enter && exit > 0 ? { enter, exit } : null;
}

function polygon(vertices, options = {}) {
  return ({ angle }) => {
    const radius = polygonRadius(vertices, angle);
    if (radius === null) return { width: 0, inner: 0, outer: 0 };
    const colors = options.colors?.(angle) ?? [CORAL, WHITE];
    return {
      radius,
      inner: options.inner ?? 9,
      outer: options.outer ?? 9,
      width: options.width ?? 12,
      innerColor: colors[0],
      outerColor: colors[1],
      activity: 1,
    };
  };
}

function regularPolygon(sides, radius, rotation = 0) {
  return Array.from({ length: sides }, (_, index) => {
    const theta = -Math.PI / 2 + rotation + index * TAU / sides;
    return { x: Math.cos(theta) * radius, y: Math.sin(theta) * radius };
  });
}

function cubic(from, controlA, controlB, to, steps = 24) {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    const back = 1 - t;
    return {
      x: back ** 3 * from.x + 3 * back ** 2 * t * controlA.x
        + 3 * back * t ** 2 * controlB.x + t ** 3 * to.x,
      y: back ** 3 * from.y + 3 * back ** 2 * t * controlA.y
        + 3 * back * t ** 2 * controlB.y + t ** 3 * to.y,
    };
  });
}

function mirroredOutline(rightSide) {
  return [...rightSide, ...rightSide.slice(1, -1).reverse().map(({ x, y }) => ({ x: -x, y }))];
}

const heart = mirroredOutline([
  ...cubic({ x: 0, y: -98 }, { x: 46, y: -173 }, { x: 150, y: -180 }, { x: 188, y: -110 }),
  ...cubic({ x: 188, y: -110 }, { x: 240, y: -5 }, { x: 128, y: 112 }, { x: 0, y: 216 }).slice(1),
]);

const drop = mirroredOutline([
  ...cubic({ x: 0, y: -216 }, { x: 32, y: -129 }, { x: 150, y: -35 }, { x: 151, y: 67 }),
  ...cubic({ x: 151, y: 67 }, { x: 153, y: 153 }, { x: 82, y: 205 }, { x: 0, y: 205 }).slice(1),
]);

const triangle = [
  { x: 0, y: -216 }, { x: 190, y: 111 }, { x: -190, y: 111 },
];
const play = [
  { x: -102, y: -155 }, { x: 187, y: 0 }, { x: -102, y: 155 },
];
const square = [
  { x: -158, y: -158 }, { x: 158, y: -158 },
  { x: 158, y: 158 }, { x: -158, y: 158 },
];
const diamond = [
  { x: 0, y: -214 }, { x: 186, y: 0 },
  { x: 0, y: 214 }, { x: -186, y: 0 },
];
const hexagon = regularPolygon(6, 204);
const pentagon = regularPolygon(5, 211);
const octagon = regularPolygon(8, 204, Math.PI / 8);
const shield = [
  { x: 0, y: -189 }, { x: 170, y: -145 }, { x: 148, y: 45 },
  { x: 0, y: 216 }, { x: -148, y: 45 }, { x: -170, y: -145 },
];
const star = Array.from({ length: 10 }, (_, index) => {
  const theta = -Math.PI / 2 + index * Math.PI / 5;
  const radius = index % 2 ? 110 : 216;
  return { x: Math.cos(theta) * radius, y: Math.sin(theta) * radius };
});

function circularDistance(a, b) {
  const difference = Math.abs(a - b) % 1;
  return Math.min(difference, 1 - difference);
}

const shapes = {
  heart: polygon(heart, { inner: 9, outer: 9, width: 13,
    colors: (angle) => angle < .5 ? [CORAL, PEACH] : [PEACH, WHITE] }),
  cube: ({ angle, count = 36 }) => {
    const radius = polygonRadius(hexagon, angle);
    const seam = [0, 1 / 3, 2 / 3].some((point) => circularDistance(angle, point) <= .51 / count);
    const face = Math.floor(((angle + 1 / 6) % 1) * 3);
    const colors = [[WHITE, PEACH], [PEACH, CORAL], [CORAL, WHITE]][face];
    return {
      radius,
      inner: seam ? radius - 89 : 9,
      outer: 9,
      width: seam ? 9 : 13,
      innerColor: colors[0],
      outerColor: colors[1],
      activity: 1,
    };
  },
  play: ({ angle }) => {
    const edge = polygonRadius(play, angle);
    if (edge === null) return { width: 0, inner: 0, outer: 0, activity: 0 };
    const start = 82;
    const radius = (start + edge) / 2;
    return {
      radius,
      inner: radius - start,
      outer: edge - radius,
      width: 16,
      innerColor: angle < .5 ? PEACH : CORAL,
      outerColor: WHITE,
      activity: 1,
    };
  },
  pause: ({ angle }) => {
    const direction = ray(angle);
    const left = rayRectangle(direction, { xMin: -135, xMax: -86, yMin: -119, yMax: 119 });
    const right = rayRectangle(direction, { xMin: 86, xMax: 135, yMin: -119, yMax: 119 });
    const hit = left ?? right;
    if (!hit) return { width: 0, inner: 0, outer: 0, activity: 0 };
    const radius = (hit.enter + hit.exit) / 2;
    const color = left ? CORAL : WHITE;
    return {
      radius,
      inner: radius - hit.enter,
      outer: hit.exit - radius,
      width: 17,
      innerColor: color,
      outerColor: color,
      activity: 1,
    };
  },
  star: polygon(star, { width: 11, colors: (angle) => angle < .5 ? [CORAL, PEACH] : [PEACH, WHITE] }),
  triangle: polygon(triangle, { inner: 10, outer: 10, width: 12 }),
  square: polygon(square, { width: 13, colors: (angle) => angle < .5 ? [CORAL, PEACH] : [PEACH, WHITE] }),
  diamond: polygon(diamond, { width: 12 }),
  hexagon: polygon(hexagon, { width: 13, colors: (angle) => angle < .5 ? [CORAL, WHITE] : [WHITE, CORAL] }),
  pentagon: polygon(pentagon, { width: 12 }),
  octagon: polygon(octagon, { width: 12, colors: (angle) => angle < .5 ? [CORAL, WHITE] : [PEACH, CORAL] }),
  shield: polygon(shield, { width: 13, colors: (angle) => angle < .5 ? [CORAL, PEACH] : [PEACH, WHITE] }),
  drop: polygon(drop, { width: 12, colors: (angle) => angle < .5 ? [PEACH, WHITE] : [CORAL, PEACH] }),
  moon: ({ angle }) => {
    const direction = ray(angle);
    const center = { x: 66, y: -26 };
    const projection = center.x * direction.x + center.y * direction.y;
    const innerExit = projection + Math.sqrt(projection ** 2 + 164 ** 2 - center.x ** 2 - center.y ** 2);
    const outerExit = 208;
    if (innerExit >= outerExit - 3) return { width: 0, inner: 0, outer: 0, activity: 0 };
    const radius = (innerExit + outerExit) / 2;
    return {
      radius,
      inner: radius - innerExit,
      outer: outerExit - radius,
      width: 14,
      innerColor: CORAL,
      outerColor: WHITE,
      activity: 1,
    };
  },
  sun: ({ angle }) => ({
    radius: 157 + 53 * Math.max(0, Math.cos(angle * TAU * 12)) ** 4,
    inner: 10, outer: 10, width: 12,
    innerColor: CORAL, outerColor: PEACH, activity: 1,
  }),
  gear: ({ angle }) => ({
    radius: 185 + 24 * Math.tanh(4 * Math.cos(angle * TAU * 8)),
    inner: 10, outer: 10, width: 12,
    innerColor: PEACH, outerColor: WHITE, activity: 1,
  }),
  spiral: ({ angle }) => ({
    radius: 98 + 116 * angle,
    inner: 8, outer: 8, width: 12,
    innerColor: CORAL, outerColor: WHITE, activity: 1,
  }),
  flower: ({ angle }) => ({
    radius: 163 + 43 * Math.cos(angle * TAU * 6),
    inner: 12,
    outer: 12,
    width: 13,
    innerColor: CORAL,
    outerColor: PEACH,
    activity: 1,
  }),
};

export function shapeFor(id) { return shapes[id] ?? null; }
