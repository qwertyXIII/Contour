// Плашка выбора, которая переезжает под отмеченный вариант: сегменты, лента
// дат. Выбор — нативные radio внутри корня; плашка только показывает его.
//
// Пишет на корень --thumb-x / --thumb-y / --thumb-w / --thumb-h — от края
// корня с учётом прокрутки (лента дат прокручивается вбок). Как их применить
// (вся высота, кружок, черта снизу), решает CSS блока.
import { EVENTS } from './constants.js';
import { h } from './dom.js';

export class Indicator {
  #root;
  #thumb;
  #target;
  #classes;

  /**
   * @param {HTMLElement} root
   * @param {{ thumbClass: string, enhanced: string, ready: string, target?: (input: HTMLInputElement) => Element | null }} options
   */
  constructor(root, { thumbClass, enhanced, ready, target }) {
    this.#root = root;
    this.#classes = { enhanced, ready };
    this.#target = target ?? ((input) => input.closest('label'));
    this.#thumb = h('span', { class: thumbClass, 'aria-hidden': 'true' });
  }

  mount() {
    this.#root.prepend(this.#thumb);
    this.#root.classList.add(this.#classes.enhanced);
    this.#root.addEventListener('change', () => this.sync());
    this.#root.addEventListener(EVENTS.segmentedSync, () => this.sync());
    // Размер поменялся (окно, раскрытое меню, другая плотность) — встать на место без езды.
    new ResizeObserver(() => this.sync({ instant: true })).observe(this.#root);
    this.sync({ instant: true });
    requestAnimationFrame(() => requestAnimationFrame(() => this.#root.classList.add(this.#classes.ready)));
    return this;
  }

  /** Отмеченный вариант или null. */
  current() {
    const input = this.#root.querySelector('input:checked');
    return input ? this.#target(input) : null;
  }

  sync({ instant = false } = {}) {
    const target = this.current();
    this.#thumb.hidden = !target;
    if (!target) return;
    const animated = this.#root.classList.contains(this.#classes.ready);
    if (instant && animated) this.#root.classList.remove(this.#classes.ready);
    this.#place(target);
    if (instant && animated) {
      void this.#root.offsetWidth; // зафиксировать место до того, как вернуть переходы
      this.#root.classList.add(this.#classes.ready);
    }
  }

  #place(target) {
    const box = this.#root.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const border = { left: this.#root.clientLeft, top: this.#root.clientTop };
    const style = this.#root.style;
    style.setProperty('--thumb-x', `${rect.left - box.left - border.left + this.#root.scrollLeft}px`);
    style.setProperty('--thumb-y', `${rect.top - box.top - border.top + this.#root.scrollTop}px`);
    style.setProperty('--thumb-w', `${rect.width}px`);
    style.setProperty('--thumb-h', `${rect.height}px`);
  }
}
