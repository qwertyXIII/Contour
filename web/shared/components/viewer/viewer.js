// Просмотр фото и видео во весь экран — один на страницу. Открывается
// событием media:open от блока media (со списком и номером), закрывается
// «закрыть», Esc или смахиванием вниз; на закрытии говорит открывшему блоку
// viewer:close — на чём остановились.
//
// Если открывший блок сказал, где его плитки (origin в media:open), фото
// вырастает из плитки и возвращается в неё (flight.js). Кадр фото и видео —
// сразу в пропорции снимка (item.ratio): обрезка плитки раскрывается в него, а
// превью в пропорции (item.middle) и файл подменяют друг друга без смены кадра.
//
// Хозяин сетки может дать ещё умения (media:open { fetch, outside, info, stream }):
// взять файл своего сервера (`fetch(item, адрес)` — с токеном, которого просмотр
// не знает; адрес — файл или превью в пропорции) и показать,
// что о файле, — `info(номер)` → обещание, пока открыт лист «О файле». Тянут
// вверх или нажали ⓘ — просмотр приподнимается, пока лист открыт. `stream(item)`
// → ссылка потока без токена: видео и звук браузер берёт по ней кусками, а не
// целиком в blob (видео на сотни мегабайт в памяти айфона); нет ссылки — blob.
import { EVENTS, QUERIES, VIEWER } from '../../utils/constants.js';
import { emit, h, svgIcon } from '../../utils/dom.js';
import { Flight } from './flight.js';
import { Pull } from './pull.js';
import { buildSlide, loadSlide, quietSlide } from './slides.js';
import { move } from '../../utils/motion.js';

export class Viewer {
  #dialog;
  #parts;
  #items = [];
  #slides = [];
  #index = -1;
  #source = null;
  #origin = null;
  #frame = 0;
  #flight;
  #closing = false;
  #hooks = {};
  #urls = [];
  #lifted = false;

  /** Разметка просмотра — если на странице её нет. */
  static mount() {
    const button = (className, icon, label, autofocus = false) => h('button', {
      class: `button button_view_media button_shape_round ${className}`, type: 'button', 'aria-label': label, autofocus,
    }, svgIcon(icon, 'button__icon'));
    const dialog = h('dialog', { class: 'viewer', 'aria-label': VIEWER.label },
      h('div', { class: 'viewer__shade' }),
      h('div', { class: 'viewer__track' }),
      h('div', { class: 'viewer__bar' },
        h('span', { class: 'viewer__count', 'aria-hidden': 'true' }),
        h('span', { class: 'viewer__end' },
          button('viewer__about', 'info', VIEWER.labels.info),
          // Фокус при открытии — на «закрыть»: иначе браузер отдал бы его прокручиваемой ленте.
          button('viewer__close', 'close', VIEWER.labels.close, true))),
      h('div', { class: 'viewer__foot' },
        h('p', { class: 'viewer__caption' }),
        h('p', { class: 'viewer__credit' })),
      button('viewer__nav viewer__nav_dir_prev', 'chevron-left', VIEWER.labels.prev),
      button('viewer__nav viewer__nav_dir_next', 'chevron-right', VIEWER.labels.next),
      h('p', { class: 'visually-hidden viewer__live', 'aria-live': 'polite' }));
    document.body.append(dialog);
    return dialog;
  }

  constructor(dialog) {
    this.#dialog = dialog;
    const part = (name) => dialog.querySelector(`.viewer__${name}`);
    this.#parts = {
      shade: part('shade'), track: part('track'), count: part('count'), foot: part('foot'), caption: part('caption'),
      credit: part('credit'), live: part('live'), close: part('close'), about: part('about'),
      prev: part('nav_dir_prev'), next: part('nav_dir_next'),
    };
    this.#flight = new Flight(dialog, this.#parts.shade);
  }

  init() {
    const { track, close, prev, next, about } = this.#parts;
    document.addEventListener(EVENTS.mediaOpen, (event) => this.open(event.detail, event.target));
    this.#dialog.addEventListener('close', () => this.#closed());
    // Esc закрывает тем же путём, что и кнопка: с возвратом в плитку.
    this.#dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    this.#dialog.addEventListener('keydown', (event) => this.#onKey(event));
    track.addEventListener('scroll', () => this.#schedule(), { passive: true });
    track.addEventListener('click', (event) => this.#toggleBare(event));
    track.addEventListener('pointerdown', () => this.#flight.drop());
    close.addEventListener('click', () => this.close());
    about.addEventListener('click', () => void this.#about());
    prev.addEventListener('click', () => this.go(this.#index - 1));
    next.addEventListener('click', () => this.go(this.#index + 1));
    // Повернули телефон, сменилось окно — остаться на том же слайде.
    new ResizeObserver(() => this.#jump(this.#index)).observe(track);
    new Pull(this.#dialog, track, () => this.close(), {
      can: () => Boolean(this.#hooks.info) && !this.#lifted,
      open: () => void this.#about(),
    }).mount();
    return this;
  }

  open({ items, index = 0, origin = null, fetch = null, outside = null, info = null, stream = null }, source) {
    if (!items?.length) return;
    this.#items = items;
    this.#hooks = { fetch, outside, info, stream };
    this.#parts.about.hidden = !info;
    this.#source = source;
    this.#origin = typeof origin === 'function' ? origin : null;
    this.#slides = items.map((item, i) => buildSlide(item, i, items.length));
    this.#parts.track.replaceChildren(...this.#slides);
    this.#dialog.classList.remove(VIEWER.bare);
    this.#index = -1;
    const opening = !this.#dialog.open;
    if (opening) {
      this.#dialog.classList.remove(VIEWER.appearing);
      this.#dialog.showModal();
    }
    this.#jump(index);
    this.#show(index);
    const flew = this.#flight.open(this.#origin?.(index), items[index], this.#slides[index]);
    // Проявляться самому — только если не вырос из плитки: снятый на посадке
    // полёт иначе запустил бы появление заново (весь просмотр на кадр прозрачен).
    if (opening && !flew) this.#dialog.classList.add(VIEWER.appearing);
  }

  /** Закрыть: фото возвращается в свою плитку, если её видно, иначе — сразу. */
  async close() {
    if (!this.#dialog.open || this.#closing) return;
    this.#closing = true;
    await this.#flight.close(this.#origin?.(this.#index), this.#slides[this.#index], this.#items[this.#index]);
    this.#dialog.close();
  }

  /** Листнуть на слайд — плавно, если можно. */
  go(index) {
    const target = Math.max(0, Math.min(index, this.#slides.length - 1));
    const smooth = !window.matchMedia(QUERIES.reducedMotion).matches;
    this.#parts.track.scrollTo({ left: target * this.#parts.track.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  }

  #jump(index) {
    if (index < 0 || !this.#dialog.open) return;
    this.#parts.track.scrollTo({ left: index * this.#parts.track.clientWidth, behavior: 'instant' });
  }

  #schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      const { track } = this.#parts;
      if (track.clientWidth) this.#show(Math.round(track.scrollLeft / track.clientWidth));
    });
  }

  // Текущий слайд сменился: прошлое видео — замолчать, соседей — подгрузить.
  #show(index) {
    if (index === this.#index || !this.#items[index]) return;
    if (this.#index >= 0) this.#flight.drop();
    quietSlide(this.#slides[this.#index]);
    this.#index = index;
    const hooks = { ...this.#hooks, keep: (url) => { this.#urls.push(url); return url; } };
    [index, index + 1, index - 1].forEach((i) => {
      if (this.#slides[i]) loadSlide(this.#slides[i], this.#items[i], hooks);
    });
    const item = this.#items[index];
    const total = this.#items.length;
    const { count, caption, credit, foot, live, prev, next } = this.#parts;
    count.textContent = total > 1 ? VIEWER.counter(index + 1, total) : '';
    caption.textContent = item.caption;
    credit.textContent = item.credit;
    foot.hidden = !item.caption && !item.credit;
    live.textContent = VIEWER.say(index + 1, total, item.alt);
    prev.disabled = index === 0;
    next.disabled = index === total - 1;
  }

  #onKey(event) {
    if (event.defaultPrevented || event.target.closest('input, textarea, select')) return;
    const moves = { ArrowLeft: this.#index - 1, ArrowRight: this.#index + 1, Home: 0, End: this.#items.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    this.go(moves[event.key]);
  }

  // Касание по картинке прячет и возвращает рамку; по видео и кнопкам — нет.
  #toggleBare(event) {
    if (event.target.closest('.video, button')) return;
    this.#dialog.classList.toggle(VIEWER.bare);
  }

  /**
   * «О файле»: просмотр приподнимается, рамка прячется, хозяин открывает лист;
   * лист закрылся — просмотр опускается на место. Второй раз, пока лист открыт, —
   * ничего: жест дошёл до ленты сквозь лист.
   */
  async #about() {
    if (!this.#hooks.info || this.#lifted || this.#index < 0) return;
    this.#lifted = true;
    const root = this.#dialog;
    const lift = `${-Math.round(root.clientHeight * VIEWER.liftShare)}px`;
    const from = root.style.getPropertyValue('--viewer-pull') || '0px';
    quietSlide(this.#slides[this.#index]);
    root.classList.add(VIEWER.lifted);
    void move(root, { '--viewer-pull': [from, lift] }, { spring: 'soft' });
    try {
      await this.#hooks.info(this.#index);
    } finally {
      root.classList.remove(VIEWER.lifted);
      await move(root, { '--viewer-pull': [lift, '0px'] }, { spring: 'soft' });
      root.style.removeProperty('--viewer-pull');
      this.#lifted = false;
    }
  }

  #closed() {
    this.#flight.reset();
    this.#urls.forEach((url) => URL.revokeObjectURL(url));
    this.#urls = [];
    this.#hooks = {};
    quietSlide(this.#slides[this.#index]);
    if (this.#source?.isConnected) emit(this.#source, EVENTS.viewerClose, { index: this.#index });
    this.#parts.track.replaceChildren();
    this.#slides = [];
    this.#items = [];
    this.#index = -1;
    this.#source = null;
    this.#origin = null;
    this.#closing = false;
  }
}
