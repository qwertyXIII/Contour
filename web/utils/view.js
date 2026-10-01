// Обновление на месте вместо пересборки.
//
// Панель спрашивает сервер раз в 2 с. Разметка собирается один раз; дальше
// меняются только значения — и только если они правда другие. Пересборка всего
// раздела на каждый тик сбрасывала бы наведение и фокус, рвала бы нажатие
// посередине и заставляла бы браузер пересчитывать всю страницу.
import { h, svgIcon } from '/shared/utils/dom.js';

/** Текст — только если другой: одинаковое значение узел не трогает. */
export function setText(node, text) {
  const t = text ?? '';
  if (node.textContent !== t) node.textContent = t;
}

export function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

/** Класс целиком — только если другой (тон значка, тон бейджа). */
export function setClass(node, value) {
  if (node.getAttribute('class') !== value) node.setAttribute('class', value);
}

/**
 * Список по ключу: новые пункты создаются, бывшие обновляются на месте,
 * ушедшие убираются; порядок — как в данных, узел двигается, только если
 * стоит не на своём месте. `make(item)` → `{ el, update(item) }`.
 */
export class Keyed {
  #box;
  #key;
  #make;
  #views = new Map();

  constructor(box, key, make) {
    this.#box = box;
    this.#key = key;
    this.#make = make;
  }

  get size() {
    return this.#views.size;
  }

  render(items) {
    const seen = new Set();
    let prev = null;
    for (const item of items) {
      const k = this.#key(item);
      seen.add(k);
      let view = this.#views.get(k);
      if (!view) {
        view = this.#make(item);
        this.#views.set(k, view);
      }
      view.update(item);
      const want = prev ? prev.nextSibling : this.#box.firstChild;
      if (want !== view.el) this.#box.insertBefore(view.el, want);
      prev = view.el;
    }
    for (const [k, view] of this.#views) {
      if (!seen.has(k)) {
        view.el.remove();
        this.#views.delete(k);
      }
    }
  }
}

/** Значок на подложке, у которого меняется только тон. */
export function glyphView(icon) {
  const el = h('span', { class: 'glyph' }, svgIcon(icon));
  return { el, tone: (tone) => setClass(el, tone ? `glyph glyph_tone_${tone}` : 'glyph') };
}

/** Бейдж: текст и тон меняются на месте. */
export function badgeView() {
  const text = document.createTextNode('');
  const el = h('span', { class: 'badge' }, h('span', { class: 'badge__dot', 'aria-hidden': 'true' }), text);
  return {
    el,
    set(value, tone) {
      setText(text, value);
      setClass(el, tone ? `badge badge_tone_${tone}` : 'badge');
    },
  };
}

/** Строка «значок · заголовок и пояснение · справа · хвост» с узлами для обновления. */
export function rowView(icon, trail = null) {
  const lead = icon ? glyphView(icon) : null;
  const title = h('span', { class: 'row__title' });
  const note = h('span', { class: 'row__note' });
  const meta = h('span', { class: 'row__meta' });
  const el = h('div', { class: 'row' },
    lead ? h('span', { class: 'row__lead' }, lead.el) : null,
    h('div', { class: 'row__body' }, title, note),
    meta,
    trail ? h('span', { class: 'row__trail' }, trail) : null);
  return {
    el,
    set({ title: t, note: n, meta: m, tone }) {
      setText(title, t);
      setText(note, n);
      setHidden(note, !n);
      setText(meta, m);
      setHidden(meta, !m);
      lead?.tone(tone);
    },
  };
}

/**
 * Раздел со списком в карточке и пустым состоянием вместо него.
 * `make(item)` → `{ el, update(item) }` — строка внутри пункта списка.
 */
export function listSection(key, make, emptyCard) {
  const ul = h('ul', { class: 'list' });
  const card = h('div', { class: 'card' }, ul);
  const keyed = new Keyed(ul, key, (item) => {
    const inner = make(item);
    return { el: h('li', { class: 'list__item' }, inner.el), update: inner.update };
  });
  const el = h('div', {}, card, emptyCard);
  return {
    el,
    render(items) {
      keyed.render(items);
      setHidden(card, items.length === 0);
      setHidden(emptyCard, items.length > 0);
    },
  };
}
