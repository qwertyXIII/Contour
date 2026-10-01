// Слой уведомлений. Любой компонент показывает уведомление событием
// toast:show { text, tone?, action?: { label, event } } — про этот класс он не знает.
// Под курсором уведомление не уходит: его дочитывают.
import { EVENTS, STATE_CLASSES, TOAST } from '../../utils/constants.js';
import { emit, h, svgIcon } from '../../utils/dom.js';

const TONE_ICONS = { ok: 'ok', danger: 'error', warn: 'warning', info: 'info' };

export class Toaster {
  #root;

  constructor(root) {
    this.#root = root;
  }

  static mount() {
    const root = h('div', { class: 'toaster', role: 'status', 'aria-live': 'polite' });
    document.body.append(root);
    return root;
  }

  init() {
    document.addEventListener(EVENTS.toastShow, (event) => this.show(event.detail));
    return this;
  }

  show({ text, tone, action } = {}) {
    if (!text) return;
    const toast = this.#build({ text, tone, action });
    this.#root.append(toast);
    this.#trim();
    this.#scheduleLeave(toast);
  }

  #build({ text, tone, action }) {
    const toast = h('div', { class: tone ? `toast toast_tone_${tone}` : 'toast' },
      svgIcon(TONE_ICONS[tone] ?? 'info', 'toast__icon'),
      h('p', { class: 'toast__text', text }));
    if (action?.label) toast.append(this.#actionButton(action, toast));
    toast.append(this.#closeButton(toast));
    return toast;
  }

  #actionButton(action, toast) {
    return h('button', {
      class: 'button button_view_ghost button_size_s toast__action',
      type: 'button',
      text: action.label,
      on: { click: () => { if (action.event) emit(toast, action.event); this.#leave(toast); } },
    });
  }

  #closeButton(toast) {
    return h('button', {
      class: 'button button_view_ghost button_size_s button_shape_round toast__close',
      type: 'button',
      'aria-label': 'Закрыть',
      on: { click: () => this.#leave(toast) },
    }, svgIcon('close', 'button__icon'));
  }

  #scheduleLeave(toast) {
    let timer = setTimeout(() => this.#leave(toast), TOAST.durationMs);
    toast.addEventListener('pointerenter', () => clearTimeout(timer));
    toast.addEventListener('pointerleave', () => {
      timer = setTimeout(() => this.#leave(toast), TOAST.durationMs / 2);
    });
  }

  #leave(toast) {
    if (!toast.isConnected) return;
    toast.classList.add(STATE_CLASSES.toastLeaving);
    setTimeout(() => toast.remove(), TOAST.leaveMs);
  }

  #trim() {
    const toasts = [...this.#root.querySelectorAll(`.toast:not(.${STATE_CLASSES.toastLeaving})`)];
    toasts.slice(0, Math.max(0, toasts.length - TOAST.max)).forEach((toast) => this.#leave(toast));
  }
}
