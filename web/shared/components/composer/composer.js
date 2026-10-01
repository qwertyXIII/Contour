// Строка ввода разговора: «отправить» гаснет, пока нечего отправлять; Enter и
// кнопка шлют composer:send { text, files, attachments }, микрофон — composer:voice.
// Куда уйдёт реплика, решает тот, кто слушает событие.
//
// composer_hold — поле по отправке не очищается: хозяин шлёт composer:clear, когда
// реплика ушла. Не ушла — текст остаётся в поле, набирать заново не надо
// (вмешательство в чужой разговор: отказ доставки не должен съедать написанное).
//
// Голосовое (ADR-0072 Alter'а): хозяин записывает сам и говорит строке
// composer:record { on } — она становится полосой записи (composer_recording).
// Тогда «Отправить» шлёт composer:record-send, ✕ или смахнуть полосу влево —
// composer:record-cancel. Время и волну полосы пишет хозяин: он знает запись.
//
// Файлы (скрепка в поле, attachments.js): выбранное закачивается сразу, текст в поле —
// подпись. «Отправить» гаснет, пока нечего слать или есть неушедший файл (его
// повторяют или убирают). Нажали, пока закачка идёт, — кнопка ждёт (composer_waiting,
// спиннер) и отправит сама, как только закачается всё; не ушло за это время —
// ожидание снято, решает человек. Текст берётся тот, что в поле в момент отправки.
import { ATTACH, COMPOSER, EVENTS } from '../../utils/constants.js';
import { emit, h } from '../../utils/dom.js';
import { Attachments } from './attachments.js';

const SEND_BUSY = 'button_loading';

export class Composer {
  #root;
  #control;
  #send;
  /** Файлы к реплике — только у строки со скрепкой (composer__attach). */
  #files = null;
  #waiting = false;

  constructor(root) {
    this.#root = root;
    this.#control = root.querySelector('.input__control');
    this.#send = root.querySelector('.composer__send');
  }

  init() {
    if (!this.#control) return this;
    this.#control.addEventListener('input', () => this.#changed());
    this.#root.addEventListener('submit', (event) => this.#submit(event));
    this.#root.addEventListener(EVENTS.composerClear, () => this.#clear());
    this.#root.addEventListener(EVENTS.composerRecord, (event) => this.#record(Boolean(event.detail?.on)));
    this.#root.querySelector('.composer__voice')?.addEventListener('click', () => {
      emit(this.#root, EVENTS.composerVoice);
    });
    this.#root.querySelector('.composer__cancel')?.addEventListener('click', () => this.#cancel());
    const strip = this.#root.querySelector('.composer__record');
    if (strip) this.#swipeToCancel(strip);
    if (this.#root.querySelector('.composer__attach')) this.#files = new Attachments(this.#root, () => this.#changed()).init();
    this.#sync();
    return this;
  }

  get #recording() {
    return this.#root.classList.contains(COMPOSER.recording);
  }

  get #text() {
    return this.#control.value.trim();
  }

  /** Есть что отправить, и нет неушедшего файла. */
  get #ready() {
    return (this.#text !== '' || (this.#files?.count ?? 0) > 0) && !this.#files?.failed;
  }

  #submit(event) {
    event.preventDefault();
    if (this.#recording) {
      emit(this.#root, EVENTS.composerRecordSend);
      return;
    }
    if (!this.#ready) return;
    if (this.#files?.uploading) this.#wait(true);
    else this.#dispatch();
  }

  #dispatch() {
    this.#wait(false);
    const attachments = this.#files?.sent ?? [];
    emit(this.#root, EVENTS.composerSend, { text: this.#text, files: attachments.map((item) => item.id), attachments });
    if (!this.#root.classList.contains(COMPOSER.hold)) this.#clear();
  }

  // Ждали закачку: всё закачалось — уходит; не ушло или слать стало нечего — ждать нечего.
  #changed() {
    if (this.#waiting && !this.#ready) this.#wait(false);
    else if (this.#waiting && !this.#files?.uploading) this.#dispatch();
    this.#sync();
  }

  #wait(on) {
    if (this.#waiting === on) return;
    this.#waiting = on;
    this.#root.classList.toggle(ATTACH.waiting, on);
    if (!this.#send) return;
    if (on && !this.#send.querySelector('.button__spinner')) {
      this.#send.append(h('span', { class: 'spinner button__spinner', 'aria-hidden': 'true' }));
    }
    this.#send.classList.toggle(SEND_BUSY, on);
  }

  #record(on) {
    this.#root.classList.toggle(COMPOSER.recording, on);
    // Пока пишет, клавиатуре делать нечего: поле под полосой. Ждавшая реплика — не ждёт.
    if (on) {
      this.#control.blur();
      this.#wait(false);
    }
    this.#sync();
  }

  #cancel() {
    if (this.#recording) emit(this.#root, EVENTS.composerRecordCancel);
  }

  /** Полосу записи тянут влево: едет за пальцем, дальше порога — бросить. */
  #swipeToCancel(strip) {
    let start = null;
    const reset = () => {
      strip.style.transform = '';
      strip.style.opacity = '';
      start = null;
    };
    strip.addEventListener('pointerdown', (event) => {
      if (!this.#recording || event.target.closest('.composer__cancel')) return;
      start = { x: event.clientX, id: event.pointerId };
      try { strip.setPointerCapture(event.pointerId); } catch {}
    });
    strip.addEventListener('pointermove', (event) => {
      if (!start || event.pointerId !== start.id) return;
      const dx = Math.min(0, event.clientX - start.x);
      strip.style.transform = `translateX(${dx}px)`;
      strip.style.opacity = String(Math.max(0.3, 1 + dx / (COMPOSER.cancelSwipe * 2)));
    });
    const end = (event) => {
      if (!start || event.pointerId !== start.id) return;
      const far = start.x - event.clientX > COMPOSER.cancelSwipe;
      reset();
      if (far && event.type === 'pointerup') this.#cancel();
    };
    strip.addEventListener('pointerup', end);
    strip.addEventListener('pointercancel', end);
  }

  #clear() {
    this.#control.value = '';
    this.#files?.clear();
    this.#control.dispatchEvent(new Event('input', { bubbles: true }));
  }

  #sync() {
    if (this.#send) this.#send.disabled = !this.#recording && !this.#ready;
  }
}
