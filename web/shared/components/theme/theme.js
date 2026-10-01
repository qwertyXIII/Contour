// Тема приложения: схема (авто/тёмная/светлая), плотность (авто/палец/курсор)
// и акцент. Ставит модификаторы блока theme на корень и --accent в style.
//
// Менять тему можно откуда угодно событием theme:set — компонент настроек не
// обязан знать про этот класс. Об изменении сообщает theme:change.
//
// Где помнить выбор — атрибут корня data-theme-key (по умолчанию THEME.storageKey):
// витрина и приложение живут на одном адресе, и выбор на витрине не должен
// менять тему приложения.
//
// Пока значение ещё меняется (тянут пикер цвета — theme:set с live: true), оно
// выходит на экран раз за кадр, а запоминается и объявляется theme:change, когда
// придёт то же без live (отпустили) или изменения затихнут на THEME.settleMs.
// Замер 2026-09-30: переменная на корне стоит полного пересчёта стилей документа
// (на витрине ~170 мс даже без замедления), а каждое theme:change будит тех, кто
// меряет страницу (плашка сегментов, доски токенов) — на каждое движение пальца
// выходило по несколько пересчётов, и страница вставала. Цвет по-прежнему
// следует за пальцем: применяется последнее значение каждого кадра.
import { EVENTS, THEME } from '../../utils/constants.js';
import { emit } from '../../utils/dom.js';
import { storage } from '../../utils/storage.js';

export class Theme {
  #root;
  #key;
  #state = { ...THEME.defaults };
  #frame = 0;
  #settle = 0;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#key = this.#root.dataset.themeKey || THEME.storageKey;
    this.#state = { ...THEME.defaults, ...Theme.#clean(storage.get(this.#key, {})) };
    this.#paint();
    emit(this.#root, EVENTS.themeChange, this.state);
    document.addEventListener(EVENTS.themeSet, (event) => this.set(event.detail));
    return this;
  }

  get state() {
    return { ...this.#state };
  }

  /** `patch.live` — значение ещё меняется: на экран раз за кадр, запомнить потом. */
  set(patch) {
    this.#state = { ...this.#state, ...Theme.#clean(patch) };
    if (!patch?.live) {
      this.#commit();
      return;
    }
    if (!this.#frame) {
      this.#frame = requestAnimationFrame(() => {
        this.#frame = 0;
        this.#paint();
      });
    }
    clearTimeout(this.#settle);
    this.#settle = setTimeout(() => this.#commit(), THEME.settleMs);
  }

  // Из хранилища и событий может прийти что угодно — берём только известное.
  static #clean(patch) {
    const clean = {};
    if (THEME.schemes.includes(patch?.scheme)) clean.scheme = patch.scheme;
    if (THEME.densities.includes(patch?.density)) clean.density = patch.density;
    if (typeof patch?.accent === 'string' && CSS.supports('color', patch.accent)) clean.accent = patch.accent;
    return clean;
  }

  #commit() {
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#settle);
    this.#frame = 0;
    this.#settle = 0;
    storage.set(this.#key, this.#state);
    this.#paint();
    emit(this.#root, EVENTS.themeChange, this.state);
  }

  #paint() {
    const { scheme, density, accent } = this.#state;
    this.#root.classList.add(THEME.block);
    this.#setModifier('scheme', scheme, THEME.schemes);
    this.#setModifier('density', density, THEME.densities);
    // Та же строка — не писать: пересчёт документа не нужен.
    if (this.#root.style.getPropertyValue('--accent') !== accent) this.#root.style.setProperty('--accent', accent);
  }

  // 'auto' — это отсутствие модификатора: решают система и устройство.
  #setModifier(name, value, values) {
    for (const option of values) {
      if (option === 'auto') continue;
      this.#root.classList.toggle(`${THEME.block}_${name}_${option}`, option === value);
    }
  }
}
