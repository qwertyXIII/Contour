// Пикер цвета поверх нативного <input type="color">: тот хранит значение и
// шлёт input (пока тянут) и change (отпустили) — форма и хозяин слушают его,
// как обычно. Два вида: квадрат (насыщенность × яркость + полоса оттенка) и
// круг (оттенок по кругу, насыщенность к центру + яркость ползунком).
//
// Клавиши на квадрате и круге: стрелки — шаг 1% (оттенок — 1°), с Shift — 10.
// Из кода: поставить native.value и прислать ему input — пикер встанет сам.
import { COLOR_PICKER, EVENTS } from '../../utils/constants.js';
import { emit } from '../../utils/dom.js';
import { hexToHsv, hsvToHex, normalizeHex } from '../../utils/color.js';
import { buildPicker } from './view.js';

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

export class ColorPicker {
  #root;
  #native;
  #ui;
  #wheel;
  #hsv = { h: 0, s: 1, v: 1 };
  #writing = false;

  constructor(root) {
    this.#root = root;
    this.#native = root.querySelector('.color-picker__native');
    this.#wheel = root.classList.contains(COLOR_PICKER.wheel);
  }

  init() {
    if (!this.#native) return this;
    const presets = (this.#root.dataset.presets ?? '').split(/\s+/).map(normalizeHex).filter(Boolean);
    this.#ui = buildPicker(this.#root, { wheel: this.#wheel, presets });
    this.#native.classList.add('visually-hidden');
    this.#native.tabIndex = -1;
    this.#root.classList.add(COLOR_PICKER.enhanced);
    this.#listen();
    this.#hsv = hexToHsv(this.#native.value);
    this.#render();
    return this;
  }

  #listen() {
    const { surface, hue, value, hex, drop, presets } = this.#ui;
    surface.addEventListener('pointerdown', (event) => this.#drag(event));
    surface.addEventListener('keydown', (event) => this.#onKey(event));
    hue?.addEventListener('input', () => this.#set({ h: Number(hue.value) }));
    value?.addEventListener('input', () => this.#set({ v: Number(value.value) / 100 }));
    [hue, value].forEach((input) => input?.addEventListener('change', () => this.#commit()));
    hex.addEventListener('change', () => this.#typed());
    hex.addEventListener('keydown', (event) => { if (event.key === 'Enter') this.#typed(); });
    drop?.addEventListener('click', () => this.#eyedropper());
    presets.forEach((button) => button.addEventListener('click', () => {
      this.#hsv = hexToHsv(button.dataset.color);
      this.#render();
      this.#commit();
    }));
    // Цвет поставили снаружи — встать на него.
    ['input', 'change'].forEach((type) => this.#native.addEventListener(type, () => {
      if (this.#writing) return;
      this.#hsv = hexToHsv(this.#native.value);
      this.#render();
    }));
  }

  // Палец или мышь по квадрату (кругу): цвет — под пальцем, пока держат.
  #drag(event) {
    event.preventDefault();
    const surface = this.#ui.surface;
    surface.focus({ preventScroll: true });
    try {
      surface.setPointerCapture(event.pointerId);
    } catch {
      // Указателя уже нет (отпустили раньше, чем дошло событие) — жест доведут события элемента.
    }
    const move = (e) => this.#set(this.#fromPoint(e));
    move(event);
    const end = () => {
      surface.removeEventListener('pointermove', move);
      this.#commit();
    };
    surface.addEventListener('pointermove', move);
    surface.addEventListener('pointerup', end, { once: true });
    surface.addEventListener('pointercancel', end, { once: true });
  }

  #fromPoint(event) {
    const box = this.#ui.surface.getBoundingClientRect();
    const x = clamp((event.clientX - box.left) / box.width);
    const y = clamp((event.clientY - box.top) / box.height);
    if (!this.#wheel) return { s: x, v: 1 - y };
    const dx = x - 0.5;
    const dy = y - 0.5;
    return { h: ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360, s: clamp(Math.hypot(dx, dy) * 2) };
  }

  #onKey(event) {
    const { step, bigStep, hueStep, bigHueStep } = COLOR_PICKER;
    const d = event.shiftKey ? bigStep : step;
    const dh = event.shiftKey ? bigHueStep : hueStep;
    const { h, s, v } = this.#hsv;
    const moves = this.#wheel
      ? { ArrowRight: { h: (h + dh) % 360 }, ArrowLeft: { h: (h - dh + 360) % 360 }, ArrowUp: { s: clamp(s + d) }, ArrowDown: { s: clamp(s - d) } }
      : { ArrowRight: { s: clamp(s + d) }, ArrowLeft: { s: clamp(s - d) }, ArrowUp: { v: clamp(v + d) }, ArrowDown: { v: clamp(v - d) } };
    if (!moves[event.key]) return;
    event.preventDefault();
    this.#set(moves[event.key]);
    this.#commit();
  }

  #typed() {
    const hex = normalizeHex(this.#ui.hex.value);
    if (!hex) {
      this.#render();
      return;
    }
    this.#hsv = hexToHsv(hex);
    this.#render();
    this.#commit();
  }

  async #eyedropper() {
    try {
      const { sRGBHex } = await new window.EyeDropper().open();
      this.#hsv = hexToHsv(sRGBHex);
      this.#render();
      this.#commit();
    } catch {
      // Отменили Esc — цвет остался прежним.
    }
  }

  // Во время жеста — input у нативного поля (форма видит, что меняется).
  #set(patch) {
    this.#hsv = { ...this.#hsv, ...patch };
    this.#render();
    this.#write('input');
  }

  #commit() {
    this.#write('change');
    emit(this.#root, EVENTS.colorPickerChange, { value: this.#native.value });
  }

  #write(type) {
    this.#writing = true;
    this.#native.value = hsvToHex(this.#hsv);
    this.#native.dispatchEvent(new Event(type, { bubbles: true }));
    this.#writing = false;
  }

  #render() {
    const { h, s, v } = this.#hsv;
    const hex = hsvToHex(this.#hsv);
    const [x, y] = this.#wheel
      ? [0.5 + (Math.cos((h * Math.PI) / 180) * s) / 2, 0.5 + (Math.sin((h * Math.PI) / 180) * s) / 2]
      : [s, 1 - v];
    const style = this.#root.style;
    style.setProperty('--picker-x', x.toFixed(4));
    style.setProperty('--picker-y', y.toFixed(4));
    style.setProperty('--picker-hue', hsvToHex({ h, s: 1, v: 1 }));
    style.setProperty('--picker-color', hex);
    style.setProperty('--picker-full', hsvToHex({ h, s, v: 1 }));
    const { surface, hue, value, hex: field } = this.#ui;
    surface.setAttribute('aria-valuetext', `${COLOR_PICKER.say(this.#hsv)}, ${hex}`);
    if (hue) hue.value = String(Math.round(h));
    if (value) value.value = String(Math.round(v * 100));
    if (document.activeElement !== field) field.value = hex;
  }
}
