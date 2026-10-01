// Лента медиа: какая плитка сейчас в центре, счётчик «3 / 12», точки, стрелки
// и клавиатура. Листает сам браузер (scroll-snap) — здесь только следим за
// прокруткой и помогаем стрелками.
import { MEDIA, QUERIES } from '../../utils/constants.js';
import { h, svgIcon } from '../../utils/dom.js';

export class Carousel {
  #root;
  #track;
  #items;
  #count;
  #dots = [];
  #prev;
  #next;
  #index = -1;
  #frame = 0;

  constructor(root, track, items) {
    this.#root = root;
    this.#track = track;
    this.#items = items;
  }

  mount() {
    if (this.#items.length > 1) this.#buildChrome();
    this.#track.addEventListener('scroll', () => this.#schedule(), { passive: true });
    this.#track.addEventListener('keydown', (event) => this.#onKey(event));
    // Сменилась ширина — остаться на той же плитке, без езды.
    new ResizeObserver(() => this.go(Math.max(this.#index, 0), { instant: true })).observe(this.#track);
    this.#update();
    return this;
  }

  /** Встать на плитку: после просмотра, со стрелки, с клавиатуры. */
  go(index, { instant = false, focus = false } = {}) {
    const item = this.#items[Math.max(0, Math.min(index, this.#items.length - 1))];
    if (!item) return;
    const left = item.offsetLeft - (this.#track.clientWidth - item.offsetWidth) / 2;
    const smooth = !instant && !window.matchMedia(QUERIES.reducedMotion).matches;
    this.#track.scrollTo({ left, behavior: smooth ? 'smooth' : 'instant' });
    if (focus) item.focus({ preventScroll: true });
  }

  #buildChrome() {
    const total = this.#items.length;
    this.#count = h('span', { class: 'media__count', 'aria-hidden': 'true' });
    this.#prev = this.#navButton('prev', 'chevron-left', MEDIA.labels.prev, -1);
    this.#next = this.#navButton('next', 'chevron-right', MEDIA.labels.next, 1);
    this.#root.append(this.#count, this.#prev, this.#next);
    if (total <= MEDIA.dotsMax) {
      this.#dots = this.#items.map(() => h('span', { class: 'media__dot' }));
      this.#root.append(h('span', { class: 'media__dots', 'aria-hidden': 'true' }, this.#dots));
    }
  }

  // Стрелки — для мыши; с клавиатуры листают стрелками внутри ленты, поэтому
  // кнопки вне порядка Tab: иначе каждая лента добавляла бы две лишние остановки.
  #navButton(dir, icon, label, step) {
    return h('button', {
      class: `button button_view_media button_shape_round button_size_s media__nav media__nav_dir_${dir}`,
      type: 'button',
      tabindex: '-1',
      'aria-label': label,
      on: { click: () => this.go(this.#index + step) },
    }, svgIcon(icon, 'button__icon'));
  }

  #onKey(event) {
    const moves = { ArrowLeft: this.#index - 1, ArrowRight: this.#index + 1, Home: 0, End: this.#items.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    this.go(moves[event.key], { focus: true });
  }

  #schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#update();
    });
  }

  // Текущая — та, чей центр ближе к центру ленты.
  #update() {
    const center = this.#track.scrollLeft + this.#track.clientWidth / 2;
    let index = 0;
    let nearest = Infinity;
    this.#items.forEach((item, i) => {
      const distance = Math.abs(item.offsetLeft + item.offsetWidth / 2 - center);
      if (distance < nearest) [index, nearest] = [i, distance];
    });
    if (index === this.#index) return;
    this.#index = index;
    if (this.#count) this.#count.textContent = MEDIA.counter(index + 1, this.#items.length);
    this.#dots.forEach((dot, i) => dot.classList.toggle(MEDIA.dotCurrent, i === index));
    if (this.#prev) this.#prev.disabled = index === 0;
    if (this.#next) this.#next.disabled = index === this.#items.length - 1;
  }
}
