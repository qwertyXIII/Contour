// Лента дат: плашка переезжает под выбранный день (кружок или черта снизу —
// по виду ленты), а выбранный день всегда виден — лента докручивается к нему.
import { DATESTRIP } from '../../utils/constants.js';
import { Indicator } from '../../utils/indicator.js';

export class Datestrip {
  #root;
  #indicator = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    if (!this.#root.querySelector('.datestrip__input')) return this;
    const text = this.#root.classList.contains(DATESTRIP.textView);
    this.#indicator = new Indicator(this.#root, {
      thumbClass: 'datestrip__thumb',
      enhanced: DATESTRIP.enhanced,
      ready: DATESTRIP.ready,
      target: (input) => (text ? input.closest('.datestrip__day') : input.parentElement.querySelector('.datestrip__date')),
    }).mount();
    this.#root.addEventListener('change', () => this.#reveal(true));
    this.#reveal(false);
    return this;
  }

  // Выбранный день — посередине ленты, если она прокручивается.
  #reveal(smooth) {
    const day = this.#root.querySelector('.datestrip__input:checked')?.closest('.datestrip__day');
    if (!day || this.#root.scrollWidth <= this.#root.clientWidth) return;
    const left = day.offsetLeft - (this.#root.clientWidth - day.offsetWidth) / 2;
    this.#root.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  }
}
