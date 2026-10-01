// Появление по очереди: область с data-reveal показывает свои части одну за
// другой — экран «Предложения», который система собрала только что, вид в
// голосовом режиме, который собирается в такт речи. Части — дети области;
// ребёнок со своим data-reveal раскрывается в своих детей (так виджеты сетки
// идут каждый в свой черёд, а не сеткой целиком).
//
//   data-reveal (или ="once") — один раз, когда область впервые на экране;
//   data-reveal="always"      — каждый раз, как область снова приходит на экран
//                               (экран пейджера, на который вернулись);
//   data-reveal="manual"      — когда скажет хозяин: data-reveal-count="N" на
//                               области — видны первые N частей (голосовой
//                               режим: часть к своей фразе ответа). Атрибут, а
//                               не событие: хозяин ставит его сразу после
//                               вставки, а область оживает позже (микрозадачей,
//                               ADR-0009), — событие бы потерялось.
//
// Пока часть не показана, она спрятана, но место держит — вид не прыгает.
// При «меньше движения» части по экрану не прячутся (показывать нечего), а у
// manual — прячутся: когда часть появится, решает смысл, а не украшение.
import { REVEAL } from '../../utils/constants.js';
import { appear, hide, reduced } from '../../utils/motion.js';

export class Reveal {
  #root;
  #mode;
  #shown = false;
  #count = 0;

  constructor(root) {
    this.#root = root;
    this.#mode = root.dataset.reveal || 'once';
  }

  init() {
    // Вложенная область — часть внешней: её показывает та.
    if (this.#root.parentElement?.closest('[data-reveal]')) return this;
    if (this.#mode === 'manual') {
      this.#conceal(this.#parts());
      new MutationObserver(() => this.#show(this.#wanted()))
        .observe(this.#root, { attributes: true, attributeFilter: [REVEAL.countAttribute] });
      this.#show(this.#wanted());
      return this;
    }
    new IntersectionObserver(([entry]) => this.#seen(entry.isIntersecting), { threshold: REVEAL.threshold })
      .observe(this.#root);
    return this;
  }

  #parts() {
    const walk = (el) => [...el.children].flatMap((child) => (child.hasAttribute('data-reveal') ? walk(child) : [child]));
    return walk(this.#root).filter((el) => !el.hidden);
  }

  #seen(visible) {
    if (visible && !this.#shown) {
      this.#shown = true;
      appear(this.#parts(), { order: true });
    } else if (!visible && (this.#mode === 'always' || !this.#shown)) {
      this.#shown = false;
      hide(this.#parts());
    }
  }

  #wanted() {
    return Number(this.#root.getAttribute(REVEAL.countAttribute)) || 0;
  }

  // Хозяин сказал, сколько частей уже пора видеть: новые — по очереди.
  #show(count) {
    if (!Number.isFinite(count) || count <= this.#count) return;
    const fresh = this.#parts().slice(this.#count, count);
    this.#count = count;
    fresh.forEach((part) => part.style.removeProperty('visibility'));
    appear(fresh, { order: true });
  }

  #conceal(parts) {
    if (reduced()) parts.forEach((part) => { part.style.visibility = 'hidden'; });
    else hide(parts);
  }
}
