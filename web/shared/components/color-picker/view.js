// Разметка пикера цвета: квадрат или круг, полосы оттенка и яркости, поле
// кода, пипетка и образцы. Только построить и отдать ссылки.
import { COLOR_PICKER } from '../../utils/constants.js';
import { h, svgIcon } from '../../utils/dom.js';

const range = (className, max, label) => {
  const input = h('input', { class: 'range__input', type: 'range', min: '0', max: String(max), step: '1', 'aria-label': label });
  return { root: h('div', { class: `range ${className}` }, input), input };
};

export function buildPicker(root, { wheel, presets }) {
  const { labels } = COLOR_PICKER;
  const surface = h('div', {
    class: wheel ? 'color-picker__wheel' : 'color-picker__area',
    role: 'slider',
    tabindex: '0',
    'aria-label': wheel ? labels.wheel : labels.area,
  }, h('span', { class: 'color-picker__thumb' }));
  const hue = wheel ? null : range('color-picker__hue', 359, labels.hue);
  const value = wheel ? range('color-picker__value', 100, labels.value) : null;
  const hex = h('input', {
    class: 'input__control', type: 'text', inputmode: 'text', maxlength: '7', spellcheck: 'false',
    autocomplete: 'off', 'aria-label': labels.hex,
  });
  const drop = 'EyeDropper' in window ? h('button', {
    class: 'button button_view_ghost button_shape_round button_size_s color-picker__drop', type: 'button', 'aria-label': labels.drop,
  }, svgIcon('eyedropper', 'icon_motion_hover button__icon')) : null;
  const foot = h('div', { class: 'color-picker__foot' },
    h('span', { class: 'color-picker__preview', 'aria-hidden': 'true' }),
    h('div', { class: 'input input_size_s color-picker__hex' }, hex),
    drop);
  const swatches = presets.map((color) => h('button', {
    class: 'swatch swatch_size_s', type: 'button', style: { '--swatch-color': color },
    dataset: { color }, 'aria-label': labels.preset(color),
  }, h('span', { class: 'swatch__color', 'aria-hidden': 'true' })));
  const parts = [surface, (hue ?? value).root, foot, swatches.length ? h('div', { class: 'color-picker__presets' }, swatches) : null];
  root.append(...parts.filter(Boolean));
  return { surface, hue: hue?.input, value: value?.input, hex, drop, presets: swatches };
}
