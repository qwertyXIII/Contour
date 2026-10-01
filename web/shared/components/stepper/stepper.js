// Счётчик: кнопки двигают нативный number через stepUp/stepDown, поэтому
// min, max и step берутся из разметки, а форма получает обычные input/change.
export class Stepper {
  #input;
  #down;
  #up;

  constructor(root) {
    this.#input = root.querySelector('.stepper__input');
    this.#down = root.querySelector('.stepper__button_action_down');
    this.#up = root.querySelector('.stepper__button_action_up');
  }

  init() {
    if (!this.#input) return this;
    this.#down?.addEventListener('click', () => this.#step(-1));
    this.#up?.addEventListener('click', () => this.#step(1));
    this.#input.addEventListener('input', () => this.#syncButtons());
    this.#syncButtons();
    return this;
  }

  #step(direction) {
    if (direction > 0) this.#input.stepUp();
    else this.#input.stepDown();
    this.#input.dispatchEvent(new Event('input', { bubbles: true }));
    this.#input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  #syncButtons() {
    const value = Number(this.#input.value);
    const min = this.#input.min === '' ? -Infinity : Number(this.#input.min);
    const max = this.#input.max === '' ? Infinity : Number(this.#input.max);
    if (this.#down) this.#down.disabled = value <= min;
    if (this.#up) this.#up.disabled = value >= max;
  }
}
