// Своя полоса прокрутки поверх нативной: прокручивает по-прежнему браузер,
// здесь — облик полосы, ручка, которую можно тянуть, и подпись «где мы».
//
// Подпись — из меток в содержимом: любой элемент с data-scroll-label
// (заголовок буквы, дня, месяца). Показывается метка, выше которой уже
// прокрутили, — пока тянут ручку или листают быстро (как в «Фото»); стало
// медленно или ручку отпустили — тает через SCROLLER.tellMs, даже если
// прокрутка ещё идёт. Полоса — своя: тает через idleMs после последнего движения.
//
// scroller_page — полоса для прокрутки всей страницы: блок пустой, вид —
// сам документ, метки — по всей странице, кроме тех, что внутри других
// прокручиваемых областей со своей полосой.
import { SCROLLER } from '../../utils/constants.js';
import { h } from '../../utils/dom.js';

export class Scroller {
  #root;
  #view;
  #bar;
  #thumb;
  #label;
  #markers = [];
  #idle = 0;
  #hush = 0;
  #frame = 0;
  #drag = null;
  #last = { top: 0, at: 0 };
  #page;
  #pending = 0;

  constructor(root) {
    this.#root = root;
    this.#page = root.classList.contains(SCROLLER.page);
    this.#view = this.#page ? document.scrollingElement : root.querySelector('.scroller__view');
  }

  init() {
    if (!this.#view) return this;
    this.#thumb = h('span', { class: 'scroller__thumb' });
    this.#bar = h('div', { class: 'scroller__bar', 'aria-hidden': 'true' }, this.#thumb);
    this.#label = h('span', { class: 'scroller__label', 'aria-hidden': 'true' });
    this.#root.append(this.#bar, this.#label);
    this.#root.classList.add(SCROLLER.enhanced);
    // Прокрутку документа слышит окно, а не сам scrollingElement.
    (this.#page ? window : this.#view).addEventListener('scroll', () => this.#onScroll(), { passive: true });
    this.#thumb.addEventListener('pointerdown', (event) => this.#grab(event));
    this.#bar.addEventListener('pointerdown', (event) => this.#jump(event));
    if (this.#page) this.#view.style.scrollbarWidth = 'none';
    this.#watch();
    this.#measure();
    return this;
  }

  // Окно или содержимое сменили размер (подгрузились картинки, добавились
  // строки) — пересчитать ручку и где стоят метки; не чаще раза за кадр.
  #watch() {
    const refresh = () => {
      if (this.#pending) return;
      this.#pending = requestAnimationFrame(() => {
        this.#pending = 0;
        this.#measure();
      });
    };
    const content = this.#page ? document.body : this.#view;
    const sizes = new ResizeObserver(refresh);
    // Ушедших детей — отпустить: наблюдатель держит узел, пока за ним следит, и
    // вид, чьё содержимое меняется целиком (экраны панели одного навигатора),
    // иначе копил бы в памяти каждое прежнее содержимое.
    let watched = new Set();
    const watch = () => {
      const now = new Set([this.#view, ...content.children]);
      watched.forEach((el) => { if (!now.has(el)) sizes.unobserve(el); });
      now.forEach((el) => { if (!watched.has(el)) sizes.observe(el); });
      watched = now;
    };
    watch();
    // Свои узлы полосы — не содержимое. Полоса всей страницы лежит в том же body,
    // и без этого фильтра запись подписи будила наблюдателя, тот — пересчёт, пересчёт —
    // снова подпись: петля на каждый кадр, пока страница открыта (грело телефон).
    const own = (node) => this.#bar.contains(node) || this.#label.contains(node);
    new MutationObserver((records) => {
      if (records.every((record) => own(record.target))) return;
      watch();
      refresh();
    }).observe(content, { childList: true, subtree: true });
  }

  #measure() {
    const origin = (this.#page ? 0 : this.#view.getBoundingClientRect().top) - this.#view.scrollTop;
    const scope = this.#page ? document : this.#view;
    this.#markers = [...scope.querySelectorAll('[data-scroll-label]')]
      .filter((el) => !this.#page || !el.closest('.scroller__view'))
      .map((el) => ({ top: el.getBoundingClientRect().top - origin, text: el.dataset.scrollLabel }))
      .sort((a, b) => a.top - b.top);
    this.#layout();
  }

  #onScroll() {
    this.#root.classList.add(SCROLLER.active);
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.#rest(), SCROLLER.idleMs);
    this.#tellIfFast();
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#layout();
    });
  }

  #rest() {
    if (this.#drag) return;
    clearTimeout(this.#hush);
    this.#root.classList.remove(SCROLLER.active, SCROLLER.telling);
  }

  // Подпись видна, пока её держат: быстрое листание продлевает, тянущий палец —
  // держит сам; отпустили или стало медленно — тает через tellMs.
  #tell() {
    if (!this.#markers.length) return;
    this.#root.classList.add(SCROLLER.telling);
    this.#fadeLabel();
  }

  #fadeLabel() {
    clearTimeout(this.#hush);
    this.#hush = setTimeout(() => {
      if (!this.#drag) this.#root.classList.remove(SCROLLER.telling);
    }, SCROLLER.tellMs);
  }

  // Быстро листают — подпись видна и без ручки: иначе не понять, куда улетели.
  // Скорость — от точки не ближе speedWindowMs назад, а не между соседними
  // событиями: на телефоне они приходят пачками, почти без промежутка, и деление
  // на такой промежуток делало «быстрым» любое движение — подпись горела всё время,
  // пока листают. Пока окно не набралось, время считается целым окном: быстрое
  // заметно сразу, дрожь — нет.
  #tellIfFast() {
    const now = performance.now();
    const { scrollTop, clientHeight } = this.#view;
    const span = now - this.#last.at;
    const screens = Math.abs(scrollTop - this.#last.top) / (clientHeight || 1);
    if (screens / (Math.max(span, SCROLLER.speedWindowMs) / 1000) > SCROLLER.fastScreensPerSec) this.#tell();
    if (span >= SCROLLER.speedWindowMs) this.#last = { top: scrollTop, at: now };
  }

  #layout() {
    const { scrollTop, scrollHeight, clientHeight } = this.#view;
    const still = scrollHeight <= clientHeight + 1;
    this.#root.classList.toggle(SCROLLER.still, still);
    if (still) return;
    const track = this.#bar.clientHeight;
    const size = Math.max(SCROLLER.minThumb, (track * clientHeight) / scrollHeight);
    const top = ((track - size) * scrollTop) / (scrollHeight - clientHeight);
    // Положение ручки — на полосе и подписи, а не на корне: корень — предок всего
    // содержимого, и переменная на нём пересчитывала бы стили каждого узла внутри
    // на каждом кадре прокрутки (книга на 500 человек — ~160 мс кадра при ×4).
    for (const el of [this.#bar, this.#label]) {
      el.style.setProperty('--thumb-size', `${size}px`);
      el.style.setProperty('--thumb-top', `${top}px`);
    }
    // «Где мы» — раздел, чей заголовок уже вошёл в верхнюю четверть экрана.
    const edge = scrollTop + clientHeight * SCROLLER.readAt;
    const current = this.#markers.filter((marker) => marker.top <= edge).at(-1) ?? this.#markers[0];
    // Та же строка — не трогать: запись textContent заменяет узел даже без перемены.
    const text = current?.text ?? '';
    if (this.#label.textContent !== text) this.#label.textContent = text;
  }

  // Тянут ручку: прокрутка следует за пальцем в масштабе «дорожка → содержимое».
  // Не основная кнопка ручку не берёт: правая открывает меню, и отпускания
  // страница не увидит. Второй палец, пока тянут первым, — тоже.
  #grab(event) {
    if (event.button !== 0 || this.#drag) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      this.#thumb.setPointerCapture(event.pointerId);
    } catch {
      // Указателя уже нет (отпустили раньше, чем дошло событие) — жест доведут события окна.
    }
    const { scrollHeight, clientHeight, scrollTop } = this.#view;
    const track = this.#bar.clientHeight - this.#thumb.offsetHeight;
    this.#drag = { y: event.clientY, top: scrollTop, ratio: track > 0 ? (scrollHeight - clientHeight) / track : 0 };
    this.#root.classList.add(SCROLLER.dragging, SCROLLER.active);
    if (this.#markers.length) this.#root.classList.add(SCROLLER.telling);
    clearTimeout(this.#hush);
    // Жест слушает окно, а не ручку: захват указателя бывает потерян или не встаёт
    // вовсе, и тогда движение и отпускание приходят другому узлу. Ручка их не
    // слышала — жест не кончался, и полоса с подписью оставались на экране навсегда.
    const gesture = new AbortController();
    const own = (e) => e.pointerId === event.pointerId;
    const move = (e) => {
      if (own(e)) this.#view.scrollTop = this.#drag.top + (e.clientY - this.#drag.y) * this.#drag.ratio;
    };
    const end = (e) => {
      if (!own(e)) return;
      gesture.abort();
      this.#drag = null;
      this.#root.classList.remove(SCROLLER.dragging);
      this.#fadeLabel();
      clearTimeout(this.#idle);
      this.#idle = setTimeout(() => this.#rest(), SCROLLER.idleMs);
    };
    const options = { signal: gesture.signal };
    window.addEventListener('pointermove', move, options);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(type, end, options);
  }

  // Нажали на дорожку мимо ручки — встать так, чтобы середина ручки пришла под палец.
  #jump(event) {
    if (event.target === this.#thumb) return;
    const box = this.#bar.getBoundingClientRect();
    const size = this.#thumb.offsetHeight;
    const share = Math.max(0, Math.min(1, (event.clientY - box.top - size / 2) / (box.height - size)));
    this.#view.scrollTop = share * (this.#view.scrollHeight - this.#view.clientHeight);
  }
}
