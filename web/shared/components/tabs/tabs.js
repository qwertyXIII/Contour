// Вкладки по шаблону WAI-ARIA: стрелки, Home и End переключают сразу,
// в порядке Tab стоит только выбранная вкладка.
const KEY_STEPS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export class Tabs {
  #tabs;

  constructor(root) {
    this.#tabs = [...root.querySelectorAll('.tabs__tab')];
  }

  init() {
    this.#tabs.forEach((tab) => {
      tab.addEventListener('click', () => this.select(tab));
      tab.addEventListener('keydown', (event) => this.#onKey(event, tab));
    });
    const current = this.#tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? this.#tabs[0];
    if (current) this.select(current, { focus: false });
    return this;
  }

  select(tab, { focus = true } = {}) {
    this.#tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(item.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    });
    if (focus) tab.focus();
  }

  #onKey(event, tab) {
    const index = this.#tabs.indexOf(tab);
    let next = null;
    if (event.key in KEY_STEPS) next = (index + KEY_STEPS[event.key] + this.#tabs.length) % this.#tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = this.#tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    this.select(this.#tabs[next]);
  }
}
