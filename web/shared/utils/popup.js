// Положение всплывающей панели (блок popup) у того, у чего она открылась.
// Панель в верхнем слое браузера, position: fixed — координаты от окна.
// Снизу мало места — открывается вверх (модификатор popup_up).
import { POPUP } from './constants.js';

function horizontal(anchorRect, width, align, viewport) {
  const preferred = align === 'end' ? anchorRect.right - width : anchorRect.left;
  return Math.min(Math.max(preferred, POPUP.margin), viewport - POPUP.margin - width);
}

/**
 * Поставить панель у якоря.
 * @param {HTMLElement} popup
 * @param {HTMLElement} anchor
 * @param {{ align?: 'start'|'end', matchWidth?: boolean }} options
 */
export function placePopup(popup, anchor, { align = 'start', matchWidth = false } = {}) {
  const rect = anchor.getBoundingClientRect();
  const viewportW = document.documentElement.clientWidth;
  const viewportH = window.innerHeight;
  const natural = matchWidth ? rect.width : popup.offsetWidth;
  const width = Math.min(Math.max(natural, POPUP.minWidth), viewportW - POPUP.margin * 2);
  const below = viewportH - rect.bottom - POPUP.gap - POPUP.margin;
  const above = rect.top - POPUP.gap - POPUP.margin;
  const up = below < POPUP.flipBelow && above > below;

  popup.classList.toggle('popup_up', up);
  popup.style.width = matchWidth ? `${width}px` : '';
  popup.style.left = `${horizontal(rect, width, align, viewportW)}px`;
  popup.style.maxHeight = `${Math.max(POPUP.minHeight, Math.min(up ? above : below, POPUP.maxHeight))}px`;
  popup.style.top = up ? 'auto' : `${rect.bottom + POPUP.gap}px`;
  popup.style.bottom = up ? `${viewportH - rect.top + POPUP.gap}px` : 'auto';
}

/**
 * Держать панель у якоря, пока она открыта: прокрутка любого контейнера и
 * изменение окна двигают якорь. Возвращает функцию, которая перестаёт следить.
 */
export function followAnchor(popup, anchor, options) {
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => placePopup(popup, anchor, options));
  };
  window.addEventListener('scroll', update, { capture: true, passive: true });
  window.addEventListener('resize', update, { passive: true });
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('scroll', update, { capture: true });
    window.removeEventListener('resize', update);
  };
}

/** Браузер умеет popover (верхний слой, закрытие по клику мимо и Esc). */
export const supportsPopover = typeof HTMLElement !== 'undefined'
  && typeof HTMLElement.prototype.showPopover === 'function';
