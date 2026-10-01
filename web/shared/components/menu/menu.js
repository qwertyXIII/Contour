// Меню действий под кнопкой. Панель — popover (закрытие по клику мимо и Esc
// от браузера); здесь — положение, фокус по пунктам стрелками и событие
// menu:select { value } на выбор. Что делать с выбором, решает тот, кто слушает.
import { EVENTS } from '../../utils/constants.js';
import { emit, uid } from '../../utils/dom.js';
import { followAnchor, placePopup, supportsPopover } from '../../utils/popup.js';

const STEPS = { ArrowDown: 1, ArrowUp: -1 };

export class Menu {
  #root;
  #trigger;
  #popup;
  #placement;
  #stopFollow = null;
  #hadFocus = false;
  #focusLast = false;

  constructor(root) {
    this.#root = root;
    this.#trigger = root.querySelector('.menu__trigger');
    this.#popup = root.querySelector('.menu__popup');
    this.#placement = { align: root.classList.contains('menu_align_end') ? 'end' : 'start' };
  }

  init() {
    if (!this.#trigger || !this.#popup || !supportsPopover) return this;
    this.#popup.id ||= uid('menu');
    this.#popup.setAttribute('popover', 'auto');
    this.#trigger.setAttribute('popovertarget', this.#popup.id);
    this.#trigger.setAttribute('aria-haspopup', 'menu');
    this.#trigger.setAttribute('aria-expanded', 'false');
    this.#trigger.setAttribute('aria-controls', this.#popup.id);
    this.#bind();
    return this;
  }

  #bind() {
    this.#trigger.addEventListener('keydown', (event) => {
      if (!(event.key in STEPS)) return;
      event.preventDefault();
      this.#focusLast = event.key === 'ArrowUp';
      this.#popup.showPopover();
    });
    this.#popup.addEventListener('beforetoggle', (event) => {
      if (event.newState === 'closed') this.#hadFocus = this.#popup.contains(document.activeElement);
    });
    this.#popup.addEventListener('toggle', (event) => (event.newState === 'open' ? this.#onOpen() : this.#onClose()));
    this.#popup.addEventListener('keydown', (event) => this.#onKey(event));
    this.#popup.addEventListener('click', (event) => this.#onClick(event));
  }

  #items() {
    return [...this.#popup.querySelectorAll('.menu__item:not(:disabled)')];
  }

  #onOpen() {
    placePopup(this.#popup, this.#trigger, this.#placement);
    this.#stopFollow = followAnchor(this.#popup, this.#trigger, this.#placement);
    this.#trigger.setAttribute('aria-expanded', 'true');
    const items = this.#items();
    (this.#focusLast ? items.at(-1) : items[0])?.focus({ preventScroll: true });
    this.#focusLast = false;
  }

  #onClose() {
    this.#stopFollow?.();
    this.#stopFollow = null;
    this.#trigger.setAttribute('aria-expanded', 'false');
    if (this.#hadFocus && document.activeElement !== this.#trigger) this.#trigger.focus({ preventScroll: true });
  }

  #onKey(event) {
    const items = this.#items();
    const index = items.indexOf(document.activeElement);
    let next = null;
    if (event.key in STEPS) next = (index + STEPS[event.key] + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Tab') {
      event.preventDefault();
      this.#popup.hidePopover();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  #onClick(event) {
    const item = event.target.closest('.menu__item');
    if (!item || item.disabled) return;
    emit(this.#root, EVENTS.menuSelect, { value: item.dataset.value ?? item.textContent.trim() });
    this.#popup.hidePopover();
  }
}
