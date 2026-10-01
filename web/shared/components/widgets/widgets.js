// Сетка виджетов. У каждого виджета свои координаты в квадратных клетках,
// колонок — сколько задал CSS по ширине (4 → 6 → 8). Раскладка хранится для
// каждого числа колонок отдельно; для ширины, где её ещё нет, выводится из
// известной по порядку чтения и становится своей после первой правки.
//
// Долгое нажатие на виджет включает правку и берёт его; в правке виджеты
// покачиваются и тянутся сразу, соседи плавно уступают место (layout.place),
// переезды — FLIP. С клавиатуры — «Изменить», затем пробел и стрелки.
//
// Хранить раскладку — дело хозяина: блок сообщает widgets:change и принимает
// widgets:load. Виджет знает о себе только id (data-widget), размер
// (widgets__item_size_*) и подпись (data-title).
import { EVENTS, WIDGETS } from '../../utils/constants.js';
import { emit, h } from '../../utils/dom.js';
import { measure, play } from './flip.js';
import { PointerDrag } from './drag.js';
import { KeyMover } from './keys.js';
import { adapt, normalize, pack, place, rowsOf, same, sizeOf } from './layout.js';

const ITEM = '.widgets__item';

export class Widgets {
  #root;
  #grid;
  #toggle;
  #status;
  #slot;
  #items = new Map();
  #layouts = new Map();
  #layout = [];
  #cols = 0;
  #editing = false;
  #drag = null;
  #pointer;
  #keys;

  constructor(root) {
    this.#root = root;
    this.#grid = root.querySelector('.widgets__grid');
    this.#toggle = root.querySelector('.widgets__toggle');
  }

  init() {
    if (!this.#grid) return this;
    this.#collect();
    this.#slot = h('div', { class: 'widgets__slot', hidden: true, 'aria-hidden': 'true' });
    this.#status = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
    this.#grid.append(this.#slot);
    this.#root.append(this.#status);
    this.#cols = this.#readCols();
    this.#show(pack(this.#sizes(), this.#cols), { animate: false });
    this.#root.classList.add(WIDGETS.placed);
    this.#bind();
    return this;
  }

  #collect() {
    this.#grid.querySelectorAll(ITEM).forEach((element, index) => {
      const id = element.dataset.widget ?? `widget-${index + 1}`;
      element.dataset.widget = id;
      // Качаются вразнобой: у каждого свой сдвиг по фазе.
      element.style.setProperty('--jiggle-delay', `-${(index * 97) % 300}ms`);
      this.#items.set(id, element);
    });
  }

  #sizes() {
    return [...this.#items].map(([id, element]) => ({ id, ...sizeOf(element) }));
  }

  #readCols() {
    return Number(getComputedStyle(this.#grid).getPropertyValue('--widgets-cols')) || 4;
  }

  #bind() {
    this.#pointer = new PointerDrag(this.#grid, {
      item: ITEM,
      editing: () => this.#editing,
      onPress: () => this.#setEditing(true),
      onStart: (item, point) => this.#lift(item, point),
      onMove: (point) => this.#follow(point),
      onEnd: () => this.#land(),
      onCancel: () => this.#land({ cancel: true }),
    }).bind();
    this.#keys = new KeyMover(this.#grid, {
      item: ITEM,
      editing: () => this.#editing,
      onPick: (item) => this.#pick(item),
      onStep: (dx, dy) => this.#step(dx, dy),
      onDrop: () => this.#settle(),
      onCancel: () => this.#settle({ cancel: true }),
    }).bind();
    this.#toggle?.addEventListener('click', () => this.#setEditing(!this.#editing));
    // В правке щелчок по пустому месту сетки — «готово», как на телефоне.
    this.#grid.addEventListener('click', (event) => {
      if (this.#editing && event.target === this.#grid) this.#setEditing(false);
    });
    this.#root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.#editing && !this.#drag) this.#setEditing(false);
    });
    this.#root.addEventListener(EVENTS.widgetsLoad, (event) => this.#load(event.detail?.layouts ?? {}));
    this.#root.addEventListener(EVENTS.widgetsReset, () => this.#reset());
    new ResizeObserver(() => this.#onResize()).observe(this.#root);
  }

  // ── показ ─────────────────────────────────────────────

  /** Расставить по раскладке; hold — виджет, который тянут: он остаётся на исходной клетке. */
  #show(layout, { animate = true, hold = null, rows = null } = {}) {
    const moving = [...this.#items.values(), this.#slot].filter((element) => element !== hold);
    const before = animate ? measure(moving) : null;
    layout.forEach((item) => {
      const element = this.#items.get(item.id);
      if (element === hold) return;
      element.style.setProperty('--col', item.x + 1);
      element.style.setProperty('--row', item.y + 1);
    });
    const extra = this.#editing ? 1 : 0;
    this.#grid.style.setProperty('--widgets-rows', Math.max(1, (rows ?? rowsOf(layout)) + extra));
    this.#layout = layout;
    if (before) play(before);
  }

  #placeSlot(item) {
    this.#slot.hidden = !item;
    if (!item) return;
    this.#slot.style.setProperty('--col', item.x + 1);
    this.#slot.style.setProperty('--row', item.y + 1);
    this.#slot.style.setProperty('--w', item.w);
    this.#slot.style.setProperty('--h', item.h);
  }

  #say(text) {
    this.#status.textContent = text;
  }

  #title(id) {
    const element = this.#items.get(id);
    return element?.dataset.title ?? element?.getAttribute('aria-label') ?? id;
  }

  // ── правка ────────────────────────────────────────────

  #setEditing(on) {
    if (this.#editing === on) return;
    if (!on) this.#keys.drop();
    this.#editing = on;
    this.#root.classList.toggle(WIDGETS.editing, on);
    this.#items.forEach((element) => {
      // Содержимое в правке не нажимается и не берёт фокус — фокус у самой клетки.
      [...element.children].forEach((child) => { child.inert = on; });
      if (on) {
        element.tabIndex = 0;
        element.setAttribute('aria-roledescription', 'виджет');
        element.setAttribute('aria-label', element.dataset.title ?? element.dataset.widget);
      } else {
        element.removeAttribute('tabindex');
        element.removeAttribute('aria-roledescription');
        element.removeAttribute('aria-label');
      }
    });
    if (this.#toggle) {
      this.#toggle.setAttribute('aria-pressed', String(on));
      this.#toggle.textContent = on ? WIDGETS.labels.done : WIDGETS.labels.edit;
    }
    this.#show(this.#layout, { animate: false });
    this.#say(on ? WIDGETS.say.editOn : WIDGETS.say.editOff);
    emit(this.#root, EVENTS.widgetsEdit, { editing: on });
  }

  // ── палец и мышь ──────────────────────────────────────

  #metrics() {
    const rect = this.#grid.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(this.#grid).columnGap) || 0;
    const cell = (rect.width - gap * (this.#cols - 1)) / this.#cols;
    return { rect, pitch: cell + gap };
  }

  #lift(element, point) {
    const id = element.dataset.widget;
    const item = this.#layout.find((entry) => entry.id === id);
    const box = element.getBoundingClientRect();
    const { pitch } = this.#metrics();
    this.#drag = {
      id,
      element,
      start: this.#layout,
      target: { x: item.x, y: item.y },
      grab: { x: point.x - box.left, y: point.y - box.top },
      home: { x: item.x * pitch, y: item.y * pitch },
    };
    element.classList.add(WIDGETS.lifted);
    this.#placeSlot(item);
    this.#say(WIDGETS.say.picked(this.#title(id), item.x, item.y));
  }

  #follow(point) {
    const drag = this.#drag;
    if (!drag) return;
    const { rect, pitch } = this.#metrics();
    const x = point.x - drag.grab.x - rect.left;
    const y = point.y - drag.grab.y - rect.top;
    drag.element.style.setProperty('--drag-x', `${x - drag.home.x}px`);
    drag.element.style.setProperty('--drag-y', `${y - drag.home.y}px`);
    const target = { x: Math.round(x / pitch), y: Math.max(0, Math.round(y / pitch)) };
    if (target.x === drag.target.x && target.y === drag.target.y) return;
    const layout = place(drag.start, drag.id, target, this.#cols);
    const dropped = layout.find((entry) => entry.id === drag.id);
    drag.target = { x: dropped.x, y: dropped.y };
    this.#show(layout, { hold: drag.element });
    this.#placeSlot(dropped);
  }

  #land({ cancel = false } = {}) {
    const drag = this.#drag;
    if (!drag) return;
    this.#drag = null;
    const layout = cancel ? drag.start : this.#layout;
    const before = measure([drag.element]);
    drag.element.classList.remove(WIDGETS.lifted);
    drag.element.style.removeProperty('--drag-x');
    drag.element.style.removeProperty('--drag-y');
    this.#placeSlot(null);
    this.#show(layout, { animate: cancel });
    play(before);
    this.#commit(drag.start, layout, drag.id);
  }

  // ── клавиатура ────────────────────────────────────────

  #pick(element) {
    const id = element.dataset.widget;
    const item = this.#layout.find((entry) => entry.id === id);
    this.#drag = { id, element, start: this.#layout, target: { x: item.x, y: item.y }, keyboard: true };
    element.classList.add(WIDGETS.picked);
    this.#say(WIDGETS.say.picked(this.#title(id), item.x, item.y));
  }

  #step(dx, dy) {
    const drag = this.#drag;
    if (!drag?.keyboard) return;
    const layout = place(drag.start, drag.id, { x: drag.target.x + dx, y: drag.target.y + dy }, this.#cols);
    const dropped = layout.find((entry) => entry.id === drag.id);
    drag.target = { x: dropped.x, y: dropped.y };
    this.#show(layout);
    this.#say(WIDGETS.say.moved(this.#title(drag.id), dropped.x, dropped.y));
  }

  #settle({ cancel = false } = {}) {
    const drag = this.#drag;
    if (!drag?.keyboard) return;
    this.#drag = null;
    drag.element.classList.remove(WIDGETS.picked);
    if (cancel) this.#show(drag.start);
    const title = this.#title(drag.id);
    this.#say(cancel ? WIDGETS.say.cancelled(title) : WIDGETS.say.dropped(title, drag.target.x, drag.target.y));
    this.#commit(drag.start, cancel ? drag.start : this.#layout, null);
  }

  // ── раскладки ─────────────────────────────────────────

  #commit(start, layout, id) {
    if (id) {
      const item = layout.find((entry) => entry.id === id);
      this.#say(WIDGETS.say.dropped(this.#title(id), item.x, item.y));
    }
    if (same(start, layout)) return;
    this.#layouts.set(this.#cols, layout);
    emit(this.#root, EVENTS.widgetsChange, { cols: this.#cols, layout, layouts: Object.fromEntries(this.#layouts) });
  }

  #load(layouts) {
    Object.entries(layouts).forEach(([cols, saved]) => {
      if (Array.isArray(saved)) this.#layouts.set(Number(cols), normalize(saved, this.#sizes(), Number(cols)));
    });
    const current = this.#layouts.get(this.#cols);
    if (current) this.#show(current, { animate: false });
  }

  #reset() {
    this.#layouts.clear();
    const layout = pack(this.#sizes(), this.#cols);
    this.#show(layout);
    emit(this.#root, EVENTS.widgetsChange, { cols: this.#cols, layout, layouts: {} });
  }

  #onResize() {
    const cols = this.#readCols();
    if (cols === this.#cols) return;
    if (this.#drag) this.#drag.keyboard ? this.#keys.cancel() : this.#land({ cancel: true });
    this.#cols = cols;
    const layout = this.#layouts.get(cols) ?? adapt(this.#layout, cols);
    this.#show(layout, { animate: false });
  }
}
