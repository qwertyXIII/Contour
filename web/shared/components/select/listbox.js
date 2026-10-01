// Навигация по пунктам списка: подсветка (aria-activedescendant), стрелки,
// начало и конец, поиск по первым буквам, фильтр по строке поиска.
// Фокус стоит не на пункте, а на «владельце» — списке или поле поиска.
import { SELECT, STATE_CLASSES } from '../../utils/constants.js';

const isEnabled = (option) => !option.hidden && option.getAttribute('aria-disabled') !== 'true';

export class Listbox {
  #list;
  #options;
  #owner = null;
  #active = null;
  #typed = '';
  #typedAt = 0;

  constructor(list, options) {
    this.#list = list;
    this.#options = options;
  }

  get active() {
    return this.#active;
  }

  setOwner(owner) {
    this.#owner = owner;
    if (this.#active) owner.setAttribute('aria-activedescendant', this.#active.id);
  }

  activate(option) {
    this.#active?.classList.remove(STATE_CLASSES.optionActive);
    this.#active = option ?? null;
    if (!this.#active) {
      this.#owner?.removeAttribute('aria-activedescendant');
      return;
    }
    this.#active.classList.add(STATE_CLASSES.optionActive);
    this.#owner?.setAttribute('aria-activedescendant', this.#active.id);
    this.#active.scrollIntoView({ block: 'nearest' });
  }

  move(step) {
    const enabled = this.#options.filter(isEnabled);
    if (!enabled.length) return;
    const index = enabled.indexOf(this.#active);
    const next = index < 0 ? (step > 0 ? 0 : enabled.length - 1) : index + step;
    this.activate(enabled[Math.min(Math.max(next, 0), enabled.length - 1)]);
  }

  edge(toEnd) {
    const enabled = this.#options.filter(isEnabled);
    this.activate(toEnd ? enabled.at(-1) : enabled[0]);
  }

  // Набрал «мо» быстро — подсветился первый пункт на «мо».
  typeahead(char) {
    const now = Date.now();
    this.#typed = now - this.#typedAt > SELECT.typeaheadResetMs ? char : this.#typed + char;
    this.#typedAt = now;
    const query = this.#typed.toLowerCase();
    const match = this.#options.filter(isEnabled).find((option) => option.dataset.label.startsWith(query));
    if (match) this.activate(match);
  }

  /** Оставить пункты, где есть строка; вернуть, сколько осталось. */
  filter(query) {
    const needle = query.trim().toLowerCase();
    let shown = 0;
    this.#options.forEach((option) => {
      option.hidden = needle !== '' && !option.dataset.search.includes(needle);
      if (!option.hidden) shown += 1;
    });
    this.#syncGroups();
    if (!this.#active || this.#active.hidden) this.edge(false);
    return shown;
  }

  // Заголовок группы прячется, если под ним не осталось пунктов.
  #syncGroups() {
    let header = null;
    let visible = false;
    for (const node of this.#list.children) {
      if (node.getAttribute('role') === 'presentation') {
        if (header) header.hidden = !visible;
        header = node;
        visible = false;
      } else if (!node.hidden) {
        visible = true;
      }
    }
    if (header) header.hidden = !visible;
  }
}
