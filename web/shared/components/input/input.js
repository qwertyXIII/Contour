// Поле ввода: кнопки внутри поля. «Очистить» видна, только когда есть текст
// (модификатор input_filled), «Показать» переключает пароль и значок.
import { STATE_CLASSES } from '../../utils/constants.js';
import { setIcon } from '../../utils/dom.js';

const REVEAL_ICONS = { hidden: 'eye', shown: 'eye-off' };

export class Input {
  #root;
  #control;

  constructor(root) {
    this.#root = root;
    this.#control = root.querySelector('.input__control');
  }

  init() {
    if (!this.#control) return this;
    this.#control.addEventListener('input', () => this.#syncFilled());
    this.#root.addEventListener('click', (event) => this.#onClick(event));
    this.#syncFilled();
    return this;
  }

  #onClick(event) {
    if (event.target.closest('.input__action_kind_clear')) this.#clear();
    else if (event.target.closest('.input__action_kind_reveal')) this.#toggleReveal(event.target.closest('button'));
    else if (!event.target.closest('button')) this.#control.focus();
  }

  #clear() {
    this.#control.value = '';
    this.#control.dispatchEvent(new Event('input', { bubbles: true }));
    this.#control.focus();
  }

  #toggleReveal(button) {
    const shown = this.#control.type === 'password';
    this.#control.type = shown ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(shown));
    button.setAttribute('aria-label', shown ? 'Скрыть' : 'Показать');
    setIcon(button.querySelector('.icon'), shown ? REVEAL_ICONS.shown : REVEAL_ICONS.hidden);
  }

  #syncFilled() {
    this.#root.classList.toggle(STATE_CLASSES.inputFilled, this.#control.value !== '');
  }
}
