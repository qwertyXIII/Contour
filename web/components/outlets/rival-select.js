// «Не держать вместе с»: выбор соперника выхода в карточке. Соперники — ядерные
// выходы одного аккаунта, которые выбивают друг друга (AmneziaWG и OpenVPN одного
// ключа): в группе работает один, остальные запасные.
//
// Select дизайн-системы строит свой список один раз и берёт значение из события
// change, а не из select.value. Поэтому, когда меняются ДАННЫЕ — варианты
// (выход добавили или удалили) или соперник (группу поменяли), — контрол
// собирается заново и система улучшает его снова; на тиках без перемен он не
// трогается. После выбора руками ждём, пока Contour перезапустится и данные
// догонят выбор, — иначе на полминуты вернулось бы старое значение.
import { h, svgIcon } from '../../utils/dom.js';

const NONE = '';
const PENDING_MS = 30_000;

function build(name, candidates, value) {
  const select = h('select', { class: 'select__native', 'aria-label': 'Не держать вместе с', dataset: { name } },
    h('option', { value: NONE, text: '— ни с кем' }), ...candidates.map((c) => h('option', { value: c, text: c })));
  select.value = value;
  return h('span', { class: 'select select_size_s field__control' }, select, svgIcon('chevron-down', 'select__arrow'));
}

export function rivalSelect() {
  const el = h('div', { class: 'field' }, h('div', { class: 'field__text' }, h('span', { class: 'field__label', text: 'Не держать вместе с' })));
  let control = null;
  let shown = null;
  let chosenAt = 0;
  el.addEventListener('change', () => { chosenAt = Date.now(); });
  return {
    el,
    /** `candidates` — другие ядерные выходы; `current` — соперник сейчас или null. */
    update(name, candidates, current) {
      const value = current ?? NONE;
      const key = `${name}|${candidates.join(',')}|${value}`;
      if (key === shown) return;
      if (control?.contains(document.activeElement) || Date.now() - chosenAt < PENDING_MS) return;
      shown = key;
      const next = build(name, candidates, value);
      if (control) control.replaceWith(next);
      else el.append(next);
      control = next;
    },
  };
}
