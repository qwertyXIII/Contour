// Бесконечное CSS-движение, которого не видно, стоит: подвижные значки «всегда»,
// блик заготовок, точки «думает», спиннеры, полосы загрузки, пульс бейджа —
// всё, что крутится без конца. Один слой на страницу, блоки о нём не знают.
//
// Замер 2026-09-30 (витрина, телефон в безголовом Chrome, без замедления): ~180
// таких анимаций, все вне экрана, держали главный поток занятым на ~50% в простое —
// браузер пересчитывает стиль, раскладку и отрисовку анимированного каждый кадр,
// видно его или нет. На паузе — 0,2%. Это и был нагрев телефона (вместе с петлёй
// полосы прокрутки).
//
// Как: за элементом бесконечной анимации следит IntersectionObserver. Ушёл с экрана —
// строка animation-play-state: paused в style, вернулся — строка снята. Строка
// сильнее любого сокращения animation: в блоках, а снятая возвращает решение CSS:
// очередь плеера сама ставит эквалайзеру паузу, и её не перебить. Web Animations
// (pause()) для этого не годятся: после них браузер перестаёт слушать
// animation-play-state из CSS. Исключение — движение псевдоэлемента (волна метки
// «я» на карте): до него строка style не достаёт, ему — pause()/play(); своей
// CSS-паузы у таких в системе нет.
//
// Кого ставить на учёт — разбор раз за кадр, одним document.getAnimations(): при
// запуске и после animationstart / animationcancel (события только просят разбор).
// Разбирать каждое событие своим el.getAnimations() стоило витрине ~2,8 с при
// первом открытии (×4): такой вызов обходит все анимации документа, а событий при
// загрузке сотни. В кадре стиль всё равно считается — чтение ничего не добавляет.
//
// Запаса у края нет: вошедшее в окно пойдёт в том же кадре, а в полосе «чуть за
// краем» (замерено с 200 px) блик и значки держали поток на ~45%.
// Конечные анимации не трогаются — кто-то ждёт их finished (значки, появление).
// В фоне браузер кадров не рисует вовсе, отдельной паузы по visibilitychange не нужно.
// «Меньше движения» решает CSS блоков: здесь только «не видно — не крутить».
import { UNSEEN_MOTION } from '../../utils/constants.js';

const endless = (animation) => animation.effect?.getComputedTiming().iterations === Infinity;

export class UnseenMotion {
  #root;
  #observer = null;
  #watched = new WeakSet();
  // Хозяин → бесконечные анимации его псевдоэлементов; видно ли его сейчас.
  #pseudo = new WeakMap();
  #seen = new WeakMap();
  #cancelled = new Set();
  #pending = false;

  constructor(root = document) {
    this.#root = root;
  }

  init() {
    this.#observer = new IntersectionObserver((entries) => entries.forEach((entry) => this.#toggle(entry)),
      { rootMargin: UNSEEN_MOTION.margin });
    this.#root.addEventListener('animationstart', () => this.#soon(), true);
    this.#root.addEventListener('animationcancel', (event) => {
      this.#cancelled.add(event.target);
      this.#soon();
    }, true);
    this.#soon();
    return this;
  }

  #soon() {
    if (this.#pending) return;
    this.#pending = true;
    requestAnimationFrame(() => {
      this.#pending = false;
      this.#sweep();
    });
  }

  #sweep() {
    const found = new Map();
    for (const animation of document.getAnimations()) {
      const target = animation.effect?.target;
      if (!target || !endless(animation)) continue;
      const pseudo = found.get(target) ?? [];
      if (animation.effect.pseudoElement) pseudo.push(animation);
      found.set(target, pseudo);
    }
    found.forEach((pseudo, el) => {
      this.#pseudo.set(el, pseudo);
      if (this.#seen.get(el) === false) pseudo.forEach((animation) => pause(animation));
      if (this.#watched.has(el)) return;
      this.#watched.add(el);
      this.#observer.observe(el);
    });
    // Бесконечного на элементе больше нет (сняли класс, убрали узел) — не следить.
    this.#cancelled.forEach((el) => {
      if (!found.has(el)) this.#forget(el);
    });
    this.#cancelled.clear();
  }

  #toggle({ target, isIntersecting }) {
    if (!target.isConnected) {
      this.#forget(target);
      return;
    }
    this.#seen.set(target, isIntersecting);
    target.style.animationPlayState = isIntersecting ? '' : 'paused';
    this.#pseudo.get(target)?.forEach((animation) => (isIntersecting ? play(animation) : pause(animation)));
  }

  #forget(el) {
    if (!this.#watched.has(el)) return;
    this.#watched.delete(el);
    this.#observer.unobserve(el);
    this.#pseudo.delete(el);
    this.#seen.delete(el);
    el.style.animationPlayState = '';
  }
}

// Только свою паузу снимать и только идущее ставить: play() у отменённой CSS-анимации
// запустил бы её снова, уже без CSS.
function pause(animation) {
  if (animation.playState === 'running') animation.pause();
}

function play(animation) {
  if (animation.playState === 'paused') animation.play();
}
