// «Выбрать все»: главный флажок отмечает все пункты, а сам показывает, сколько
// отмечено, — все, ни одного или «частично» (indeterminate).
export class CheckboxGroup {
  #all;
  #items;

  constructor(root) {
    this.#all = root.querySelector('.checkbox-group__all');
    this.#items = [...root.querySelectorAll('.checkbox-group__item')];
  }

  init() {
    if (!this.#all || !this.#items.length) return this;
    this.#all.addEventListener('change', () => this.#setAll(this.#all.checked));
    this.#items.forEach((item) => item.addEventListener('change', () => this.#sync()));
    this.#sync();
    return this;
  }

  #setAll(checked) {
    this.#items.filter((item) => !item.disabled).forEach((item) => {
      item.checked = checked;
      item.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  #sync() {
    const checked = this.#items.filter((item) => item.checked).length;
    this.#all.checked = checked === this.#items.length;
    this.#all.indeterminate = checked > 0 && checked < this.#items.length;
  }
}
