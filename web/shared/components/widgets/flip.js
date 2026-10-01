// Плавный переезд (FLIP): запомнить, где элементы были, переставить,
// и проиграть путь от старого места к новому. Прерванный на середине переезд
// продолжается с того места, где элемент виден сейчас, — без рывка.
import { WIDGETS } from '../../utils/constants.js';

const FLIP = 'widgets-flip';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Где элементы видны сейчас (с учётом идущих переездов). */
export function measure(elements) {
  return new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
}

/** Проиграть переезд с мест before на нынешние. */
export function play(before) {
  if (reduced()) return;
  before.forEach((was, element) => {
    element.getAnimations().filter((animation) => animation.id === FLIP).forEach((animation) => animation.cancel());
    if (!element.isConnected || element.hidden) return;
    const now = element.getBoundingClientRect();
    if (!now.width || !now.height) return;
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    const sx = was.width / now.width;
    const sy = was.height / now.height;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
    const animation = element.animate([
      { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: '0 0', transform: 'none' },
    ], { duration: WIDGETS.flipMs, easing: WIDGETS.flipEase });
    animation.id = FLIP;
  });
}
