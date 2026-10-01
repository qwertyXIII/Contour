// Палец и мышь для сетки виджетов. Вне правки виджет берут долгим
// нажатием: палец неподвижен longPressMs — правка включается и виджет
// поднят; сдвинулся раньше — это прокрутка или обычное нажатие, не мешаем.
// В правке виджет тянется сразу, как только палец сдвинулся на dragSlop.
//
// Движение слушаем на window в фазе перехвата: даже если внутри виджета
// ползунок захватил указатель, дальше него события не пойдут, пока тянем.
// У края прокручиваемой области она сама едет — виджет можно унести ниже экрана.
import { WIDGETS } from '../../utils/constants.js';

function scrollParent(element) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
}

export class PointerDrag {
  #grid;
  #item;
  #hooks;
  #pending = null;
  #active = false;
  #point = null;
  #timer = 0;
  #frame = 0;
  #scroller = null;
  #suppress = false;

  /**
   * @param {HTMLElement} grid
   * @param {{ item: string, editing: () => boolean, onPress: Function, onStart: Function, onMove: Function, onEnd: Function, onCancel: Function }} hooks
   */
  constructor(grid, hooks) {
    this.#grid = grid;
    this.#item = hooks.item;
    this.#hooks = hooks;
  }

  get active() {
    return this.#active;
  }

  bind() {
    this.#grid.addEventListener('pointerdown', (event) => this.#down(event), true);
    window.addEventListener('pointermove', (event) => this.#move(event), true);
    window.addEventListener('pointerup', (event) => this.#up(event), true);
    window.addEventListener('pointercancel', (event) => this.#cancel(event), true);
    // Долгое нажатие на телефоне открыло бы меню браузера; пока тянем — страница не едет.
    this.#grid.addEventListener('contextmenu', (event) => { if (this.#pending || this.#hooks.editing()) event.preventDefault(); });
    document.addEventListener('touchmove', (event) => { if (this.#active) event.preventDefault(); }, { passive: false });
    // Щелчок, который браузер шлёт после отпускания, — не нажатие по виджету.
    this.#grid.addEventListener('click', (event) => {
      if (!this.#suppress) return;
      this.#suppress = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    return this;
  }

  #down(event) {
    if (event.button > 0 || this.#active) return;
    const item = event.target.closest(this.#item);
    if (!item || !this.#grid.contains(item)) return;
    this.#point = { x: event.clientX, y: event.clientY };
    this.#pending = { item, pointer: event.pointerId, from: this.#point, editing: this.#hooks.editing() };
    if (this.#pending.editing) {
      event.stopPropagation();
      return;
    }
    this.#timer = setTimeout(() => this.#press(), WIDGETS.longPressMs);
  }

  #press() {
    const pending = this.#pending;
    if (!pending) return;
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(WIDGETS.vibrateMs);
    this.#hooks.onPress(pending.item, this.#point);
    this.#begin(pending.item);
  }

  #begin(item) {
    this.#active = true;
    this.#scroller = scrollParent(this.#grid);
    this.#hooks.onStart(item, this.#point);
    this.#frame = requestAnimationFrame(() => this.#autoscroll());
  }

  #move(event) {
    const pending = this.#pending;
    if (!pending || event.pointerId !== pending.pointer) return;
    this.#point = { x: event.clientX, y: event.clientY };
    if (this.#active) {
      event.stopPropagation();
      this.#hooks.onMove(this.#point);
      return;
    }
    const distance = Math.hypot(this.#point.x - pending.from.x, this.#point.y - pending.from.y);
    if (!pending.editing && distance > WIDGETS.pressSlop) this.#reset();
    else if (pending.editing && distance > WIDGETS.dragSlop) this.#begin(pending.item);
  }

  #up(event) {
    if (!this.#pending || event.pointerId !== this.#pending.pointer) return;
    const wasActive = this.#active;
    this.#reset();
    if (!wasActive) return;
    this.#suppress = true;
    setTimeout(() => { this.#suppress = false; }, 0);
    this.#hooks.onEnd();
  }

  #cancel(event) {
    if (!this.#pending || event.pointerId !== this.#pending.pointer) return;
    const wasActive = this.#active;
    this.#reset();
    if (wasActive) this.#hooks.onCancel();
  }

  #reset() {
    clearTimeout(this.#timer);
    cancelAnimationFrame(this.#frame);
    this.#pending = null;
    this.#active = false;
  }

  #autoscroll() {
    if (!this.#active) return;
    const scroller = this.#scroller;
    const box = scroller === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
    const { y } = this.#point;
    let step = 0;
    if (y < box.top + WIDGETS.edge) step = -WIDGETS.scrollSpeed * (1 - (y - box.top) / WIDGETS.edge);
    if (y > box.bottom - WIDGETS.edge) step = WIDGETS.scrollSpeed * (1 - (box.bottom - y) / WIDGETS.edge);
    if (step) {
      const before = scroller.scrollTop;
      scroller.scrollTop += step;
      if (scroller.scrollTop !== before) this.#hooks.onMove(this.#point);
    }
    this.#frame = requestAnimationFrame(() => this.#autoscroll());
  }
}
