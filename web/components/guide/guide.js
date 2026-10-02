// «Как подключить»: что настроить на устройстве, чтобы оно ходило через Contour, —
// по сценарию (телевизор, телефон дома, всё через сервер, вся сеть, вне дома,
// программы). Сценарии — данными (`scenarios.js`), адрес сервера и имя панели —
// из состояния; выбранный сценарий помнит браузер.
//
// У сценария — ролик: макет устройства, на котором курсор, палец или рамка пульта
// проходят те же шаги, что написаны рядом (reel.js — время, stage.js — макет,
// player.js — кнопки). Идёт шаг — подсвечен его текст; нажал шаг — ролик к нему.
import { toast } from '../../utils/api.js';
import { EVENTS } from '../../utils/constants.js';
import { copyText } from '../../utils/copy.js';
import { h, svgIcon } from '../../utils/dom.js';
import { reduced } from '/shared/utils/motion.js';
import { Player } from './player.js';
import { Reel } from './reel.js';
import { scenarios } from './scenarios.js';
import { screens } from './screens/index.js';
import { Stage } from './stage.js';

const KEY = 'contour:guide';
const remembered = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const remember = (id) => { try { localStorage.setItem(KEY, id); } catch { /* приватное окно — не помним */ } };

// Длиннее этого значение не влезает строкой рядом с подписью в колонке шагов.
const LONG = 28;

/** Значения шага парами, у каждого — «Скопировать». */
function values(kv) {
  // Длинное (команда) или многострочное (правило со своим разделом) — блоком под подписью:
  // переносится, а не уводит страницу вбок; копируется как есть, с переносом строки.
  const long = kv.some(([, value]) => value.includes('\n') || value.length > LONG);
  return h('dl', { class: `kv${long ? ' kv_layout_stack' : ''}` }, kv.flatMap(([key, value]) => [
    h('dt', { class: 'kv__key', text: key }),
    h('dd', { class: 'kv__value cluster cluster_gap_s cluster_nowrap' }, h(long ? 'pre' : 'code', { class: long ? 'code code_block' : 'code', text: value }),
      h('button', { class: 'button button_view_ghost button_shape_round button_size_s', type: 'button', 'aria-label': `Скопировать ${key}`, dataset: { guideCopy: value } }, svgIcon('copy', 'button__icon'))),
  ]));
}

/** Шаг: номер в подложке, заголовок, текст — кнопкой «к этому шагу ролика»; значения ниже. */
function step(s, i) {
  const number = h('span', { class: 'glyph glyph_tone_accent glyph_shape_round', 'aria-hidden': 'true' }, h('span', { class: 'text text_style_small', text: String(i + 1) }));
  const card = h('article', { class: 'card stack stack_gap_s reel__step', dataset: { guideStep: String(i) } },
    h('button', { class: 'reel__goto', type: 'button' },
      h('span', { class: 'row row_align_start' },
        h('span', { class: 'row__lead' }, number),
        h('span', { class: 'row__body' }, h('span', { class: 'row__title', text: s.title }), h('span', { class: 'row__note', text: s.text })),
        h('span', { class: 'visually-hidden', text: ' — показать в ролике' }))),
    s.kv ? values(s.kv) : null);
  return { li: h('li', { class: 'list__item' }, card), card, number };
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
  #player = null;
  #steps = [];

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
      if (b) {
        void copyText(b.dataset.guideCopy).then((ok) => toast(ok ? `Скопировано: ${b.dataset.guideCopy}` : 'Не скопировалось — выдели и скопируй вручную', ok ? 'ok' : 'danger'));
        return;
      }
      // Нажали шаг (не выделяя текст) — ролик к этому шагу.
      const card = e.target.closest('[data-guide-step]');
      if (!card || window.getSelection()?.toString()) return;
      this.#player?.seek(Number(card.dataset.guideStep), true);
      // На телефоне ролик над списком — уехал из вида: показать его, иначе перемотку не увидеть.
      const scene = this.#root.querySelector('.scene');
      const box = scene?.getBoundingClientRect();
      if (box && (box.bottom < 0 || box.top > window.innerHeight * 0.6)) scene.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
    });
    document.addEventListener(EVENTS.state, (e) => {
      const lan = e.detail?.lan;
      if (lan) this.#state = { a: lan.address, panel: lan.panelName };
      this.#render();
    });
    this.#render();
    return this;
  }

  // Пересборка — только когда сменился сценарий или адрес: опрос раз в 2 с не должен сбрасывать ролик.
  #render() {
    const list = scenarios(this.#state);
    const current = list.find((s) => s.id === this.#id) ?? list[0];
    const key = `${this.#state.a}|${this.#state.panel}|${current.id}`;
    if (key === this.#shown) return;
    this.#shown = key;
    this.#picker.replaceChildren(...list.map((s) => h('label', { class: 'chip' },
      h('input', { class: 'chip__input visually-hidden', type: 'radio', name: 'guide', value: s.id, checked: s.id === current.id }),
      svgIcon(s.icon), s.title)));
    this.#player?.destroy();
    const reel = new Reel(current, screens(this.#state));
    let player = null;
    const stage = new Stage(reel, `Ролик «${current.title}»: как это выглядит на устройстве. Те же шаги — текстом рядом.`, () => player?.repaint());
    this.#steps = current.steps.map(step);
    player = new Player(reel, stage, { titles: current.steps.map((s) => s.title), onStep: (i) => this.#mark(i) });
    this.#player = player;
    this.#body.replaceChildren(
      h('p', { class: 'text text_tone_muted', text: current.lead }),
      h('div', { class: 'guide' }, h('div', { class: 'guide__grid' },
        h('div', { class: 'guide__aside' }, stage.el, player.el),
        h('div', { class: 'guide__steps stack stack_gap_l' },
          h('ol', { class: 'list list_view_cards' }, this.#steps.map((s) => s.li)),
          current.warn ? callout('warn', 'power', 'Если сервер выключен', current.warn) : null,
          current.note ? callout('info', 'flag', 'На заметку', current.note) : null,
          h('p', { class: 'text text_style_small text_tone_faint', text: `Панель дома: http://${this.#state.panel} или http://${this.#state.a}` })))));
    player.repaint();
  }

  /** Идёт шаг i: его карточка подсвечена, номер — залитый. */
  #mark(i) {
    this.#steps.forEach(({ card, number }, k) => {
      const on = k === i;
      card.classList.toggle('reel__step_current', on);
      if (on) card.setAttribute('aria-current', 'step');
      else card.removeAttribute('aria-current');
      number.classList.toggle('glyph_view_solid', on);
    });
  }
}
