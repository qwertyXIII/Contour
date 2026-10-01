// Лента на пружинках (messages_springy), как «Сообщения» на iPhone: каждая реплика
// висит на своей пружине у своего места; листают — реплика сдвигается вслед за
// прокруткой на долю, пропорциональную расстоянию до пальца (у пальца — вровень, чем
// дальше — тем больше отстаёт, ровно, без насыщения), и мягкая пружина (1 Гц)
// возвращает её на место. Лента тянется, как резина, и расходится между репликами.
//
// Только прокрутка человеком (касание, колесо и инерция после них): лента, которая
// сама доехала до конца (пришёл ответ), не пружинит. Двигается свойство `translate`,
// а не `transform`: тот занят у реплик своими движениями (голос в панели, ADR-0072
// Alter'а) — свойства складываются. Раскладку не трогает: отступы только рисуются.
import { MESSAGES } from '../../utils/constants.js';
import { reduced } from '../../utils/motion.js';
import { Spring, frameLoop } from '../../utils/springs.js';

const S = MESSAGES.springy;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
// Пружина из частоты и затухания, как у UIKit Dynamics: k = ω², c = 2ζω.
const OMEGA = 2 * Math.PI * S.frequency;
const SPRING = { stiffness: OMEGA * OMEGA, damping: 2 * S.dampingRatio * OMEGA, rest: S.rest };

export class SpringyMessages {
  #list;
  #scroller = null;
  #top = 0;
  #anchor = null;
  #activeUntil = 0;
  #springs = new Map();
  #loop = frameLoop((dt) => this.#tick(dt));

  constructor(list) {
    this.#list = list;
  }

  init() {
    // Прокрутка не всплывает — ловим на документе и берём свою: кто лежит над лентой.
    document.addEventListener('scroll', (event) => this.#onScroll(event), { capture: true, passive: true });
    const touch = (event) => {
      if (!this.#within(event.target)) return;
      const point = event.touches?.[0];
      if (point) this.#anchor = point.clientY;
      this.#activeUntil = performance.now() + S.activeMs;
    };
    document.addEventListener('touchstart', touch, { capture: true, passive: true });
    document.addEventListener('touchmove', touch, { capture: true, passive: true });
    document.addEventListener('touchend', touch, { capture: true, passive: true });
    document.addEventListener('wheel', (event) => {
      if (!this.#within(event.target)) return;
      this.#anchor = event.clientY;
      this.#activeUntil = performance.now() + S.activeMs;
    }, { capture: true, passive: true });
    return this;
  }

  #within(target) {
    const scroller = this.#list.parentElement;
    return Boolean(scroller && target instanceof Node && scroller.contains(target));
  }

  #onScroll(event) {
    const scroller = event.target;
    if (!(scroller instanceof Element) || !scroller.contains(this.#list)) return;
    if (scroller !== this.#scroller) {
      this.#scroller = scroller;
      this.#top = scroller.scrollTop;
      return;
    }
    const top = scroller.scrollTop;
    const delta = top - this.#top;
    this.#top = top;
    if (!delta || reduced() || performance.now() > this.#activeUntil) return;
    this.#kick(scroller, delta);
  }

  /** Видимым репликам — отставание от прокрутки, по расстоянию до пальца. */
  #kick(scroller, delta) {
    const box = scroller.getBoundingClientRect();
    const anchor = this.#anchor ?? box.top + box.height / 2;
    for (let el = this.#list.lastElementChild; el; el = el.previousElementSibling) {
      // Рамка — со своим отставанием; где реплика стоит на самом деле — без него.
      const r = el.getBoundingClientRect();
      const lag = this.#springs.get(el)?.x ?? 0;
      const top = r.top - lag;
      if (top + r.height < box.top) break;
      if (top > box.bottom) continue;
      // Доля отставания — расстояние до пальца, ровно, без насыщения (не больше всей прокрутки).
      const far = Math.min(1, Math.abs(top + r.height / 2 - anchor) / S.resistance);
      if (far < 0.005) continue;
      let spring = this.#springs.get(el);
      if (!spring) {
        spring = new Spring(SPRING);
        this.#springs.set(el, spring);
      }
      spring.x = clamp(spring.x + delta * far, -S.max, S.max);
    }
    this.#loop.wake();
  }

  #tick(dt) {
    for (const [el, spring] of this.#springs) {
      const y = spring.step(dt);
      if (spring.resting || !el.isConnected) {
        el.style.translate = '';
        this.#springs.delete(el);
      } else {
        el.style.translate = `0 ${y.toFixed(2)}px`;
      }
    }
    return this.#springs.size > 0;
  }
}
