// Лист снизу (блок sheet): панель разговора и вопросы и формы поверх экрана — один
// механизм, как лист «Локатора» на iPhone. Упоры (detents), перетаскивание с
// инерцией, резинка за упором, желе от скорости. Движение — пружиной обёртки
// utils/motion.js (fling): отпущенный на ходу лист продолжает с той же скоростью.
//
// Оживает на .sheet_live. Говорят с ним событиями (constants/events.js):
//   sheet:set { to, animate? } — встать на упор ('low' | 'top' | номер);
//   sheet:measure — перемерить упоры (окно, клавиатура, содержимое);
//   sheet:dismiss { value } — закрыть вопрос-лист (sheet_modal) с ответом.
// Он сообщает: sheet:change { index, open } — выбрал упор (open — верхний);
// sheet:field { up } — ход перешёл половину: у панели разговора выезжает поле.
//
// Вопрос-лист (<dialog class="… sheet_modal">) с data-sheet-open открывается сам,
// как только появился в разметке; с id — ещё и кнопкой data-dialog-open="id".
// Кнопка внутри с data-sheet-dismiss="ответ" закрывает его с этим ответом.
import { EVENTS, SHEET } from '../../utils/constants.js';
import { emit } from '../../utils/dom.js';
import { fling, reduced, stop } from '../../utils/motion.js';
import { applyLayout, jellyStep, measure, render, rubber, soften } from './geometry.js';
import { trackDrag } from './drag.js';
import { attachModal } from './modal.js';
import { watchFoot } from './foot.js';

const HANDLE_BUTTON = '.sheet__handle[role="button"]';

export class Sheet {
  #root;
  #layered;
  // Положение листа: высота видимой части в px. Его ведёт пружина (fling) или палец.
  #motion = { value: NaN };
  #layout = null;
  #index = 0;
  #jelly = 0;
  #lift = 0;
  #written = {};
  #tick = { pos: NaN, t: 0 };
  #from = 0;
  // Где лист нарисован: у перелёта пружины — мягче, чем её число (soften).
  #shown = NaN;
  #dragging = false;
  #flying = false;
  #stale = false;
  #moved = 0;
  #relaxing = false;
  #modal = null;
  #leaving = false;
  #value = '';
  #fieldUp = false;
  // Части панели разговора, которым доля пишется рядом с корнем (SHEET.followers).
  #followers = [];

  constructor(root) {
    this.#root = root;
  }

  init() {
    const root = this.#root;
    this.#layered = root.classList.contains(SHEET.class.layered);
    trackDrag(root, {
      zone: (target, kind) => this.#zone(target, kind),
      start: () => this.#grab(),
      move: (dy, v) => this.#follow(dy, v),
      end: (v) => this.#release(v),
      tap: (target) => this.#tap(target),
    });
    root.addEventListener('keydown', (event) => {
      if ((event.key !== 'Enter' && event.key !== ' ') || !event.target.matches(HANDLE_BUTTON)) return;
      event.preventDefault();
      this.#toggle();
    });
    root.addEventListener(EVENTS.sheetSet, (event) => this.#set(event.detail ?? {}));
    root.addEventListener(EVENTS.sheetMeasure, () => this.#remeasure());
    if (root.classList.contains(SHEET.class.modal)) this.#initModal();
    // Панель, видимая с первого кадра (образец витрины), — сразу по своим размерам;
    // спрятанная (приложение до привязки) досчитает упоры на первом жесте.
    else if (this.#layered) this.#measure();
    return this;
  }

  #initModal() {
    const root = this.#root;
    this.#modal = attachModal(root, {
      dismiss: (value) => this.#dismiss(value),
      lift: (px) => {
        this.#lift = px;
        if (this.#layout && Number.isFinite(this.#motion.value)) this.#draw(this.#motion.value);
      },
    });
    root.addEventListener(EVENTS.sheetDismiss, (event) => this.#dismiss(event.detail?.value ?? ''));
    // Кнопка с ответом в разметке (образцы, ответ без JS хозяина): закрыть с ним.
    root.addEventListener('click', (event) => {
      const answer = event.target.closest(SHEET.dismissAttribute);
      if (answer && root.contains(answer)) this.#dismiss(answer.dataset.sheetDismiss ?? '');
    });
    root.addEventListener('close', () => {
      stop(this.#motion);
      this.#flying = false;
      this.#leaving = false;
      root.classList.remove(SHEET.class.leaving);
    });
    if (root.id) {
      document.addEventListener('click', (event) => {
        if (event.target.closest(`[data-dialog-open="${root.id}"]`)) this.#open();
      });
    }
    if (root.hasAttribute(SHEET.openAttribute)) this.#open();
  }

  get #top() {
    return this.#layout.detents.length - 1;
  }

  get #isOpen() {
    return Boolean(this.#layout) && this.#index === this.#top;
  }

  // Откуда брать жест: ручка и шапка — всегда; тело свёрнутого листа — тоже (там
  // нечего прокручивать); тело раскрытого — только вниз от верха прокрутки.
  #zone(target, kind) {
    if (this.#leaving || !this.#root.contains(target)) return false;
    if (kind === 'pull') return !this.#layered && this.#isOpen && Boolean(target.closest(SHEET.body));
    if (target.closest(SHEET.handle)) return true;
    return !this.#layered && !this.#isOpen && Boolean(target.closest(SHEET.body));
  }

  #ensure() {
    if (this.#layered || !this.#layout) this.#measure();
    return Boolean(this.#layout);
  }

  #measure() {
    if (this.#layered) {
      this.#followers = [...this.#root.querySelectorAll(SHEET.followers)];
      // Подвал растёт (полоса файлов над полем) — лента уступает. Части приложение
      // ставит позже, чем оживает лист, поэтому — здесь, при замере, один раз на подвал.
      watchFoot(this.#root);
    }
    const layout = measure(this.#root);
    if (!layout) return;
    this.#layout = layout;
    this.#index = Math.min(this.#index, this.#top);
    applyLayout(this.#root, layout);
  }

  #grab() {
    if (!this.#ensure()) return;
    stop(this.#motion);
    this.#flying = false;
    // Перехватили на лету — с того места, где лист виден, а не где его число.
    const seen = Number.isFinite(this.#shown) ? this.#shown : this.#layout.detents[this.#index];
    this.#motion.value = seen;
    this.#from = seen;
    this.#dragging = true;
    this.#root.classList.add(SHEET.class.dragging);
  }

  // Палец ушёл на dy: за верхним упором — резинка; за нижним вопрос-лист идёт за
  // пальцем как есть (его можно смахнуть), панель — резинкой.
  #follow(dy, v) {
    if (!this.#dragging) return;
    const { detents } = this.#layout;
    const low = detents[0];
    const top = detents.at(-1);
    const raw = this.#from - dy;
    let pos = raw;
    if (raw > top) pos = top + rubber(raw - top, window.innerHeight);
    else if (raw < low && !this.#modal) pos = low + rubber(raw - low, window.innerHeight);
    this.#jelly = reduced() ? 0 : jellyStep(this.#jelly, -v);
    this.#motion.value = pos;
    this.#moved = performance.now();
    const p = this.#draw(pos);
    this.#field(p > SHEET.fieldAt);
    this.#relax();
  }

  // Палец замер — событий нет, и желе застыло бы растянутым: пока держат, оно
  // само сходит на нет по кадрам. Цикл — только пока есть что гасить.
  #relax() {
    if (this.#relaxing) return;
    this.#relaxing = true;
    requestAnimationFrame(() => {
      this.#relaxing = false;
      if (!this.#dragging || Math.abs(this.#jelly) < SHEET.jelly.rest) return;
      if (performance.now() - this.#moved > SHEET.jelly.idleMs) {
        this.#jelly = jellyStep(this.#jelly, 0);
        this.#draw(this.#motion.value);
      }
      this.#relax();
    });
  }

  // Отпустили: смахнули быстрее flick — к следующему упору по направлению (за
  // нижним у вопроса — закрыть); медленно — к ближнему.
  #release(v) {
    if (!this.#dragging) return;
    this.#dragging = false;
    this.#root.classList.remove(SHEET.class.dragging);
    if (this.#stale) this.#remeasure();
    const speed = -v;
    const pos = this.#motion.value;
    const { detents } = this.#layout;
    if (this.#modal && pos < detents[0]) {
      const far = detents[0] - pos > detents[0] * SHEET.dismissShare;
      if (far || speed < -SHEET.flick) this.#dismiss('', speed);
      else this.#go(0, speed);
      return;
    }
    let index;
    if (speed > SHEET.flick) {
      index = detents.findIndex((d) => d > pos + 1);
      if (index < 0) index = this.#top;
    } else if (speed < -SHEET.flick) {
      index = detents.findLastIndex((d) => d < pos - 1);
      if (index < 0 && this.#modal) { this.#dismiss('', speed); return; }
      index = Math.max(0, index);
    } else {
      index = detents.reduce((best, d, i) => (Math.abs(d - pos) < Math.abs(detents[best] - pos) ? i : best), 0);
    }
    this.#go(index, speed);
  }

  // Нажатие — только по ручке (как у листов iOS): шапка тянет, но не переключает.
  #tap(target) {
    if (target.closest(SHEET.interactive) && !target.matches(HANDLE_BUTTON)) return;
    if (!target.closest(SHEET.grip)) return;
    this.#toggle();
  }

  // Нажатие по ручке: панель — открыть или закрыть, лист с двумя упорами — на другой.
  #toggle() {
    if (!this.#ensure() || this.#layout.detents.length < 2) return;
    this.#go(this.#isOpen ? 0 : this.#top);
  }

  /** Выбрать упор: классы и события — сразу (решение принято), движение — пружиной. */
  #decide(index) {
    this.#index = index;
    const open = index === this.#top;
    this.#root.classList.toggle(SHEET.class.open, open);
    this.#root.querySelector(HANDLE_BUTTON)?.setAttribute('aria-expanded', String(open));
    this.#field(open);
    emit(this.#root, EVENTS.sheetChange, { index, open });
  }

  #go(index, speed = 0, spring = 'bouncy') {
    const velocity = Math.max(-SHEET.maxFling, Math.min(SHEET.maxFling, speed));
    this.#decide(index);
    const target = this.#layout.detents[index];
    this.#tick = { pos: this.#motion.value, t: performance.now() };
    this.#flying = true;
    return fling(this.#motion, target, (pos) => this.#step(pos), { spring, velocity }).then((done) => {
      if (!done) return;
      this.#flying = false;
      this.#jelly = 0;
      this.#draw(target);
    });
  }

  // Кадр пружины: желе — от её собственной скорости, поэтому отскок у упора
  // дрожит сам (растянулся — сжался), без отдельной анимации.
  #step(pos) {
    const now = performance.now();
    const dt = now - this.#tick.t;
    if (dt > 0 && Number.isFinite(this.#tick.pos) && !reduced()) this.#jelly = jellyStep(this.#jelly, (pos - this.#tick.pos) / dt);
    this.#tick = { pos, t: now };
    this.#draw(soften(pos, this.#layout, { below: !this.#leaving }));
    if (this.#leaving && pos <= this.#offscreen() * 0.5) this.#closeNow();
  }

  #draw(pos) {
    this.#shown = pos;
    return render(this.#root, this.#layout, { pos, jelly: this.#jelly, lift: this.#lift }, this.#written, this.#followers);
  }

  #field(up) {
    if (!this.#layered || up === this.#fieldUp) return;
    this.#fieldUp = up;
    this.#root.classList.toggle(SHEET.class.fieldUp, up);
    emit(this.#root, EVENTS.sheetField, { up });
  }

  #set({ to = 'low', animate = true }) {
    const measured = this.#ensure();
    const last = measured ? this.#top : 1;
    const index = to === 'top' ? last : to === 'low' ? 0 : Math.max(0, Math.min(last, Number(to) || 0));
    if (!measured) {
      // Спрятанный лист: мерить нечего — встаёт долей хода, упоры досчитает жест.
      stop(this.#motion);
      this.#flying = false;
      this.#index = index;
      this.#root.classList.toggle(SHEET.class.open, index === last);
      this.#field(index === last);
      this.#root.style.setProperty('--sheet-p', index === last ? '1' : '0');
      for (const el of this.#root.querySelectorAll(SHEET.followers)) el.style.setProperty('--sheet-p', index === last ? '1' : '0');
      this.#root.style.transform = '';
      this.#written = {};
      this.#motion.value = NaN;
      this.#shown = NaN;
      return;
    }
    if (animate) {
      this.#go(index, 0, 'soft');
      return;
    }
    stop(this.#motion);
    this.#flying = false;
    this.#decide(index);
    this.#jelly = 0;
    this.#motion.value = this.#layout.detents[index];
    this.#draw(this.#motion.value);
  }

  // Окно, клавиатура или содержимое сменились: упоры заново. Посреди жеста — после
  // него, иначе лист прыгнул бы под пальцем.
  #remeasure() {
    if (this.#dragging) { this.#stale = true; return; }
    this.#stale = false;
    const before = this.#layout?.detents.join();
    this.#measure();
    if (!this.#layout || this.#leaving || before === this.#layout.detents.join()) return;
    // Упоры сдвинулись: идущий ход и вопрос доезжают пружиной, стоящая панель — сразу.
    if (this.#flying || this.#modal) {
      this.#go(this.#index, 0, 'soft');
      return;
    }
    const target = this.#layout.detents[this.#index];
    this.#motion.value = target;
    this.#draw(target);
  }

  /** Где лист целиком за нижним краем: видимая часть ушла на её высоту, зазор и запас. */
  #offscreen() {
    const gap = parseFloat(getComputedStyle(this.#root).getPropertyValue('--sheet-gap')) || 0;
    return -(gap + SHEET.offscreenPad);
  }

  #open() {
    if (!this.#modal || (this.#root.open && !this.#leaving)) return;
    this.#leaving = false;
    this.#root.classList.remove(SHEET.class.leaving);
    this.#modal.open();
    // Прошлое открытие могло оставить растяжение — мерить по нему нельзя.
    this.#root.style.transform = '';
    this.#written = {};
    this.#layout = null;
    this.#index = 0;
    this.#measure();
    if (!this.#layout) return;
    this.#jelly = 0;
    this.#motion.value = this.#offscreen();
    this.#draw(this.#motion.value);
    this.#go(0);
  }

  #dismiss(value, velocity = 0) {
    if (!this.#modal || this.#leaving || !this.#root.open) return;
    this.#leaving = true;
    this.#value = value;
    this.#root.classList.add(SHEET.class.leaving);
    if (!this.#layout) { this.#closeNow(); return; }
    this.#tick = { pos: this.#motion.value, t: performance.now() };
    const speed = Math.max(-SHEET.maxFling, Math.min(SHEET.maxFling, velocity));
    fling(this.#motion, this.#offscreen(), (pos) => this.#step(pos), { spring: 'soft', velocity: speed })
      .then((done) => { if (done) this.#closeNow(); });
  }

  // Лист ушёл за край — закрыть, не дожидаясь, пока пружина успокоится совсем.
  #closeNow() {
    if (!this.#leaving) return;
    stop(this.#motion);
    this.#modal.close(this.#value);
  }
}
