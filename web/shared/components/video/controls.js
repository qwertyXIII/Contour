// Разметка своих элементов управления видео. Только построить и отдать
// ссылки — что они делают, решает Video.
import { VIDEO } from '../../utils/constants.js';
import { h, svgIcon } from '../../utils/dom.js';

const round = (className, icon, label) => h('button', {
  class: `button button_shape_round ${className}`,
  type: 'button',
  'aria-label': label,
}, svgIcon(icon, 'button__icon'));

/** Построить элементы поверх видео и вернуть ссылки на них. */
export function buildControls(root, { canFullscreen }) {
  const { icons, labels } = VIDEO;
  const big = round('button_view_media video__big', icons.play, labels.play);
  const toggle = round('button_view_ghost button_size_s video__button', icons.play, labels.play);
  const mute = round('button_view_ghost button_size_s video__button', icons.sound, labels.mute);
  const full = canFullscreen ? round('button_view_ghost button_size_s video__button', icons.enter, labels.enter) : null;
  const seek = h('input', {
    class: 'range__input', type: 'range', min: '0', max: '0', step: '0.1', value: '0', 'aria-label': labels.seek,
  });
  const time = h('span', { class: 'video__time', 'aria-hidden': 'true', text: '0:00' });
  const badge = h('span', { class: 'video__badge', 'aria-hidden': 'true' });
  const error = h('p', { class: 'video__error', role: 'status', text: labels.error });
  const spinner = h('span', { class: 'spinner spinner_size_l video__spinner', 'aria-hidden': 'true' });
  const bar = h('div', { class: 'video__bar' },
    h('div', { class: 'range range_view_thin video__seek' }, seek),
    toggle, time, h('span', { class: 'video__gap' }), mute, full);
  root.append(big, spinner, badge, error, bar);
  return { big, toggle, mute, full, seek, seekRoot: seek.parentElement, time, badge, error };
}
