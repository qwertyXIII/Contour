// Значок с движением. Разметка та же, что у обычного значка, плюс режим:
//
//   <svg class="icon icon_motion_hover" aria-hidden="true"><use href="…/sprite.svg#bell"/></svg>
//
//   icon_motion_hover — один проход при наведении мышью, тапе или фокусе;
//   icon_motion_hold  — повторяется, пока курсор над элементом или палец прижат;
//                       отпустили — доигрывает текущий круг и встаёт;
//   icon_motion_loop  — всегда (это чистый CSS);
//   icon_motion_once  — один проход, когда значок впервые показался на экране.
//
// Через <use> стили страницы до частей символа не достают, поэтому компонент
// переносит геометрию символа внутрь svg (клоны узлов), и части двигает CSS
// элемента icon__part. Без JS значок остаётся на месте, но виден.
//
// Запускает не сам значок, а его «хозяин» — ближайшая кнопка, ссылка, строка
// с label или элемент с data-motion-host: наводят на кнопку, а оживает значок.
import { EVENTS, ICON_MOTION, ICON_SPRITE } from '../../utils/constants.js';
import { logger } from '../../utils/logger.js';
import { loadSymbols } from './symbols.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Значок оживает один раз: create() запускает его сам, а наблюдатель новых
// узлов (utils/upgrade.js) увидел бы тот же <svg> ещё раз.
const alive = new WeakSet();

export class MotionIcon {
  #root;
  #ready = Promise.resolve();
  #run = 0;
  #held = false;

  constructor(root) {
    this.#root = root;
  }

  /**
   * Значок из JS: MotionIcon.create('bell', 'hold', 'button__icon') → <svg>.
   * Оживает микрозадачей: к тому времени его уже вставили в кнопку, и хозяин
   * наведения найдётся (сразу после создания родителя у значка ещё нет).
   */
  static create(name, mode = 'hover', className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `icon icon_motion_${mode} ${className}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `${ICON_SPRITE}#${name}`);
    svg.append(use);
    queueMicrotask(() => new MotionIcon(svg).init());
    return svg;
  }

  init() {
    if (alive.has(this.#root)) return this;
    alive.add(this.#root);
    const use = this.#root.querySelector('use');
    if (use) this.#ready = this.#inline(use);
    this.#bindHost(this.#root.closest(ICON_MOTION.host) ?? this.#root);
    this.#root.addEventListener(EVENTS.iconPlay, () => this.play());
    if (this.#has(ICON_MOTION.once)) this.#ready.then(() => this.#playWhenSeen());
    return this;
  }

  /** Один проход. Повторный запуск во время прохода ничего не делает — проход доигрывается. */
  play() {
    if (this.#has(ICON_MOTION.loop) || this.#has(ICON_MOTION.playing)) return;
    this.#start();
    this.#finish(this.#animations());
  }

  #has(name) {
    return this.#root.classList.contains(name);
  }

  async #inline(use) {
    const [file, name] = (use.getAttribute('href') ?? '').split('#');
    try {
      const symbols = await loadSymbols(new URL(file || ICON_SPRITE, document.baseURI).href);
      const symbol = symbols.get(name);
      if (!symbol || !use.isConnected) return;
      const box = symbol.getAttribute('viewBox');
      if (box) this.#root.setAttribute('viewBox', box);
      this.#root.replaceChildren(...[...symbol.childNodes].map((node) => document.importNode(node, true)));
      this.#root.dataset.icon = name;
    } catch (error) {
      logger.warn('Значок остался без движения', { name, error: error.message });
    }
  }

  // pointerenter/pointerleave покрывают и мышь, и палец: у касания «вход» —
  // это прикосновение, «выход» — когда палец отпустили или увели в прокрутку.
  #bindHost(host) {
    host.addEventListener('pointerenter', () => this.#enter());
    host.addEventListener('focusin', () => this.#enter());
    host.addEventListener('pointerleave', () => this.#leave());
    host.addEventListener('focusout', () => this.#leave());
  }

  #enter() {
    if (this.#has(ICON_MOTION.hover)) this.play();
    else if (this.#has(ICON_MOTION.hold)) this.#hold();
  }

  #leave() {
    if (this.#held) this.#release();
  }

  #hold() {
    this.#held = true;
    if (!this.#has(ICON_MOTION.playing)) {
      this.#start();
      return;
    }
    // Вернулись, пока доигрывался последний круг: снова без конца.
    this.#run += 1;
    this.#animations().forEach((animation) => animation.effect?.updateTiming({ iterations: Infinity }));
  }

  // Отпустили: каждой части — доиграть круг, на котором она сейчас.
  #release() {
    this.#held = false;
    const running = this.#animations();
    running.forEach((animation) => {
      const { currentIteration } = animation.effect?.getComputedTiming() ?? {};
      animation.effect?.updateTiming({ iterations: (currentIteration ?? 0) + 1 });
    });
    this.#finish(running);
  }

  #start() {
    this.#run += 1;
    this.#root.classList.add(ICON_MOTION.playing);
  }

  #animations() {
    return this.#root.getAnimations({ subtree: true });
  }

  #finish(animations) {
    const run = this.#run;
    Promise.all(animations.map((animation) => animation.finished))
      .catch(() => {})
      .finally(() => {
        if (run === this.#run && !this.#held) this.#root.classList.remove(ICON_MOTION.playing);
      });
  }

  #playWhenSeen() {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      this.play();
    }, { threshold: ICON_MOTION.seenThreshold });
    observer.observe(this.#root);
  }
}
