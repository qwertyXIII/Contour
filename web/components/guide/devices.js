// Корпуса устройств сцены и их «железо»: экран со слоями, строка состояния
// телефона, указатель (палец или курсор), круг касания, отметка, рамка фокуса,
// экранная клавиатура, пульт телевизора. Здесь только разметка; что и как
// движется на кадре — stage.js.
import { h, svgIcon } from '../../utils/dom.js';

/** Устройства: размер, место экрана внутри [x, y, w, h], удобный масштаб, где ждёт указатель. */
export const DEVICES = {
  phone: { w: 260, h: 532, screen: [8, 8, 244, 516], comfort: 0.7, rest: '@0.72,0.8' },
  laptop: { w: 680, h: 424, screen: [40, 12, 600, 376], comfort: 0.78, rest: '@0.55,0.62' },
  tv: { w: 652, h: 404, screen: [6, 6, 640, 360], comfort: 0.5, rest: '@0.5,0.5' },
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const PADS = {
  num: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['.', '0', '⌫']],
  abc: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', ['123', ' ', '.', '/']].map((r) => (Array.isArray(r) ? r : [...r])),
};
const CROSS = ['up', 'left', 'ok', 'right', 'down'];
const REMOTE_ICONS = { back: 'undo', home: 'home', menu: 'settings', up: 'chevron-up', down: 'chevron-down', left: 'chevron-left', right: 'chevron-right' };

// Стрелка курсора — своя форма: в спрайте её нет, а «навигация» читается как компас.
function cursorShape() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 24');
  svg.setAttribute('class', 'scene__cursor-shape');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M1.5 1.5v17.2l4.3-4.1 2.9 6.7 3-1.3-2.9-6.6h6z');
  svg.append(path);
  return svg;
}

/** Экранная клавиатура: { el, keys: символ → клавиша, preview }. */
export function padEl(kind, device) {
  const keys = new Map();
  // На телевизоре вписанное видно над клавиатурой — так у телевизоров и принято.
  const preview = device === 'tv' ? h('span', { class: 'scene__pad-preview' }) : null;
  const rows = PADS[kind].map((row) => h('div', { class: 'scene__pad-row' }, row.map((k) => {
    const key = h('span', { class: `scene__key${k === ' ' ? ' scene__key_wide' : ''}`, text: k === ' ' ? 'пробел' : k });
    keys.set(k, key);
    return key;
  })));
  return { el: h('div', { class: `scene__pad scene__pad_kind_${kind} scene__pad_device_${device}` }, preview, rows), keys, preview };
}

/** Корпус с экраном: { kind, el, g, layers, screen, status, pointer, ripple, mark, ring, pads }. */
export function buildDevice(kind) {
  const g = DEVICES[kind];
  const layers = h('div', { class: 'scene__layers' });
  const pointer = kind === 'tv' ? null : h('div', { class: `scene__pointer scene__pointer_kind_${kind === 'phone' ? 'finger' : 'cursor'}` }, kind === 'laptop' ? cursorShape() : null);
  const ripple = h('div', { class: 'scene__ripple' });
  const mark = h('div', { class: 'scene__mark' });
  const ring = kind === 'tv' ? h('div', { class: 'scene__ring' }) : null;
  const status = kind === 'phone' ? h('div', { class: 'scene__status' }, h('span', { text: '9:41' }), h('span', { class: 'scene__island' }),
    h('span', { class: 'scene__status-icons' }, svgIcon('signal'), svgIcon('wifi'), svgIcon('battery'))) : null;
  // Телевизор тёмный в любой теме — как настоящее меню на экране.
  const screen = h('div', { class: `scene__screen${kind === 'tv' ? ' theme theme_scheme_dark' : ''}` }, layers, status, mark, ring, ripple, pointer);
  const [x, y, w, hh] = g.screen;
  const el = h('div', {
    class: `scene__device scene__device_kind_${kind}`,
    style: { '--device-w': `${g.w}px`, '--device-h': `${g.h}px`, '--screen-x': `${x}px`, '--screen-y': `${y}px`, '--screen-w': `${w}px`, '--screen-h': `${hh}px` },
  }, h('div', { class: 'scene__body' }), screen);
  return { kind, el, g, layers, screen, status, pointer, ripple, mark, ring, pads: {}, now: {} };
}

/** Пульт телевизора: { el, keys: имя → кнопка }. */
export function buildRemote() {
  const keys = new Map(['back', 'home', 'menu', ...CROSS].map((k) => [k,
    h('span', { class: `scene__remote-key scene__remote-key_${k}` }, k === 'ok' ? 'OK' : svgIcon(REMOTE_ICONS[k]))]));
  const el = h('div', { class: 'scene__remote' },
    h('div', { class: 'scene__remote-pad' }, CROSS.map((k) => keys.get(k))),
    h('div', { class: 'scene__remote-row' }, keys.get('back'), keys.get('home'), keys.get('menu')));
  return { el, keys };
}
