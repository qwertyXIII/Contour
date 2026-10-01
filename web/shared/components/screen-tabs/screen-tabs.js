// Пилюли экранов над чатом. Пейджер — другой блок (screens), связь — через
// aria-controls и события: нажали пилюлю — screens:show на пейджер; пейджер
// листают — бегунок едет следом по дробной позиции (screens:scroll), на смене
// экрана отмечается его пилюля (screens:change).
//
// Всё, что видно, — от одной дробной позиции (#place): где бегунок, какой он
// ширины, насколько он накрыл каждую пилюлю (цвет надписи — долей, --tab-cover) и
// куда прокручен ряд, если пилюль больше, чем влезает. Пока экран ведут пальцем,
// позиция — пейджера, и бегунок, надписи и лента идут за пальцем непрерывно.
// Отпустили палец или нажали пилюлю — позиция сама доезжает до экрана упругой
// пружиной (utils/motion.js, fling — с разгона пальца), а за пейджером бегунок
// снова идёт, когда тот доехал, когда его взяли пальцем или повели в другую
// сторону (тачпад, клавиши, код).
//
// «+» — screen-tabs:add, долгое нажатие на пилюлю — screen-tabs:edit (когда палец
// уже отпущен): что делать с набором экранов, решает хозяин.
import { EVENTS, SCREENS } from '../../utils/constants.js';
import { emit, h } from '../../utils/dom.js';
import { fling, stop } from '../../utils/motion.js';
import { longPress } from '../../utils/long-press.js';

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

export class ScreenTabs {
  #root;
  #pager;
  #thumb;
  /** Где пейджер (дробный номер экрана) и где нарисован бегунок. */
  #progress = 0;
  #shown = 0;
  #flight = null;
  #drag = null;
  #release = null;
  /** Пилюли и их места в ряду — читаются на перестройке и смене размеров, не на кадре. */
  #boxes = [];
  #row = { scroll: 0, width: 0, content: 0 };
  #rowTouched = false;
  #sizes;
  #watched = new Set();

  constructor(root) {
    this.#root = root;
    this.#pager = document.getElementById(root.getAttribute('aria-controls') ?? '');
    this.#thumb = h('span', { class: 'screen-tabs__thumb', 'aria-hidden': 'true' });
  }

  init() {
    const root = this.#root;
    root.prepend(this.#thumb);
    root.classList.add(SCREENS.enhanced);
    root.addEventListener('change', (event) => {
      if (event.target.matches('.screen-tabs__input')) this.#show(Number(event.target.value));
    });
    root.addEventListener('click', (event) => {
      if (event.target.closest('.screen-tabs__add')) emit(root, EVENTS.screenTabsAdd);
    });
    longPress(root, {
      selector: '.screen-tabs__tab',
      // Засчитано — пилюля приподнимается; держат выбранную — вместе с бегунком.
      onHold: (tab) => {
        tab.classList.add(SCREENS.held);
        root.classList.toggle(SCREENS.heldCurrent, this.#tabs().indexOf(tab) === Math.round(this.#shown));
      },
      onPress: (tab) => {
        tab.classList.remove(SCREENS.held);
        root.classList.remove(SCREENS.heldCurrent);
        const index = this.#tabs().indexOf(tab);
        if (index >= 0) emit(root, EVENTS.screenTabsEdit, { index });
      },
    });
    document.addEventListener(EVENTS.screensScroll, (event) => {
      if (event.target === this.#pager) this.#follow(event.detail.progress);
    });
    document.addEventListener(EVENTS.screensChange, (event) => {
      if (event.target === this.#pager) this.#select(event.detail.index);
    });
    this.#listenPager();
    // Ряд листают пальцем сами — лента за бегунком не тянется, пока палец на ней.
    root.addEventListener('touchstart', () => { this.#rowTouched = true; }, { passive: true });
    ['touchend', 'touchcancel'].forEach((type) => root.addEventListener(type, () => { this.#rowTouched = false; }, { passive: true }));
    root.addEventListener('scroll', () => {
      this.#row.scroll = root.scrollLeft;
      this.#fade();
    }, { passive: true });
    // Размер пилюли меняется и без перестройки ряда: переименовали — буквы сменились.
    this.#sizes = new ResizeObserver(() => this.#measure());
    this.#sizes.observe(root);
    // Ряд пересобран (экран завели, удалили, переименовали): бегунок — под новой
    // пилюлей. Ширина ряда при этом может не смениться — ряд уже во всю ширину.
    new MutationObserver(() => this.#measure()).observe(root, { childList: true });
    this.#progress = this.#checkedIndex();
    this.#measure();
    return this;
  }

  /** Палец на пейджере: бегунок идёт за ним; отпустили — доезжает пружиной. */
  #listenPager() {
    const pager = this.#pager;
    if (!pager) return;
    pager.addEventListener('touchstart', () => {
      this.#land();
      this.#release = null;
      this.#drag = [];
    }, { passive: true });
    ['touchend', 'touchcancel'].forEach((type) => pager.addEventListener(type, () => this.#letGo(), { passive: true }));
    // Мышь и перо листают без касания — пейджер взяли посреди перелёта, бегунок снова за ним.
    pager.addEventListener('pointerdown', (event) => { if (event.pointerType !== 'touch') this.#land(); }, { passive: true });
  }

  /** Пилюли, кроме уходящих (их буквы ещё улетают, а экрана уже нет). */
  #tabs() {
    return [...this.#root.querySelectorAll('.screen-tabs__tab')].filter((tab) => !tab.classList.contains(SCREENS.leaving));
  }

  #checkedIndex() {
    return Math.max(0, this.#tabs().findIndex((tab) => tab.querySelector('.screen-tabs__input')?.checked));
  }

  // Места пилюль, ширина ряда — раз на перестройку, чтобы кадр ничего не мерил.
  #measure() {
    const root = this.#root;
    const tabs = this.#tabs();
    // Следить за размером каждой пилюли; ушедшие — отпустить. Повторное observe
    // того же узла молчит, новое — даст ещё один вызов сюда, и только один.
    for (const tab of this.#watched) {
      if (!tabs.includes(tab)) {
        this.#sizes.unobserve(tab);
        this.#watched.delete(tab);
      }
    }
    for (const tab of tabs) {
      if (this.#watched.has(tab)) continue;
      this.#sizes.observe(tab);
      this.#watched.add(tab);
    }
    this.#boxes = tabs.map((tab) => ({ label: tab.querySelector('.screen-tabs__label'), x: tab.offsetLeft, w: tab.offsetWidth, cover: -1 }));
    this.#row = { scroll: root.scrollLeft, width: root.clientWidth, content: root.scrollWidth };
    this.#place(this.#flight ? this.#shown : this.#progress);
    this.#fade();
  }

  // Пилюль больше, чем влезает, — край, за которым есть ещё, затухает.
  #fade() {
    const { scroll, width, content } = this.#row;
    this.#root.classList.toggle(SCREENS.fadeStart, scroll > 1);
    this.#root.classList.toggle(SCREENS.fadeEnd, scroll + width < content - 1);
  }

  #show(index) {
    this.#fly(index);
    if (this.#pager) emit(this.#pager, EVENTS.screensShow, { index });
    else this.#progress = index;
  }

  /**
   * Бегунок — на дробной позиции: между двумя соседними пилюлями по дробной
   * части. Чуть за крайними (пружина перелетела) — продолжает их шаг.
   */
  #place(p) {
    this.#shown = p;
    const boxes = this.#boxes;
    if (!boxes.length) return;
    const i = clamp(Math.floor(p), 0, Math.max(0, boxes.length - 2));
    const f = boxes.length > 1 ? clamp(p - i, -SCREENS.overshoot, 1 + SCREENS.overshoot) : 0;
    const a = boxes[i];
    const b = boxes[i + 1] ?? a;
    const x = a.x + (b.x - a.x) * f;
    const w = a.w + (b.w - a.w) * f;
    // На сам бегунок, а не на корень ряда: переменная на корне каждый кадр
    // пересчитывала бы стили всех пилюль (handbook системы, «Производительность»).
    const style = this.#thumb.style;
    style.setProperty('--thumb-x', `${x}px`);
    style.setProperty('--thumb-w', `${w}px`);
    // Цвет надписи — долей, на которую её накрыл бегунок: текст не прыгает с пилюли на пилюлю.
    for (const box of boxes) {
      const cover = box.w > 0 ? clamp((Math.min(x + w, box.x + box.w) - Math.max(x, box.x)) / box.w, 0, 1) : 0;
      const rounded = Math.round(cover * 100) / 100;
      if (rounded === box.cover) continue;
      box.cover = rounded;
      box.label?.style.setProperty('--tab-cover', String(rounded));
    }
    this.#reveal(x, w);
  }

  // Бегунок не уезжает за край ряда: лента едет следом, когда он у края, — с запасом
  // в полпилюли, чтобы соседняя была видна и было понятно, что можно листать дальше.
  #reveal(x, w) {
    const row = this.#row;
    if (this.#rowTouched || row.content <= row.width) return;
    const room = w / 2;
    let left = row.scroll;
    if (x - room < left) left = x - room;
    else if (x + w + room > left + row.width) left = x + w + room - row.width;
    left = clamp(left, 0, row.content - row.width);
    if (Math.abs(left - row.scroll) < 0.5) return;
    row.scroll = left;
    this.#root.scrollLeft = left;
  }

  /** Долететь до пилюли пружиной — от того места, где бегунок сейчас; `velocity` — разгон пальца. */
  #fly(index, velocity = 0) {
    if (!this.#boxes[index]) return;
    const state = this.#flight?.state ?? { value: this.#shown };
    state.value = this.#shown;
    const flight = { index, done: false, gap: Math.abs(this.#progress - index), state };
    this.#flight = flight;
    fling(state, index, (p) => this.#place(p), { spring: 'bouncy', velocity }).then((done) => {
      if (!done || this.#flight !== flight) return;
      flight.done = true;
      this.#follow(this.#progress);
      // Пейджер так и не доехал и стоит — не ждать его вечно.
      setTimeout(() => {
        if (this.#flight === flight) this.#land();
      }, SCREENS.settleMs);
    });
  }

  #land() {
    if (!this.#flight) return;
    stop(this.#flight.state);
    this.#flight = null;
    this.#place(this.#progress);
  }

  #select(index) {
    const input = this.#tabs()[index]?.querySelector('.screen-tabs__input');
    if (input) input.checked = true;
  }

  // Пока бегунок летит сам, позиция пейджера только запоминается; за пейджером
  // бегунок снова едет, когда долетел и тот доехал до того же экрана.
  #follow(progress) {
    this.#progress = progress;
    this.#drag?.push([progress, performance.now()]);
    if (this.#release) this.#aim(progress);
    if (this.#flight) {
      const flight = this.#flight;
      const gap = Math.abs(progress - flight.index);
      // Пейджер удаляется от цели — его ведёт кто-то другой, бегунок за ним.
      const away = gap > flight.gap + SCREENS.arrived;
      flight.gap = Math.min(flight.gap, gap);
      if (away || (flight.done && gap < SCREENS.arrived)) this.#land();
      return;
    }
    this.#place(progress);
  }

  /** Палец отпустили: разгон — по последним кадрам жеста; куда доедет, скажет первый сдвиг. */
  #letGo() {
    const samples = this.#drag;
    this.#drag = null;
    if (!samples?.length) return;
    const [p1, t1] = samples.at(-1);
    const early = samples.findLast(([, t]) => t1 - t >= SCREENS.velocityMs) ?? samples[0];
    const velocity = t1 > early[1] ? (p1 - early[0]) / (t1 - early[1]) : 0;
    const release = { at: p1, velocity };
    this.#release = release;
    // Встал ровно на экран — ехать некуда.
    setTimeout(() => { if (this.#release === release) this.#release = null; }, SCREENS.releaseMs);
  }

  // Прилипание (scroll-snap) везёт пейджер к соседнему экрану или назад — к какому,
  // видно по первому сдвигу после отпускания. Туда бегунок и летит.
  #aim(progress) {
    const { at, velocity } = this.#release;
    const moved = progress - at;
    if (Math.abs(moved) < SCREENS.arrived / 2) return;
    this.#release = null;
    const last = this.#boxes.length - 1;
    const index = clamp(moved > 0 ? Math.ceil(at) : Math.floor(at), 0, last);
    this.#fly(index, Math.sign(velocity) === Math.sign(moved) ? velocity : 0);
  }
}
