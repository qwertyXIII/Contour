// Ползунок: заливка дорожки до ручки (--range-fill) и живое значение в подписи.
// Значение показывается в <output for="id"> и в field__value своего поля.
export class Range {
  #root;
  #input;

  constructor(root) {
    this.#root = root;
    this.#input = root.querySelector('.range__input');
  }

  init() {
    if (!this.#input) return this;
    this.#input.addEventListener('input', () => this.#sync());
    this.#sync();
    return this;
  }

  #sync() {
    const min = Number(this.#input.min || 0);
    const max = Number(this.#input.max || 100);
    const value = Number(this.#input.value);
    const share = max > min ? ((value - min) / (max - min)) * 100 : 0;
    this.#root.style.setProperty('--range-fill', `${share}%`);
    this.#outputs().forEach((output) => {
      output.textContent = `${this.#input.value}${this.#input.dataset.unit ?? ''}`;
    });
  }

  #outputs() {
    const linked = this.#input.id ? [...document.querySelectorAll(`output[for~="${this.#input.id}"]`)] : [];
    const own = this.#root.closest('.field')?.querySelector('.field__value');
    return own && !linked.includes(own) ? [...linked, own] : linked;
  }
}
