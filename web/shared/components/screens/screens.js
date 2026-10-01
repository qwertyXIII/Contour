// Пейджер экранов: листает браузер (scroll-snap), здесь — только кто сейчас
// показан. Каждый кадр прокрутки сообщает дробную позицию (screens:scroll —
// по ней едет плашка пилюль), смену экрана — screens:change. Показать экран
// просят событием screens:show на сам пейджер.
//
// Не текущие экраны — inert: Tab и скринридер не уходят за край. Касание по
// ним всё равно листает — inert не мешает прокрутке родителя. Ставится, когда
// прокрутка затихла, а не на середине жеста: экран под пальцем, ставший inert
// посреди свайпа, WebKit вправе счесть ушедшим из-под касания и оборвать жест.
//
// Набор экранов хозяин может пересобрать в любой момент (завёл, удалил,
// переименовал): пейджер это видит сам и заново говорит, какой экран
// показан, — screens:scroll и screens:change приходят и без прокрутки.
import { EVENTS, QUERIES, SCREENS } from '../../utils/constants.js';
import { emit } from '../../utils/dom.js';

export class Screens {
  #root;
  #index = -1;
  #start = 0;
  #frame = 0;
  #quiet = 0;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#root.addEventListener('scroll', () => this.#schedule(), { passive: true });
    this.#root.addEventListener(EVENTS.screensShow, (event) => this.show(event.detail.index));
    // Сменилась ширина (поворот, окно) — остаться на том же экране. Пейджер,
    // который родился спрятанным (ширины ещё нет), встаёт на data-start, а не на первый.
    this.#start = Number(this.#root.dataset.start) || 0;
    // Только ширина: высота к месту вбок отношения не имеет, а её смена посреди
    // свайпа (шапка над пейджером стала ниже) ставила экран на место под пальцем —
    // экран «телепортировался» к соседу, пока палец ещё вёл его.
    let width = -1;
    new ResizeObserver(() => {
      if (this.#root.clientWidth === width) return;
      width = this.#root.clientWidth;
      this.show(this.#index >= 0 ? this.#index : this.#start, { instant: true });
    }).observe(this.#root);
    new MutationObserver(() => this.#rebuilt()).observe(this.#root, { childList: true });
    this.show(this.#start, { instant: true });
    this.#update();
    return this;
  }

  /** Экраны читаются каждый раз: хозяин может добавить новый в любой момент. */
  #pages() {
    return [...this.#root.children].filter((el) => el.classList.contains('screens__page'));
  }

  show(index, { instant = false } = {}) {
    const pages = this.#pages();
    const target = Math.max(0, Math.min(index, pages.length - 1));
    const smooth = !instant && !window.matchMedia(QUERIES.reducedMotion).matches;
    this.#root.scrollTo({ left: target * this.#root.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
    if (!instant) return;
    this.#update();
    this.#settleInert();
  }

  // Экраны пересобраны: новые страницы ещё не inert, текущего могло не стать
  // (прокрутку за укоротившийся край браузер возвращает сам — чтение её уже учитывает).
  #rebuilt() {
    this.#index = -1;
    this.#update();
    this.#settleInert();
  }

  /** inert — по текущему экрану; сразу (перестройка, показ без движения) или когда прокрутка затихла. */
  #settleInert() {
    clearTimeout(this.#quiet);
    this.#quiet = 0;
    if (this.#index < 0) return;
    this.#pages().forEach((page, i) => { page.inert = i !== this.#index; });
  }

  #schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#update();
    });
  }

  #update() {
    const width = this.#root.clientWidth;
    if (!width) return;
    const progress = this.#root.scrollLeft / width;
    emit(this.#root, EVENTS.screensScroll, { progress });
    clearTimeout(this.#quiet);
    this.#quiet = setTimeout(() => this.#settleInert(), SCREENS.quietMs);
    const index = Math.round(progress);
    if (index === this.#index) return;
    this.#index = index;
    emit(this.#root, EVENTS.screensChange, { index });
  }
}
