// Макет чужого экрана — данными. Экран — дерево узлов маленького словаря: шапка,
// группа строк, строка, поле, кнопка, сегменты, боковое меню, вкладки, плитки,
// лист поверх, всплывающий список, терминал, видоискатель, видео. Узлы со своим id
// ролик нажимает, включает, показывает, вписывает в них текст. Как узел выглядит в
// каком облике (iOS, Mac, Windows, веб-страница, телевизор, терминал) — решает CSS
// блока scene-ui модификатором облика, а не код. Это не копии чужих интерфейсов:
// узнаваемая структура — список настроек, поле, переключатель — без логотипов.
//
// Состояние узла: on (включён, выбран), off (слой поверх спрятан), gone (строки нет
// в потоке), value (текст значения), typing (каретка), lines (история терминала),
// progress (доля: полоса видео, линия сканера).
import { h, svgIcon } from '../../utils/dom.js';

const B = 'scene-ui';
const SVG_NS = 'http://www.w3.org/2000/svg';

const kids = (list) => list.filter(Boolean);
const ided = (items) => (typeof items[0] === 'string' ? { id: items[0], kids: kids(items.slice(1)) } : { kids: kids(items) });

/** Конструкторы узлов. Всё — простые объекты: экран можно описать и без них. */
export const ui = {
  /** Шапка: back — «‹ куда», large — крупный заголовок ниже, act — [id, текст] справа. */
  bar: (title, o = {}) => ({ k: 'bar', title, ...o }),
  head: (text, id, o = {}) => ({ k: 'head', text, id, ...o }),
  /** Группа строк; первым может идти id — тогда её можно спрятать целиком. */
  group: (...items) => ({ k: 'group', ...ided(items) }),
  /** Группа, где выбран один (галочка): «Автоматически / Вручную». */
  choose: (...items) => ({ k: 'group', pick: true, ...ided(items) }),
  /**
   * Строка: value справа, icon слева в подложке, tick — галочка слева (сеть, к
   * которой подключён), end — chevron | info | check | switch | plus | select,
   * lead — minus, del — скрытая «Удалить», btn — [id, текст] кнопка справа,
   * hl — строку выделяют нажатием (список адресов в окне Mac).
   */
  row: (id, text, o = {}) => ({ k: 'row', id, text, ...o }),
  field: (id, text, o = {}) => ({ k: 'field', id, text, ...o }),
  button: (id, text, o = {}) => ({ k: 'button', id, text, ...o }),
  seg: (items, picked) => ({ k: 'seg', pick: true, kids: items.map(([id, text]) => ({ k: 'opt', id, text, on: id === picked })) }),
  /** Боковое меню: [id, текст, значок, { sub, gone }] — sub — подпункт раздела. */
  side: (items, picked) => ({ k: 'side', pick: true, kids: items.map(([id, text, icon, o]) => ({ k: 'item', id, text, icon, on: id === picked, ...o })) }),
  tabs: (items, picked) => ({ k: 'tabs', pick: true, kids: items.map(([id, text, icon]) => ({ k: 'tab', id, text, icon, on: id === picked })) }),
  tiles: (items) => ({ k: 'tiles', kids: items.map(([id, text, icon, o]) => ({ k: 'tile', id, text, icon, ...o })) }),
  chips: (items) => ({ k: 'chips', kids: items.map(([id, text, on]) => ({ k: 'chip', id, text, on })) }),
  split: (side, ...main) => ({ k: 'split', kids: [side, { k: 'pane', kids: kids(main) }] }),
  /** Главный раздел окна: боковое меню на подложке во всю высоту. */
  frame: (side, ...main) => ({ ...ui.split(side, ...main), flush: true }),
  stack: (...items) => ({ k: 'stack', kids: kids(items) }),
  line: (...items) => ({ k: 'cluster', kids: kids(items) }),
  card: (id, ...items) => ({ k: 'card', id, kids: kids(items) }),
  text: (text, o = {}) => ({ k: 'text', text, ...o }),
  badge: (id, text, tone, o = {}) => ({ k: 'badge', id, text, tone, ...o }),
  /** Список с выпадающим меню: options — [[id, текст]], меню — `${id}.pop`. */
  select: (id, text, value, options) => ({ k: 'select', id, text, value,
    kids: [{ k: 'pop', id: `${id}.pop`, off: true, kids: options.map(([oid, t]) => ({ k: 'choice', id: oid, text: t })) }] }),
  /** Лист поверх экрана (диалог, окно «Подробнее») — спрятан, пока его не покажут. */
  sheet: (id, ...items) => ({ k: 'sheet', id, off: true, over: true, kids: kids(items) }),
  toast: (id, text) => ({ k: 'toast', id, text, off: true, over: true }),
  /** Терминал: lines — [['cmd'|'out', текст]], prompt — приглашение строки ввода. */
  term: (id, prompt, lines = []) => ({ k: 'term', id, prompt, lines }),
  qr: (id) => ({ k: 'qr', id }),
  cam: (id) => ({ k: 'cam', id }),
  video: (id, text) => ({ k: 'video', id, text }),
  route: (id, stops, o = {}) => ({ k: 'route', id, stops, ...o }),
  space: () => ({ k: 'space' }),
  /** Нижняя полоса вкладок приложения на телефоне — поверх, не прокручивается. */
  dock: (items, picked) => ({ k: 'dock', over: true, kids: [ui.tabs(items, picked)] }),
};

// ——— Указатель узлов экрана: подписи для субтитров, соседи для выбора, начальное состояние.

const INIT = (n) => ({ on: Boolean(n.on), off: Boolean(n.off), gone: Boolean(n.gone), value: n.value ?? '', lines: n.lines ?? null, progress: 0, typing: false });

/** id → { node, parent, label, init } — по определению экрана, без DOM. */
export function indexScreen(def) {
  const map = new Map();
  const put = (id, node, parent, label, init = INIT(node)) => map.set(id, { node, parent, label, init });
  const visit = (n, parent) => {
    if (!n || typeof n !== 'object') return;
    if (n.id) put(n.id, n, parent, n.text ?? n.title ?? '');
    if (n.k === 'bar') {
      if (n.back) put('back', n, parent, `‹ ${n.back}`, INIT({}));
      if (n.act) put(n.act[0], n, parent, n.act[1], INIT({}));
    }
    if (n.k === 'row') {
      if (n.end === 'info') put(`${n.id}.info`, n, n, `ⓘ у «${n.text}»`, INIT({}));
      if (n.lead === 'minus') put(`${n.id}.minus`, n, n, `«−» у ${n.text}`, INIT({ off: true }));
      if (n.del) put(`${n.id}.del`, n, n, 'Удалить', INIT({ off: true }));
      if (n.btn) put(n.btn[0], n, n, n.btn[1], INIT({}));
    }
    (n.kids ?? []).forEach((k) => visit(k, n));
  };
  if (def.chrome?.kind === 'browser') put('url', def.chrome, def, 'адресная строка', INIT({ value: def.chrome.url }));
  def.body.forEach((n) => visit(n, def));
  return map;
}

/** Соседи по выбору одного: сегменты, боковое меню, вкладки, группа с галочкой. */
export function siblings(index, id) {
  const parent = index.get(id)?.parent;
  if (!parent?.pick) return [];
  return parent.kids.filter((k) => k.id && k.id !== id).map((k) => k.id);
}

// ——— Отрисовка.

function qrSvg() {
  // Узор «как QR» — детерминированный: три метки по углам и шум между ними.
  const n = 25;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const finder = (x, y) => `M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}v5h5v-5zM${x + 2} ${y + 2}h3v3h-3z`;
  let d = finder(0, 0) + finder(n - 7, 0) + finder(0, n - 7);
  const inFinder = (x, y) => (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (!inFinder(x, y) && rnd() < 0.46) d += `M${x} ${y}h1v1h-1z`;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `-2 -2 ${n + 4} ${n + 4}`);
  svg.setAttribute('class', `${B}__qr-code`);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}

const icon = (name, cls) => svgIcon(name, `${B}__${cls}`);

function rowEnd(n, reg) {
  switch (n.end) {
    case 'chevron': return icon('chevron-right', 'chevron');
    case 'select': return icon('chevron-down', 'chevron');
    case 'check': return icon('check', 'check');
    case 'plus': return icon('plus', 'plus');
    case 'switch': return h('span', { class: `${B}__switch`, 'aria-hidden': 'true' });
    case 'info': return reg(`${n.id}.info`, h('span', { class: `${B}__info` }, svgIcon('info')), 'info');
    default: return null;
  }
}

// Каждый вид: (узел, reg, рисовать детей) → элемент. reg(id, el, kind, части) — узел с id.
const KINDS = {
  bar: (n, reg) => [
    h('div', { class: `${B}__bar` },
      n.back ? reg('back', h('span', { class: `${B}__back` }, svgIcon('chevron-left'), h('span', { class: `${B}__back-text`, text: n.back })), 'back') : h('span', { class: `${B}__back` }),
      h('span', { class: `${B}__heading`, text: n.large ? '' : n.title }),
      n.act ? reg(n.act[0], h('span', { class: `${B}__act`, text: n.act[1] }), 'act') : h('span', { class: `${B}__act` })),
    n.large ? h('div', { class: `${B}__title`, text: n.title }) : null,
  ],
  head: (n) => h('p', { class: `${B}__head`, text: n.text }),
  group: (n, reg, draw) => h('div', { class: `${B}__group` }, draw(n.kids)),
  dock: (n, reg, draw) => h('div', { class: `${B}__dock` }, draw(n.kids)),
  row: (n, reg) => {
    const value = h('span', { class: `${B}__value`, text: n.value ?? '' });
    const el = h('div', { class: `${B}__row${n.tone ? ` ${B}__row_tone_${n.tone}` : ''}${n.hl ? ` ${B}__row_hl` : ''}` },
      n.lead === 'minus' ? reg(`${n.id}.minus`, h('span', { class: `${B}__minus` }, svgIcon('minus')), 'minus') : null,
      n.tick ? icon('check', 'tick') : null,
      n.icon ? h('span', { class: `${B}__icon` }, svgIcon(n.icon)) : null,
      h('span', { class: `${B}__label`, text: n.text }),
      value,
      n.btn ? reg(n.btn[0], h('span', { class: `${B}__button ${B}__button_tone_plain ${B}__button_size_s`, text: n.btn[1] }), 'button') : null,
      rowEnd(n, reg),
      n.del ? reg(`${n.id}.del`, h('span', { class: `${B}__del`, text: 'Удалить' }), 'del') : null);
    return n.id ? reg(n.id, el, 'row', { value }) : el;
  },
  field: (n, reg) => {
    const value = h('span', { class: `${B}__value`, text: n.value ?? '' });
    const box = h('span', { class: `${B}__box${n.multi ? ` ${B}__box_multi` : ''}` }, value, h('span', { class: `${B}__caret` }), h('span', { class: `${B}__hint`, text: n.hint ?? '' }));
    const cls = `${B}__field${n.stacked ? ` ${B}__field_stacked` : ''}${n.text ? '' : ` ${B}__field_bare`}`;
    return reg(n.id, h('div', { class: cls }, n.text ? h('span', { class: `${B}__label`, text: n.text }) : null, box), 'field', { value });
  },
  button: (n, reg) => reg(n.id, h('span', { class: `${B}__button ${B}__button_tone_${n.tone ?? 'plain'}` }, n.icon ? svgIcon(n.icon) : null, n.text ? h('span', { text: n.text }) : null), 'button'),
  seg: (n, reg, draw) => h('div', { class: `${B}__seg` }, draw(n.kids)),
  opt: (n, reg) => reg(n.id, h('span', { class: `${B}__opt`, text: n.text }), 'opt'),
  side: (n, reg, draw) => h('div', { class: `${B}__side` }, draw(n.kids)),
  item: (n, reg) => reg(n.id, h('span', { class: `${B}__item${n.sub ? ` ${B}__item_sub` : ''}` }, n.icon ? svgIcon(n.icon) : null, h('span', { text: n.text })), 'item'),
  tabs: (n, reg, draw) => h('div', { class: `${B}__tabs` }, draw(n.kids)),
  tab: (n, reg) => reg(n.id, h('span', { class: `${B}__tab` }, n.icon ? svgIcon(n.icon) : null, h('span', { text: n.text })), 'tab'),
  tiles: (n, reg, draw) => h('div', { class: `${B}__tiles` }, draw(n.kids)),
  tile: (n, reg) => reg(n.id, h('span', { class: `${B}__tile${n.wide ? ` ${B}__tile_wide` : ''}` }, h('span', { class: `${B}__tile-art` }, svgIcon(n.icon)), h('span', { class: `${B}__tile-text`, text: n.text })), 'tile'),
  chips: (n, reg, draw) => h('div', { class: `${B}__chips` }, draw(n.kids)),
  chip: (n, reg) => reg(n.id, h('span', { class: `${B}__chip` }, icon('check', 'chip-check'), n.text), 'chip'),
  split: (n, reg, draw) => h('div', { class: `${B}__split${n.flush ? ` ${B}__split_flush` : ''}` }, draw(n.kids)),
  pane: (n, reg, draw) => h('div', { class: `${B}__pane` }, draw(n.kids)),
  stack: (n, reg, draw) => h('div', { class: `${B}__stack` }, draw(n.kids)),
  cluster: (n, reg, draw) => h('div', { class: `${B}__cluster` }, draw(n.kids)),
  card: (n, reg, draw) => h('div', { class: `${B}__card` }, draw(n.kids)),
  text: (n, reg) => {
    const el = h('p', { class: `${B}__text${n.tone ? ` ${B}__text_tone_${n.tone}` : ''}${n.size ? ` ${B}__text_size_${n.size}` : ''}`, text: n.text });
    return n.id ? reg(n.id, el, 'text', { value: el }) : el;
  },
  badge: (n, reg) => reg(n.id, h('span', { class: `${B}__badge ${B}__badge_tone_${n.tone ?? 'muted'}` }, h('span', { class: `${B}__dot` }), n.text), 'badge'),
  select: (n, reg, draw) => {
    const value = h('span', { class: `${B}__value`, text: n.value });
    return reg(n.id, h('div', { class: `${B}__select` }, h('span', { class: `${B}__label`, text: n.text }), h('span', { class: `${B}__picker` }, value, svgIcon('chevron-down')), draw(n.kids)), 'select', { value });
  },
  pop: (n, reg, draw) => reg(n.id, h('div', { class: `${B}__pop` }, draw(n.kids)), 'pop'),
  choice: (n, reg) => reg(n.id, h('span', { class: `${B}__choice`, text: n.text }), 'choice'),
  sheet: (n, reg, draw) => reg(n.id, h('div', { class: `${B}__sheet` }, h('div', { class: `${B}__dialog` }, draw(n.kids))), 'sheet'),
  toast: (n, reg) => reg(n.id, h('div', { class: `${B}__toast` }, icon('check', 'toast-icon'), n.text), 'toast'),
  term: (n, reg) => {
    const value = h('span', { class: `${B}__value` });
    const lines = h('div', { class: `${B}__lines` });
    return reg(n.id, h('div', { class: `${B}__term` }, lines, h('div', { class: `${B}__line ${B}__line_input` }, h('span', { class: `${B}__prompt`, text: n.prompt }), value, h('span', { class: `${B}__caret` }))), 'term', { value, lines });
  },
  qr: (n, reg) => reg(n.id, h('div', { class: `${B}__qr` }, qrSvg()), 'qr'),
  cam: (n, reg) => {
    const line = h('span', { class: `${B}__scanline` });
    return reg(n.id, h('div', { class: `${B}__cam` }, h('span', { class: `${B}__frame` }, h('span', { class: `${B}__qr` }, qrSvg()), line)), 'cam', { line });
  },
  video: (n, reg) => {
    const bar = h('span', { class: `${B}__progress-bar` });
    return reg(n.id, h('div', { class: `${B}__video` }, h('span', { class: `${B}__play` }, svgIcon('play')), h('span', { class: `${B}__video-text`, text: n.text ?? '' }), h('span', { class: `${B}__progress` }, bar)), 'video', { bar });
  },
  route: (n, reg) => reg(n.id, h('div', { class: `${B}__route` }, n.stops.map(([place, note], i) => h('div', { class: `${B}__stop${i === n.stops.length - 1 ? ` ${B}__stop_end` : ''}` },
    h('span', { class: `${B}__stop-dot` }), h('span', { class: `${B}__stop-place`, text: place }), h('span', { class: `${B}__stop-note`, text: note })))), 'route'),
  space: () => h('div', { class: `${B}__space` }),
};

function chrome(c, reg) {
  if (!c) return null;
  const dots = h('span', { class: `${B}__dots` }, ['danger', 'warn', 'ok'].map((tone) => h('span', { class: `${B}__light ${B}__light_tone_${tone}` })));
  if (c.kind === 'win') {
    return h('div', { class: `${B}__chrome ${B}__chrome_kind_win` }, h('span', { class: `${B}__chrome-title`, text: c.title }),
      h('span', { class: `${B}__win-buttons` }, svgIcon('minus'), h('span', { class: `${B}__win-square` }), svgIcon('close')));
  }
  if (c.kind === 'browser') {
    const value = h('span', { class: `${B}__value`, text: c.url });
    const url = reg('url', h('span', { class: `${B}__url` }, svgIcon('lock'), value, h('span', { class: `${B}__caret` })), 'url', { value });
    return h('div', { class: `${B}__chrome ${B}__chrome_kind_browser` }, dots, h('span', { class: `${B}__nav` }, svgIcon('chevron-left'), svgIcon('chevron-right')), url);
  }
  return h('div', { class: `${B}__chrome ${B}__chrome_kind_${c.kind}` }, dots, h('span', { class: `${B}__chrome-title`, text: c.title ?? '' }));
}

/** Узел на экране: состояние пишется только переменой. */
function nodeView(el, kind, init, parts = {}) {
  const base = `${B}__${kind}`;
  const now = {};
  return {
    el,
    init,
    /** Записать состояние; true — сдвинулась раскладка (строка ушла или пришла, история выросла). */
    apply(st) {
      let moved = false;
      if (st.on !== now.on) el.classList.toggle(`${base}_on`, st.on);
      if (st.off !== now.off) el.classList.toggle(`${base}_off`, st.off);
      if (st.typing !== now.typing) el.classList.toggle(`${base}_typing`, st.typing);
      if (st.gone !== now.gone) {
        el.hidden = st.gone;
        moved = now.gone !== undefined;
      }
      if (parts.value && st.value !== now.value) parts.value.textContent = st.value;
      const lines = st.lines ? st.lines.map((l) => l.join('\u0001')).join('\n') : '';
      if (parts.lines && lines !== now.lines) {
        parts.lines.replaceChildren(...(st.lines ?? []).map(([how, text]) => h('div', { class: `${B}__line ${B}__line_${how}`, text })));
        moved = true;
        now.lines = lines;
      }
      if (st.progress !== now.progress) {
        if (parts.bar) parts.bar.style.transform = `scaleX(${st.progress})`;
        if (parts.line) parts.line.style.transform = `translateY(${(st.progress * 100).toFixed(2)}cqh)`;
      }
      Object.assign(now, { on: st.on, off: st.off, typing: st.typing, gone: st.gone, value: st.value, progress: st.progress });
      return moved;
    },
  };
}

/** Собрать экран: { el, view, content, nodes: id → вид узла }. */
export function buildScreen(def, index) {
  const nodes = new Map();
  const reg = (id, el, kind, parts) => {
    nodes.set(id, nodeView(el, kind, index.get(id)?.init ?? INIT({}), parts));
    return el;
  };
  const over = [];
  const draw = (list) => (list ?? []).flatMap((n) => {
    if (!n) return [];
    const el = KINDS[n.k](n, reg, draw);
    // Узел с id, который вид сам не отметил (группа, стопка, чипы), — отметить корнем.
    if (n.id && !nodes.has(n.id)) reg(n.id, [el].flat()[0], n.k);
    if (n.over) {
      over.push(el);
      return [];
    }
    return [el].flat().filter(Boolean);
  });
  const content = h('div', { class: `${B}__content` }, draw(def.body));
  const view = h('div', { class: `${B}__view` }, content, over);
  const el = h('div', { class: `${B} ${B}_look_${def.look}` }, chrome(def.chrome, reg), view);
  for (const node of nodes.values()) node.apply(node.init);
  return { el, view, content, nodes };
}
