// Вертикальный ползунок (и горизонтальная таблетка). Значение живёт в
// нативном range: клавиатура и скринридер работают с ним. Здесь — облик
// (--fader-value) и палец. У таблетки палец двигает значение относительно
// места касания, как в пункте управления iOS; у тонкой дорожки — прыгает к пальцу.
import { FADER } from '../../utils/constants.js';

export class Fader {
  #root;
  #input;
  #track;
  #output;
  #vertical;
  #relative;
  #bipolar;
  #drag = null;

  constructor(root) {
    this.#root = root;
    this.#input = root.querySelector('.fader__input');
    this.#track = root.querySelector('.fader__track');
    this.#output = root.querySelector('.fader__value');
    this.#vertical = !root.classList.contains('fader_horizontal');
    this.#relative = !root.classList.contains('fader_view_track');
    this.#bipolar = root.classList.contains('fader_bipolar');
  }

  init() {
    if (!this.#input || !this.#track) return this;
    if (this.#vertical) this.#input.setAttribute('aria-orientation', 'vertical');
    this.#input.addEventListener('input', () => this.#sync());
    this.#track.addEventListener('pointerdown', (event) => this.#start(event));
    this.#track.addEventListener('pointermove', (event) => this.#move(event));
    this.#track.addEventListener('pointerup', () => this.#end());
    this.#track.addEventListener('pointercancel', () => this.#end());
    this.#sync();
    return this;
  }

  #range() {
    const min = Number(this.#input.min || 0);
    const max = Number(this.#input.max || 100);
    const step = Number(this.#input.step) || 1;
    return { min, max, step, span: max - min || 1 };
  }

  #share() {
    const { min, span } = this.#range();
    return (Number(this.#input.value) - min) / span;
  }

  #pointerShare(event, rect) {
    return this.#vertical
      ? 1 - (event.clientY - rect.top) / rect.height
      : (event.clientX - rect.left) / rect.width;
  }

  #start(event) {
    if (this.#input.disabled) return;
    event.preventDefault();
    // Захват — чтобы палец, ушедший за край, продолжал тянуть. Не вышел — тянем без него.
    try {
      this.#track.setPointerCapture(event.pointerId);
    } catch {
      // указатель уже отпущен или синтетический
    }
    this.#input.focus({ preventScroll: true });
    const rect = this.#track.getBoundingClientRect();
    this.#drag = { rect, from: this.#share(), origin: this.#pointerShare(event, rect) };
    this.#root.classList.add(FADER.dragging);
    if (!this.#relative) this.#apply(this.#drag.origin);
  }

  #move(event) {
    if (!this.#drag) return;
    const now = this.#pointerShare(event, this.#drag.rect);
    this.#apply(this.#relative ? this.#drag.from + (now - this.#drag.origin) : now);
  }

  #end() {
    if (!this.#drag) return;
    this.#drag = null;
    this.#root.classList.remove(FADER.dragging);
    this.#input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  #apply(share) {
    const { min, max, step, span } = this.#range();
    const raw = min + Math.min(Math.max(share, 0), 1) * span;
    const value = Math.min(max, Math.max(min, Math.round((raw - min) / step) * step + min));
    if (Number(this.#input.value) === value) return;
    this.#input.value = String(value);
    this.#input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Ноль где-то внутри диапазона: заливка — отрезок от нуля до значения.
  #syncBipolar(share) {
    const { min, span } = this.#range();
    const zero = Math.min(Math.max((0 - min) / span, 0), 1);
    this.#root.style.setProperty('--fader-zero', String(zero));
    this.#root.style.setProperty('--fader-start', String(Math.min(share, zero)));
    this.#root.style.setProperty('--fader-size', String(Math.abs(share - zero)));
  }

  #sync() {
    const share = this.#share();
    const text = `${this.#input.value}${this.#input.dataset.unit ?? ''}`;
    this.#root.style.setProperty('--fader-value', String(share));
    if (this.#bipolar) this.#syncBipolar(share);
    this.#root.classList.toggle(FADER.covered, share >= FADER.coverAt);
    this.#input.setAttribute('aria-valuetext', text);
    if (this.#output) this.#output.textContent = text;
  }
}
