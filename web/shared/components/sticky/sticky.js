// Застенчивая полка (sticky_shy): листают вниз — уезжает вверх, листают вверх
// или вернулись к началу — возвращается. Слушает прокрутку ближайшего
// прокручиваемого предка — один раз за кадр, и только переключает класс: движение
// — переходом CSS, без записи стилей на каждом кадре.
//
// Фокус внутри (набирают поиск) — полка не прячется: клавиатура и так отняла
// пол-экрана, а поле под пальцем исчезать не должно.
import { STICKY } from '../../utils/constants.js';
import { scrollParent } from '../../utils/dom.js';

export class Sticky {
  #root;
  #scroller = null;
  #last = 0;
  #frame = 0;
  #onScroll = () => this.#schedule();

  constructor(root) {
    this.#root = root;
  }

  init() {
    if (!this.#root.classList.contains(STICKY.shy)) return this;
    // Предок с прокруткой известен только в документе: компонент оживает, когда блок уже в нём.
    this.#scroller = scrollParent(this.#root);
    const target = this.#scroller === document.scrollingElement ? window : this.#scroller;
    this.#last = this.#top();
    target.addEventListener('scroll', this.#onScroll, { passive: true });
    this.#dispose = () => target.removeEventListener('scroll', this.#onScroll);
    return this;
  }

  #dispose = () => {};

  #top() {
    return this.#scroller === document.scrollingElement ? window.scrollY : this.#scroller.scrollTop;
  }

  #schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      // Полку убрали вместе с экраном — отписаться: разрушения у компонентов нет.
      if (!this.#root.isConnected) {
        this.#dispose();
        return;
      }
      this.#step();
    });
  }

  #step() {
    const top = this.#top();
    const delta = top - this.#last;
    if (Math.abs(delta) < STICKY.slop && top > STICKY.nearTop) return;
    this.#last = top;
    const typing = this.#root.contains(document.activeElement) && document.activeElement !== document.body;
    const hide = !typing && top > this.#root.offsetHeight + STICKY.nearTop && delta > 0;
    this.#root.classList.toggle(STICKY.hidden, hide);
  }
}
