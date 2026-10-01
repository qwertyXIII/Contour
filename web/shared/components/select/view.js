// Разметка своего select: триггер, панель со списком, пункты — из нативного
// <select>. Только createElement: пункты — данные, HTML-строк здесь нет.
import { SELECT } from '../../utils/constants.js';
import { h, svgIcon } from '../../utils/dom.js';

export function buildTrigger(id, arrow) {
  const trigger = h('button', {
    class: 'select__trigger',
    type: 'button',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-controls': `${id}-list`,
    popovertarget: `${id}-popup`,
  },
  svgIcon('grid', 'select__icon'),
  h('span', { class: 'select__value', id: `${id}-value` }),
  h('span', { class: 'select__hint' }),
  arrow ?? svgIcon('chevron-down', 'select__arrow'));
  trigger.querySelector('.select__icon').setAttribute('hidden', '');
  return trigger;
}

function buildSearch(id) {
  const control = h('input', {
    class: 'input__control',
    type: 'search',
    placeholder: SELECT.searchPlaceholder,
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': `${id}-list`,
    'aria-autocomplete': 'list',
  });
  return h('div', { class: 'input input_size_s select__search' }, svgIcon('search', 'input__icon'), control);
}

export function buildPopup(id, searchable) {
  const list = h('ul', { class: 'select__list', id: `${id}-list`, role: 'listbox', tabindex: '-1' });
  const empty = h('p', { class: 'select__empty', text: SELECT.emptyText, hidden: true });
  const search = searchable ? buildSearch(id) : null;
  const root = h('div', { class: 'popup select__popup', id: `${id}-popup`, popover: 'auto' }, search, list, empty);
  return { root, list, empty, search: search?.querySelector('.input__control') ?? null };
}

function buildOption(option, id) {
  const label = option.textContent.trim();
  const hint = option.dataset.hint ?? '';
  const node = h('li', {
    class: 'select__option',
    id,
    role: 'option',
    'aria-selected': 'false',
    'aria-disabled': option.disabled ? 'true' : null,
    dataset: { value: option.value, label: label.toLowerCase(), search: `${label} ${hint}`.toLowerCase() },
  },
  option.dataset.icon ? svgIcon(option.dataset.icon, 'select__option-icon') : null,
  h('span', { class: 'select__option-text' },
    h('span', { class: 'select__option-label', text: label }),
    hint ? h('span', { class: 'select__option-hint', text: hint }) : null),
  svgIcon('check', 'select__check'));
  return node;
}

/** Пункты и заголовки групп по порядку; скрытые <option hidden> (плейсхолдер) пропускаются. */
export function buildOptions(native, id) {
  const nodes = [];
  const options = [];
  let index = 0;
  const add = (option) => {
    if (option.hidden) return;
    index += 1;
    const node = buildOption(option, `${id}-opt-${index}`);
    nodes.push(node);
    options.push(node);
  };
  for (const child of native.children) {
    if (child instanceof HTMLOptGroupElement) {
      nodes.push(h('li', { class: 'select__group', role: 'presentation', text: child.label }));
      [...child.children].forEach(add);
    } else {
      add(child);
    }
  }
  return { nodes, options };
}
