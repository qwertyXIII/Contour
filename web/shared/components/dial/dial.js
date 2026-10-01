// Круговой регулятор. Значение живёт в нативном range (стрелки, скринридер),
// здесь — риски, ручка и палец: угол касания от центра → доля дуги → значение.
// Касание в разрыве снизу прилипает к ближайшему краю, а не прыгает через ноль.
import { DIAL } from '../../utils/constants.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class Dial {
  #root;
  #input;
  #face;
  #output;
  #ticks = [];
  #dragging = false;

  constructor(root) {
    this.#root = root;
    this.#input = root.querySelector('.dial__input');
    this.#face = root.querySelector('.dial__face');
    this.#output = root.querySelector('.dial__value');
  }

  init() {
    if (!this.#input || !this.#face) return this;
    this.#build();
    this.#input.addEventListener('input', () => this.#sync());
    this.#face.addEventListener('pointerdown', (event) => this.#start(event));
    this.#face.addEventListener('pointermove', (event) => this.#dragging && this.#fromPointer(event));
    this.#face.addEventListener('pointerup', () => this.#end());
    this.#face.addEventListener('pointercancel', () => this.#end());
    this.#sync();
    return this;
  }

  // Риски — отрезки от внешнего края внутрь, по дуге от −135° до +135°.
  #build() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'dial__ticks');
    svg.setAttribute('viewBox', '0 0 200 200');
    for (let i = 0; i < DIAL.ticks; i += 1) {
      const angle = DIAL.start + (DIAL.sweep * i) / (DIAL.ticks - 1);
      const radians = (angle * Math.PI) / 180;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'dial__tick');
      line.setAttribute('x1', String(100 + Math.sin(radians) * DIAL.outer));
      line.setAttribute('y1', String(100 - Math.cos(radians) * DIAL.outer));
      line.setAttribute('x2', String(100 + Math.sin(radians) * DIAL.inner));
      line.setAttribute('y2', String(100 - Math.cos(radians) * DIAL.inner));
      svg.append(line);
      this.#ticks.push({ line, share: i / (DIAL.ticks - 1) });
    }
    const knob = document.createElement('span');
    knob.setAttribute('class', 'dial__knob');
    this.#face.replaceChildren(svg, knob);
  }

  #range() {
    const min = Number(this.#input.min || 0);
    const max = Number(this.#input.max || 100);
    return { min, max, step: Number(this.#input.step) || 1, span: max - min || 1 };
  }

  #start(event) {
    if (this.#input.disabled) return;
    event.preventDefault();
    try {
      this.#face.setPointerCapture(event.pointerId);
    } catch {
      // указатель уже отпущен или синтетический
    }
    this.#input.focus({ preventScroll: true });
    this.#dragging = true;
    this.#root.classList.add(DIAL.dragging);
    this.#fromPointer(event);
  }

  #end() {
    if (!this.#dragging) return;
    this.#dragging = false;
    this.#root.classList.remove(DIAL.dragging);
    this.#input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Угол от верха по часовой: 0° — вверх, ±135° — концы дуги.
  #fromPointer(event) {
    const rect = this.#face.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const clamped = Math.min(Math.max(angle, DIAL.start), DIAL.start + DIAL.sweep);
    this.#apply((clamped - DIAL.start) / DIAL.sweep);
  }

  #apply(share) {
    const { min, max, step, span } = this.#range();
    const value = Math.min(max, Math.max(min, Math.round((share * span) / step) * step + min));
    if (Number(this.#input.value) === value) return;
    this.#input.value = String(value);
    this.#input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  #sync() {
    const { min, span } = this.#range();
    const share = (Number(this.#input.value) - min) / span;
    const text = `${this.#input.value}${this.#input.dataset.unit ?? ''}`;
    this.#root.style.setProperty('--dial-angle', `${DIAL.start + DIAL.sweep * share}deg`);
    this.#ticks.forEach(({ line, share: at }) => line.classList.toggle(DIAL.activeTick, at <= share + 1e-6));
    this.#input.setAttribute('aria-valuetext', text);
    if (this.#output) this.#output.textContent = text;
  }
}
