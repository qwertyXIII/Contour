// Сегменты: одна плашка на группу, переезжает под выбранный вариант, меняя
// ширину под длину подписи. Выбор — по-прежнему нативные radio: стрелки,
// формы и скринридер работают без этого компонента.
import { SEGMENTED } from '../../utils/constants.js';
import { Indicator } from '../../utils/indicator.js';

export class Segmented {
  #root;

  constructor(root) {
    this.#root = root;
  }

  init() {
    if (!this.#root.querySelector('.segmented__input')) return this;
    new Indicator(this.#root, {
      thumbClass: 'segmented__thumb',
      enhanced: SEGMENTED.enhanced,
      ready: SEGMENTED.ready,
      target: (input) => input.closest('.segmented__option'),
    }).mount();
    return this;
  }
}
