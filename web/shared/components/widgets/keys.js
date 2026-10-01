// Клавиатура в правке виджетов: пробел или Enter — взять виджет в фокусе,
// стрелки — двигать по клеткам (соседи уступают так же, как пальцу),
// пробел или Enter — положить, Esc — вернуть, где был.
const STEP = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export class KeyMover {
  #grid;
  #item;
  #hooks;
  #picked = null;

  /** @param {{ item: string, editing: () => boolean, onPick: Function, onStep: Function, onDrop: Function, onCancel: Function }} hooks */
  constructor(grid, hooks) {
    this.#grid = grid;
    this.#item = hooks.item;
    this.#hooks = hooks;
  }

  get picked() {
    return this.#picked;
  }

  bind() {
    this.#grid.addEventListener('keydown', (event) => this.#key(event));
    // Ушли фокусом с взятого виджета — кладём, где стоит.
    this.#grid.addEventListener('focusout', (event) => {
      if (this.#picked && event.target === this.#picked) this.drop();
    });
    return this;
  }

  drop() {
    if (!this.#picked) return;
    this.#picked = null;
    this.#hooks.onDrop();
  }

  cancel() {
    if (!this.#picked) return;
    this.#picked = null;
    this.#hooks.onCancel();
  }

  #key(event) {
    if (!this.#hooks.editing()) return;
    const item = event.target.closest(this.#item);
    if (!item || event.target !== item) return;
    const toggle = event.key === ' ' || event.key === 'Enter';
    if (!this.#picked && toggle) {
      event.preventDefault();
      this.#picked = item;
      this.#hooks.onPick(item);
      return;
    }
    if (!this.#picked) return;
    if (toggle) {
      event.preventDefault();
      this.drop();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
    } else if (STEP[event.key]) {
      event.preventDefault();
      this.#hooks.onStep(...STEP[event.key]);
    }
  }
}
