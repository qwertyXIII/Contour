// Подтверждение жестом. Ручку ведут пальцем или мышью; довели до конца — это
// согласие, отпустили раньше — ручка возвращается. С клавиатуры согласие —
// удерживать Enter или пробел (у двусторонней — стрелку в сторону ответа):
// одно нажатие не должно запускать то, что нельзя отменить. Скринридер
// нажимает ручку как кнопку — и это тоже согласие: он уже объявил, что это.
//
// data-done / data-declined — текст после ответа; data-wait — ждать ответа
// хозяина (событие slide-confirm:finish) с текстом data-busy, пока идёт работа.
import { EVENTS, SLIDE_CONFIRM } from '../../utils/constants.js';
import { emit } from '../../utils/dom.js';
import { KeyHold } from './key-hold.js';

export class SlideConfirm {
  #root;
  #track;
  #thumb;
  #result;
  #both;
  #value = 0;
  #drag = null;
  #locked = false;
  #keys;

  constructor(root) {
    this.#root = root;
    this.#track = root.querySelector('.slide-confirm__track');
    this.#thumb = root.querySelector('.slide-confirm__thumb');
    this.#result = root.querySelector('.slide-confirm__result');
    this.#both = root.classList.contains(SLIDE_CONFIRM.both);
    this.#keys = new KeyHold({ both: this.#both, onStep: (value) => this.#set(value), onDone: (side) => this.#commit(side), onCancel: () => this.#release() });
  }

  init() {
    if (!this.#track || !this.#thumb) return this;
    this.#thumb.addEventListener('pointerdown', (event) => this.#start(event));
    this.#thumb.addEventListener('pointermove', (event) => this.#move(event));
    this.#thumb.addEventListener('pointerup', (event) => this.#end(event));
    this.#thumb.addEventListener('pointercancel', () => this.#end());
    this.#thumb.addEventListener('keydown', (event) => {
      if (this.#locked) return;
      this.#root.classList.remove(SLIDE_CONFIRM.error);
      this.#keys.down(event, this.#value);
    });
    this.#thumb.addEventListener('keyup', (event) => this.#keys.up(event));
    this.#thumb.addEventListener('click', (event) => this.#onClick(event));
    this.#track.addEventListener('pointerdown', (event) => { if (event.target === this.#track) this.#hint(); });
    this.#root.addEventListener('animationend', () => this.#root.classList.remove(SLIDE_CONFIRM.hint, SLIDE_CONFIRM.failed));
    this.#root.addEventListener(EVENTS.slideFinish, (event) => this.#finish(event.detail ?? {}));
    this.#root.addEventListener(EVENTS.slideReset, () => this.reset());
    return this;
  }

  /** Вернуть в начало: снова можно подтверждать. */
  reset() {
    this.#locked = false;
    this.#thumb.disabled = false;
    this.#root.classList.remove(SLIDE_CONFIRM.busy, SLIDE_CONFIRM.done, SLIDE_CONFIRM.decline, SLIDE_CONFIRM.error);
    this.#say('');
    this.#set(0);
  }

  #set(value) {
    this.#value = value;
    this.#root.style.setProperty('--slide', value.toFixed(4));
    if (this.#both) this.#root.classList.toggle(SLIDE_CONFIRM.decline, value < 0);
  }

  // Путь ручки в пикселях — чтобы сдвиг пальца перевести в долю. Отступ ручки
  // от края дорожки — её top: CSS ставит его тем же --slide-pad.
  #travel() {
    const width = this.#track.clientWidth;
    const thumb = this.#thumb.offsetWidth;
    const pad = parseFloat(getComputedStyle(this.#thumb).top) || 0;
    return Math.max(1, this.#both ? width / 2 - thumb / 2 - pad : width - thumb - pad * 2);
  }

  #start(event) {
    if (this.#locked || event.button > 0) return;
    event.preventDefault();
    try {
      this.#thumb.setPointerCapture(event.pointerId);
    } catch { /* синтетическое событие — тянем без захвата */ }
    this.#drag = { x: event.clientX, from: this.#value, travel: this.#travel(), moved: false };
    this.#root.classList.remove(SLIDE_CONFIRM.error);
    this.#root.classList.add(SLIDE_CONFIRM.dragging);
  }

  #move(event) {
    if (!this.#drag) return;
    const dx = event.clientX - this.#drag.x;
    if (Math.abs(dx) > SLIDE_CONFIRM.tapSlop) this.#drag.moved = true;
    const min = this.#both ? -1 : 0;
    const value = Math.min(1, Math.max(min, this.#drag.from + dx / this.#drag.travel));
    this.#set(value);
    if (Math.abs(value) >= SLIDE_CONFIRM.commitAt) this.#finishDrag(value > 0 ? 'accept' : 'decline');
  }

  #end() {
    if (!this.#drag) return;
    const { moved } = this.#drag;
    if (Math.abs(this.#value) >= SLIDE_CONFIRM.releaseAt) {
      this.#finishDrag(this.#value > 0 ? 'accept' : 'decline');
      return;
    }
    this.#drag = null;
    this.#root.classList.remove(SLIDE_CONFIRM.dragging);
    this.#release();
    if (!moved) this.#hint();
  }

  #finishDrag(side) {
    this.#drag = null;
    this.#root.classList.remove(SLIDE_CONFIRM.dragging);
    this.#commit(side);
  }

  // detail 0 и не с нашей клавиатуры — нажали вспомогательные технологии.
  #onClick(event) {
    if (event.detail !== 0 || this.#keys.active || this.#locked) return;
    this.#commit('accept');
  }

  #release() {
    if (!this.#locked) this.#set(0);
  }

  #hint() {
    if (this.#locked) return;
    this.#root.classList.remove(SLIDE_CONFIRM.hint);
    void this.#root.offsetWidth;
    this.#root.classList.add(SLIDE_CONFIRM.hint);
  }

  #commit(side) {
    if (this.#locked) return;
    this.#locked = true;
    this.#set(side === 'decline' ? -1 : 1);
    // Вибрация — только после настоящего касания: иначе браузер ругается в консоль.
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(SLIDE_CONFIRM.vibrateMs);
    const waits = side === 'accept' && 'wait' in this.#root.dataset;
    this.#root.classList.add(waits ? SLIDE_CONFIRM.busy : SLIDE_CONFIRM.done);
    this.#say(waits ? this.#root.dataset.busy : this.#doneText(side));
    if (!waits) this.#playDone();
    emit(this.#root, EVENTS.slideConfirm, { side });
  }

  #finish({ ok = true, text } = {}) {
    if (!this.#root.classList.contains(SLIDE_CONFIRM.busy)) return;
    this.#root.classList.remove(SLIDE_CONFIRM.busy);
    if (ok) {
      this.#root.classList.add(SLIDE_CONFIRM.done);
      this.#say(text ?? this.#doneText('accept'));
      this.#playDone();
      return;
    }
    // Не вышло: ручка в начале, вместо подсказки — почему. Уйдёт с новым касанием.
    this.reset();
    this.#root.classList.add(SLIDE_CONFIRM.failed, SLIDE_CONFIRM.error);
    this.#say(text ?? '');
    setTimeout(() => this.#root.classList.remove(SLIDE_CONFIRM.failed), SLIDE_CONFIRM.failedMs);
  }

  #doneText(side) {
    return side === 'decline' ? (this.#root.dataset.declined ?? '') : (this.#root.dataset.done ?? '');
  }

  #say(text) {
    if (this.#result) this.#result.textContent = text ?? '';
    this.#thumb.disabled = this.#locked;
  }

  #playDone() {
    this.#root.querySelector('.slide-confirm__icon_kind_done')?.dispatchEvent(new CustomEvent(EVENTS.iconPlay));
  }
}
