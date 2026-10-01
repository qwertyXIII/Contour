// Свой select поверх нативного: одинаковый вид везде, нативный остаётся
// источником значения (name, форма, change). Панель — popover: закрытие по
// клику мимо и Esc даёт браузер. Без popover — остаётся нативный.
import { EVENTS, QUERIES, SELECT, STATE_CLASSES } from '../../utils/constants.js';
import { emit, setIcon, uid } from '../../utils/dom.js';
import { followAnchor, placePopup, supportsPopover } from '../../utils/popup.js';
import { Listbox } from './listbox.js';
import { buildOptions, buildPopup, buildTrigger } from './view.js';

const PLACEMENT = { matchWidth: true };

export class Select {
  #root;
  #native;
  #id = '';
  #ui = null;
  #listbox = null;
  #label = null;
  #stopFollow = null;
  #hadFocus = false;

  constructor(root) {
    this.#root = root;
    this.#native = root.querySelector('.select__native');
  }

  init() {
    if (!this.#native || !supportsPopover) return this;
    this.#id = uid('select');
    this.#render();
    this.#bind();
    this.#sync();
    this.#root.classList.add(STATE_CLASSES.selectEnhanced);
    return this;
  }

  open() {
    if (!this.#ui.popup.matches(':popover-open')) this.#ui.popup.showPopover();
  }

  close() {
    if (this.#ui.popup.matches(':popover-open')) this.#ui.popup.hidePopover();
  }

  #render() {
    const trigger = buildTrigger(this.#id, this.#root.querySelector('.select__arrow'));
    const popup = buildPopup(this.#id, this.#root.classList.contains('select_searchable'));
    const { nodes, options } = buildOptions(this.#native, this.#id);
    popup.list.append(...nodes);
    this.#ui = { trigger, popup: popup.root, list: popup.list, empty: popup.empty, search: popup.search, options };
    this.#listbox = new Listbox(popup.list, options);
    trigger.disabled = this.#native.disabled;
    this.#connectLabel();
    this.#root.append(trigger, popup.root);
  }

  // Подпись поля (label for) называет и триггер, и список; клик по ней — фокус в триггер.
  #connectLabel() {
    const { trigger, list } = this.#ui;
    this.#label = this.#native.id ? document.querySelector(`label[for="${this.#native.id}"]`) : null;
    if (!this.#label) return;
    this.#label.id ||= `${this.#id}-label`;
    trigger.setAttribute('aria-labelledby', `${this.#label.id} ${this.#id}-value`);
    list.setAttribute('aria-labelledby', this.#label.id);
    this.#label.addEventListener('click', (event) => {
      event.preventDefault();
      trigger.focus();
    });
  }

  #bind() {
    const { trigger, popup, list, search } = this.#ui;
    trigger.addEventListener('keydown', (event) => this.#onTriggerKey(event));
    popup.addEventListener('beforetoggle', (event) => {
      if (event.newState === 'closed') this.#hadFocus = popup.contains(document.activeElement);
    });
    popup.addEventListener('toggle', (event) => (event.newState === 'open' ? this.#onOpen() : this.#onClose()));
    popup.addEventListener('keydown', (event) => this.#onListKey(event));
    list.addEventListener('click', (event) => this.#choose(event.target.closest('.select__option')));
    list.addEventListener('pointermove', (event) => {
      const option = event.target.closest('.select__option');
      if (option && option !== this.#listbox.active && option.getAttribute('aria-disabled') !== 'true') {
        this.#listbox.activate(option);
      }
    });
    search?.addEventListener('input', () => this.#filter());
    search?.addEventListener('focus', () => this.#listbox.setOwner(search));
    list.addEventListener('focus', () => this.#listbox.setOwner(list));
    this.#native.addEventListener('change', () => this.#sync());
    this.#native.form?.addEventListener('reset', () => setTimeout(() => this.#sync()));
  }

  // Enter и пробел нажимают кнопку сами (popovertarget), стрелки открывают отсюда.
  #onTriggerKey(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    this.open();
  }

  #onOpen() {
    const { trigger, popup, list, search } = this.#ui;
    placePopup(popup, trigger, PLACEMENT);
    this.#stopFollow = followAnchor(popup, trigger, PLACEMENT);
    trigger.setAttribute('aria-expanded', 'true');
    // На пальце поиск не фокусируется сам: клавиатура закрыла бы половину списка.
    const owner = search && !window.matchMedia(QUERIES.coarse).matches ? search : list;
    this.#listbox.setOwner(owner);
    const selected = this.#ui.options.find((option) => option.getAttribute('aria-selected') === 'true');
    if (selected) this.#listbox.activate(selected);
    else this.#listbox.edge(false);
    owner.focus({ preventScroll: true });
  }

  #onClose() {
    const { trigger, search } = this.#ui;
    this.#stopFollow?.();
    this.#stopFollow = null;
    trigger.setAttribute('aria-expanded', 'false');
    if (search && search.value) {
      search.value = '';
      this.#filter();
    }
    if (this.#hadFocus && document.activeElement !== trigger) trigger.focus({ preventScroll: true });
  }

  // В поле поиска пробел, Home и End принадлежат тексту, а не списку.
  #onListKey(event) {
    const typing = Boolean(this.#ui.search) && document.activeElement === this.#ui.search;
    const keys = {
      ArrowDown: () => this.#listbox.move(1),
      ArrowUp: () => this.#listbox.move(-1),
      Enter: () => this.#choose(this.#listbox.active),
      Tab: () => this.close(),
      ...(typing ? {} : {
        Home: () => this.#listbox.edge(false),
        End: () => this.#listbox.edge(true),
        ' ': () => this.#choose(this.#listbox.active),
      }),
    };
    if (keys[event.key]) {
      event.preventDefault();
      keys[event.key]();
    } else if (!typing && event.key.length === 1 && event.key.trim()) {
      this.#listbox.typeahead(event.key.toLowerCase());
    }
  }

  #choose(option) {
    if (!option || option.getAttribute('aria-disabled') === 'true') return;
    const changed = this.#native.value !== option.dataset.value;
    this.#native.value = option.dataset.value;
    this.close();
    this.#sync();
    if (!changed) return;
    this.#native.dispatchEvent(new Event('input', { bubbles: true }));
    this.#native.dispatchEvent(new Event('change', { bubbles: true }));
    emit(this.#root, EVENTS.selectChange, { value: option.dataset.value, label: option.textContent.trim() });
  }

  #filter() {
    const shown = this.#listbox.filter(this.#ui.search.value);
    this.#ui.empty.hidden = shown > 0;
  }

  // Триггер и отметки — по нативному значению: оно могло поменяться и снаружи.
  #sync() {
    const { trigger, options } = this.#ui;
    // Подсказка — только скрытый пункт-заглушка: «как у подключения» с value="" — обычный выбор.
    const current = this.#native.selectedOptions[0];
    const empty = !current || current.hidden;
    options.forEach((option) => {
      option.setAttribute('aria-selected', String(!empty && option.dataset.value === current.value));
    });
    const value = trigger.querySelector('.select__value');
    value.textContent = empty ? (this.#native.dataset.placeholder ?? SELECT.placeholder) : current.textContent.trim();
    value.classList.toggle(STATE_CLASSES.valuePlaceholder, empty);
    trigger.querySelector('.select__hint').textContent = empty ? '' : (current.dataset.hint ?? '');
    this.#syncIcon(empty ? null : current.dataset.icon);
    if (!this.#label) trigger.setAttribute('aria-label', `${this.#native.getAttribute('aria-label') ?? ''}: ${value.textContent}`);
  }

  #syncIcon(name) {
    const icon = this.#ui.trigger.querySelector('.select__icon');
    icon.toggleAttribute('hidden', !name);
    if (name) setIcon(icon, name);
  }
}
