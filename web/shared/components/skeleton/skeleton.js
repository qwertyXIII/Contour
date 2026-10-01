// Заготовки из настоящей разметки: блок или экран с aria-busy="true" через
// SKELETON.delayMs становится своей заготовкой — текст полосами, картинки и
// значки серыми коробками, аватары и превью серыми формами. Снял aria-busy —
// всё вернулось. Пока идёт загрузка, область inert: заготовку не нажать.
//
// Один на страницу: следит за атрибутом во всём документе, поэтому область
// может стать занятой когда угодно — хозяину достаточно поставить атрибут.
//
// Если заготовка успела показаться, содержимое не подменяет её рывком, а
// проявляется по очереди — в том порядке, в каком его читают.
import { SKELETON } from '../../utils/constants.js';
import { appear } from '../../utils/motion.js';

const BUSY = '[aria-busy="true"]';

export class Skeletons {
  #root;
  #timers = new WeakMap();
  #marked = new WeakMap();

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#root.querySelectorAll(BUSY).forEach((zone) => this.#busy(zone));
    new MutationObserver((records) => records.forEach((record) => {
      if (record.type === 'attributes') this.#sync(record.target);
      else record.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.matches(BUSY)) this.#busy(node);
        node.querySelectorAll(BUSY).forEach((zone) => this.#busy(zone));
      });
    })).observe(this.#root, { attributes: true, attributeFilter: ['aria-busy'], childList: true, subtree: true });
    return this;
  }

  #sync(zone) {
    if (zone.getAttribute('aria-busy') === 'true') this.#busy(zone);
    else this.#done(zone);
  }

  #busy(zone) {
    if (this.#timers.has(zone) || this.#marked.has(zone)) return;
    this.#timers.set(zone, setTimeout(() => {
      this.#timers.delete(zone);
      if (zone.getAttribute('aria-busy') === 'true') this.#mark(zone);
    }, SKELETON.delayMs));
  }

  #done(zone) {
    clearTimeout(this.#timers.get(zone));
    this.#timers.delete(zone);
    const marked = this.#marked.get(zone);
    if (!marked) return;
    marked.forEach(([el, kind]) => el.classList.remove(SKELETON.base, kind));
    zone.inert = false;
    this.#marked.delete(zone);
    appear(outermost(marked.map(([el]) => el)), { order: true });
  }

  // Обойти область: форма целиком — и не глубже; картинка и значок — коробка;
  // элемент со своим текстом — полосы.
  #mark(zone) {
    const marked = [];
    const add = (el, kind) => {
      if (el.classList.contains(SKELETON.base)) return;
      el.classList.add(SKELETON.base, kind);
      marked.push([el, kind]);
    };
    const walk = (el) => {
      if (el.matches(SKELETON.skip) || el.hidden) return;
      if (el.matches(SKELETON.shapes)) {
        add(el, SKELETON.shape);
        return;
      }
      if (el.matches(SKELETON.mediaTags)) {
        add(el, SKELETON.media);
        return;
      }
      if ([...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) add(el, SKELETON.text);
      [...el.children].forEach(walk);
    };
    [...zone.children].forEach(walk);
    zone.inert = true;
    this.#marked.set(zone, marked);
  }
}

// Проявлять только внешние: строка внутри уже проявляющейся карточки иначе
// поднялась бы дважды.
function outermost(els) {
  return els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
}
