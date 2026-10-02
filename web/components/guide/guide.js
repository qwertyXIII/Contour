// «Как подключить»: что настроить на устройстве, чтобы оно ходило через Contour, —
// по сценарию (телевизор, телефон дома, всё через сервер, вся сеть, вне дома,
// программы). Сценарии — данными (`scenarios.js`), адрес сервера и имя панели —
// из состояния; выбранный сценарий помнит браузер.
import { toast } from '../../utils/api.js';
import { EVENTS } from '../../utils/constants.js';
import { copyText } from '../../utils/copy.js';
import { h, svgIcon } from '../../utils/dom.js';
import { scenarios } from './scenarios.js';

const KEY = 'contour:guide';
const remembered = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const remember = (id) => { try { localStorage.setItem(KEY, id); } catch { /* приватное окно — не помним */ } };

/** Значения шага парами, у каждого — «Скопировать». */
function values(kv) {
  return h('dl', { class: 'kv' }, kv.flatMap(([key, value]) => [
    h('dt', { class: 'kv__key', text: key }),
    // Многострочное (правило со своим разделом) — блоком: копируется с переносом строки.
    h('dd', { class: 'kv__value cluster cluster_gap_s cluster_nowrap' }, h(value.includes('\n') ? 'pre' : 'code', { class: value.includes('\n') ? 'code code_block' : 'code', text: value }),
      h('button', { class: 'button button_view_ghost button_shape_round button_size_s', type: 'button', 'aria-label': `Скопировать ${key}`, dataset: { guideCopy: value } }, svgIcon('copy', 'button__icon'))),
  ]));
}

/** Шаг: номер в подложке, заголовок, текст, значения. */
function step(s, i) {
  return h('li', { class: 'list__item' }, h('article', { class: 'card stack stack_gap_s' },
    h('div', { class: 'row row_align_start' },
      h('span', { class: 'row__lead' }, h('span', { class: 'glyph glyph_tone_accent glyph_shape_round', 'aria-hidden': 'true' }, h('span', { class: 'text text_style_small', text: String(i + 1) }))),
      h('div', { class: 'row__body' }, h('span', { class: 'row__title', text: s.title }), h('span', { class: 'row__note', text: s.text }))),
    s.kv ? values(s.kv) : null));
}

function callout(tone, icon, title, text) {
  return h('div', { class: `callout callout_tone_${tone}` }, svgIcon(icon, 'callout__icon'),
    h('div', { class: 'callout__body' }, h('p', { class: 'callout__title', text: title }), h('p', { class: 'callout__text', text })));
}

export class Guide {
  #root;
  #picker;
  #body;
  #state = { a: '192.168.0.50', panel: 'vpn.home' };
  #id = remembered() ?? 'tv';
  #shown = '';

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#picker = h('div', { class: 'cluster cluster_gap_s', role: 'radiogroup', 'aria-label': 'Что подключаем' });
    this.#body = h('div', { class: 'stack stack_gap_l' });
    const head = h('header', { class: 'bar bar_size_s' }, h('span', { class: 'glyph glyph_tone_accent' }, svgIcon('route')),
      h('div', { class: 'bar__text' }, h('h2', { class: 'bar__title', text: 'Как подключить' }), h('p', { class: 'bar__subtitle', text: 'что настроить на устройстве, чтобы оно ходило через Contour' })));
    this.#root.append(head, this.#picker, this.#body);
    this.#picker.addEventListener('change', (e) => {
      if (e.target.name !== 'guide') return;
      this.#id = e.target.value;
      remember(this.#id);
      this.#render();
    });
    this.#root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-guide-copy]');
      if (b) void copyText(b.dataset.guideCopy).then((ok) => toast(ok ? `Скопировано: ${b.dataset.guideCopy}` : 'Не скопировалось — выдели и скопируй вручную', ok ? 'ok' : 'danger'));
    });
    document.addEventListener(EVENTS.state, (e) => {
      const lan = e.detail?.lan;
      if (lan) this.#state = { a: lan.address, panel: lan.panelName };
      this.#render();
    });
    this.#render();
    return this;
  }

  #render() {
    const list = scenarios(this.#state);
    const current = list.find((s) => s.id === this.#id) ?? list[0];
    const key = `${this.#state.a}|${this.#state.panel}|${current.id}`;
    if (key === this.#shown) return;
    this.#shown = key;
    this.#picker.replaceChildren(...list.map((s) => h('label', { class: 'chip' },
      h('input', { class: 'chip__input visually-hidden', type: 'radio', name: 'guide', value: s.id, checked: s.id === current.id }),
      svgIcon(s.icon), s.title)));
    this.#body.replaceChildren(
      h('p', { class: 'text text_tone_muted', text: current.lead }),
      h('ol', { class: 'list list_view_cards' }, current.steps.map(step)),
      current.warn ? callout('warn', 'power', 'Если сервер выключен', current.warn) : null,
      current.note ? callout('info', 'flag', 'На заметку', current.note) : null,
      h('p', { class: 'text text_style_small text_tone_faint', text: `Панель дома: http://${this.#state.panel} или http://${this.#state.a}` }));
  }
}
