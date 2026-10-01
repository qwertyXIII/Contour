// Хелперы DOM. Только createElement / setAttribute / textContent — никаких HTML-строк.
import { ICON_SPRITE } from './constants.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProp(el, key, value) {
  if (key === 'class') el.setAttribute('class', value);
  else if (key === 'text') el.textContent = value;
  else if (key === 'dataset') Object.assign(el.dataset, value);
  else if (key === 'style') Object.entries(value).forEach(([name, v]) => el.style.setProperty(name, v));
  else if (key === 'on') Object.entries(value).forEach(([type, fn]) => el.addEventListener(type, fn));
  else if (value === true) el.setAttribute(key, '');
  else el.setAttribute(key, String(value));
}

/**
 * Создать элемент: h('button', { class: 'button', type: 'button', text: 'Ок' }, ...дети).
 * Ложные значения свойств и детей пропускаются — удобно для условной разметки.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    applyProp(el, key, value);
  }
  el.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return el;
}

/** Значок из спрайта: svgIcon('check', 'button__icon'). */
export function svgIcon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${ICON_SPRITE}#${name}`);
  svg.append(use);
  return svg;
}

/**
 * Сменить значок у готового <svg class="icon">: адрес спрайта сохраняется.
 * ⚠️ У подвижного значка (icon_motion_*) MotionIcon уже перенёс геометрию
 * внутрь и <use> нет — такой не сменить. Значок, который меняется
 * (играть ↔ пауза, звук ↔ без звука), ставят без движения.
 */
export function setIcon(svg, name) {
  const use = svg?.querySelector('use');
  if (!use) return;
  const href = use.getAttribute('href') ?? '';
  use.setAttribute('href', `${href.split('#')[0]}#${name}`);
}

let lastId = 0;

/** Уникальный id для связей aria-controls / aria-activedescendant. */
export function uid(prefix = 'ui') {
  lastId += 1;
  return `${prefix}-${lastId}`;
}

/** Всплывающее событие компонента. */
export function emit(target, name, detail = {}) {
  target.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
}

/** Ближайший предок, который прокручивается; нет — страница. Звать, когда узел уже на странице. */
export function scrollParent(el) {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return document.scrollingElement;
}
