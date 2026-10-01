// Чип с крестиком: убирает себя и сообщает chip:remove { value } — кому нужно
// (фильтр, список тегов), тот услышит.
import { EVENTS } from '../../utils/constants.js';
import { emit } from '../../utils/dom.js';

export class Chip {
  #root;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#root.querySelector('.chip__remove')?.addEventListener('click', () => this.remove());
    return this;
  }

  remove() {
    const parent = this.#root.parentElement ?? document;
    emit(parent, EVENTS.chipRemove, { value: this.#root.dataset.value ?? this.#root.textContent.trim() });
    this.#root.remove();
  }
}
