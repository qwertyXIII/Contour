// Частые сочетания блоков дизайн-системы, которые собираются один раз:
// кнопка, раздел, пустое состояние. То, что обновляется на тике, — в view.js.
// h() и svgIcon() — из /shared/utils/dom.js.
import { h, svgIcon } from '/shared/utils/dom.js';

export { h, svgIcon };

export function button(text, { icon, view, size = 's', data = {}, label } = {}) {
  return h('button', { class: `button button_size_${size}${view ? ` button_view_${view}` : ''}`, type: 'button', dataset: data, 'aria-label': label },
    icon ? svgIcon(icon, 'button__icon') : null,
    text ? h('span', { class: 'button__text', text }) : null);
}

export function group(title, note, ...body) {
  return h('section', { class: 'group' },
    h('header', { class: 'group__head' }, h('h2', { class: 'group__title', text: title }), note ? h('p', { class: 'group__note', text: note }) : null),
    h('div', { class: 'group__body' }, ...body));
}

export function empty(icon, title, text) {
  return h('div', { class: 'card' }, h('div', { class: 'empty empty_size_s' },
    h('span', { class: 'glyph glyph_size_l empty__visual' }, svgIcon(icon)),
    h('h3', { class: 'empty__title', text: title }),
    text ? h('p', { class: 'empty__text', text }) : null));
}

