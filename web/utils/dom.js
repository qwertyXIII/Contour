// Сборка строк и карточек панели из блоков дизайн-системы.
// h() и svgIcon() — из /shared/utils/dom.js; здесь — частые сочетания.
import { h, svgIcon } from '/shared/utils/dom.js';

export { h, svgIcon };

export function glyph(icon, tone) {
  return h('span', { class: `glyph${tone ? ` glyph_tone_${tone}` : ''}` }, svgIcon(icon));
}

export function badge(text, tone) {
  return h('span', { class: `badge${tone ? ` badge_tone_${tone}` : ''}` }, h('span', { class: 'badge__dot', 'aria-hidden': 'true' }), text);
}

export function button(text, { icon, view, size = 's', data = {}, label } = {}) {
  return h('button', { class: `button button_size_${size}${view ? ` button_view_${view}` : ''}`, type: 'button', dataset: data, 'aria-label': label },
    icon ? svgIcon(icon, 'button__icon') : null,
    text ? h('span', { class: 'button__text', text }) : null);
}

/** Строка «значок · заголовок и пояснение · справа». */
export function row({ lead, title, note, meta, trail }) {
  return h('div', { class: 'row' },
    lead ? h('span', { class: 'row__lead' }, lead) : null,
    h('div', { class: 'row__body' }, h('span', { class: 'row__title', text: title }), note ? h('span', { class: 'row__note', text: note }) : null),
    meta ? h('span', { class: 'row__meta', text: meta }) : null,
    trail ? h('span', { class: 'row__trail' }, trail) : null);
}

/** Число и единица — раздельно («100,5» + «Мбит/с»): так метрика не переносит единицу под число. */
export function metric(label, value, note) {
  const at = value.lastIndexOf(' ');
  const [number, unit] = at > 0 && /[^\d\s,.]/.test(value.slice(at + 1)) ? [value.slice(0, at), value.slice(at + 1)] : [value, null];
  return h('div', { class: 'card' }, h('div', { class: 'metric metric_size_s' },
    h('span', { class: 'metric__label', text: label }),
    h('span', { class: 'metric__value' }, h('span', { class: 'metric__number', text: number }), unit ? h('span', { class: 'metric__unit', text: unit }) : null),
    note ? h('span', { class: 'metric__note', text: note }) : null));
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

/** Список строк в карточке: её отступ — рамка списка, крайним строкам свой не нужен (блок list). */
export function list(items) {
  return h('div', { class: 'card' }, h('ul', { class: 'list' }, items.map((it) => h('li', { class: 'list__item' }, it))));
}

export function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', { class: 'kv__key', text: k }), h('dd', { class: 'kv__value' }, v)]));
}
