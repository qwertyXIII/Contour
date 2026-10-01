// Удержание клавиши вместо жеста: пока держат Enter, пробел или стрелку,
// ручка сама едет к краю; отпустили раньше — возвращается. Одно короткое
// нажатие ничего не подтверждает.
import { SLIDE_CONFIRM } from '../../utils/constants.js';

const ACCEPT = ['Enter', ' ', 'ArrowRight'];

export class KeyHold {
  #both;
  #onStep;
  #onDone;
  #onCancel;
  #frame = 0;
  #key = null;
  active = false;

  constructor({ both, onStep, onDone, onCancel }) {
    this.#both = both;
    this.#onStep = onStep;
    this.#onDone = onDone;
    this.#onCancel = onCancel;
  }

  down(event, from) {
    const dir = this.#direction(event.key);
    if (!dir) {
      if (event.key === 'Escape') this.#stop(true);
      return;
    }
    // Своё нажатие гасим целиком, иначе Enter сработал бы как клик по кнопке.
    event.preventDefault();
    if (event.repeat || this.#key) return;
    this.#key = event.key;
    this.active = true;
    this.#run(dir, from);
  }

  up(event) {
    if (event.key !== this.#key) return;
    event.preventDefault();
    this.#stop(true);
  }

  #direction(key) {
    if (ACCEPT.includes(key)) return 1;
    if (this.#both && key === 'ArrowLeft') return -1;
    return 0;
  }

  #run(dir, from) {
    let last = performance.now();
    let value = from;
    const step = (now) => {
      value += (dir * (now - last)) / SLIDE_CONFIRM.holdMs;
      last = now;
      if (Math.abs(value) >= 1) {
        this.#stop(false);
        this.#onDone(dir > 0 ? 'accept' : 'decline');
        return;
      }
      this.#onStep(value);
      this.#frame = requestAnimationFrame(step);
    };
    this.#frame = requestAnimationFrame(step);
  }

  #stop(cancel) {
    cancelAnimationFrame(this.#frame);
    const wasRunning = this.#key !== null;
    this.#key = null;
    // Клик от отпущенной клавиши приходит следом — флаг снимаем после него.
    setTimeout(() => { this.active = false; }, 0);
    if (cancel && wasRunning) this.#onCancel();
  }
}
