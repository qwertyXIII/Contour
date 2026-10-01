// Мини-столбики: подсказка со значением на наведение и на фокус (с клавиатуры —
// то же, что мышью). Подсказка дополняет, а не прячет: значения есть и в
// таблице внутри блока, выделенный столбик подписан прямо на графике.
import { h } from '../../utils/dom.js';

export class Bars {
  #root;
  #tip;
  #value;
  #label;

  constructor(root) {
    this.#root = root;
    this.#value = h('span', { class: 'bars__tip-value' });
    this.#label = h('span', { class: 'bars__tip-label' });
    this.#tip = h('div', { class: 'bars__tip', role: 'tooltip', hidden: true }, this.#value, this.#label);
  }

  init() {
    const plot = this.#root.querySelector('.bars__plot');
    if (!plot) return this;
    this.#root.append(this.#tip);
    plot.querySelectorAll('.bars__bar').forEach((bar) => {
      if (!bar.hasAttribute('aria-label')) bar.setAttribute('aria-label', `${bar.dataset.label}: ${bar.dataset.value}`);
    });
    plot.addEventListener('pointerover', (event) => this.#show(event.target.closest('.bars__bar')));
    plot.addEventListener('focusin', (event) => this.#show(event.target.closest('.bars__bar')));
    plot.addEventListener('pointerleave', () => this.#hide());
    plot.addEventListener('focusout', () => this.#hide());
    return this;
  }

  #show(bar) {
    if (!bar) return;
    this.#value.textContent = bar.dataset.value ?? '';
    this.#label.textContent = bar.dataset.label ?? '';
    this.#tip.style.left = `${bar.offsetLeft + bar.offsetWidth / 2}px`;
    this.#tip.hidden = false;
  }

  #hide() {
    this.#tip.hidden = true;
  }
}
