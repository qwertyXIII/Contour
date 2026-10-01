// Выбор из списка, который ведут ДАННЫЕ: соперник выхода, режим шлюза устройства.
//
// Select дизайн-системы строит свой список один раз и берёт значение из события
// change, а не из select.value. Поэтому, когда меняются данные — варианты или
// текущее значение, — контрол собирается заново и система улучшает его снова;
// на тиках без перемен он не трогается. После выбора руками ждём, пока данные
// догонят выбор (Contour перезапускается, помощник применяет), — иначе на
// полминуты вернулось бы старое значение.
import { h, svgIcon } from './dom.js';

const PENDING_MS = 30_000;

function build(ariaLabel, dataset, options, value) {
  const select = h('select', { class: 'select__native', 'aria-label': ariaLabel, dataset },
    ...options.map((o) => h('option', { value: o.value, text: o.text })));
  select.value = value;
  return h('span', { class: 'select select_size_s field__control' }, select, svgIcon('chevron-down', 'select__arrow'));
}

/** `label` — подпись над полем (null — без подписи, только aria-label). */
export function selectField(label, ariaLabel = label) {
  const el = label
    ? h('div', { class: 'field' }, h('div', { class: 'field__text' }, h('span', { class: 'field__label', text: label })))
    : h('div', { class: 'field' });
  let control = null;
  let shown = null;
  let chosenAt = 0;
  el.addEventListener('change', () => { chosenAt = Date.now(); });
  return {
    el,
    /** `dataset` — на <select> (по нему слушатель на разделе узнаёт, чей выбор); `options` — [{value, text}]. */
    update(dataset, options, value) {
      const key = `${JSON.stringify(dataset)}|${options.map((o) => `${o.value}=${o.text}`).join(',')}|${value}`;
      if (key === shown) return;
      if (control?.contains(document.activeElement) || Date.now() - chosenAt < PENDING_MS) return;
      shown = key;
      const next = build(ariaLabel, dataset, options, value);
      if (control) control.replaceWith(next);
      else el.append(next);
      control = next;
    },
    /** Выбор не прошёл — показать снова то, что в данных, не дожидаясь полминуты. */
    forget() {
      chosenAt = 0;
      shown = null;
    },
  };
}
