// Части вкладки «Раздача»: плитки состояния, карточка телефона (со странами,
// открытыми ему), маршрут nginx, страна выхода. Каждая собирается один раз и отдаёт update — опрос меняет
// только значения (utils/view.js), а не пересобирает разметку.
import { button, h, svgIcon } from '../../utils/dom.js';
import { ago, bytes, speed } from '../../utils/format.js';
import { badgeView, glyphView, rowView, setClass, setHidden, setText } from '../../utils/view.js';

/** Плитка «подпись · значок · значение · пояснение»; тон — акцент, когда всё хорошо и это главное. */
export function tileView(label, icon) {
  const value = h('span', { class: 'tile__value' });
  const note = h('span', { class: 'tile__note' });
  const el = h('div', { class: 'tile' },
    h('span', { class: 'tile__head' }, h('span', { class: 'tile__label', text: label }), svgIcon(icon, 'tile__icon')),
    value, note);
  return {
    el,
    set(v, n, accent = false) {
      setText(value, v);
      setText(note, n);
      setClass(el, accent ? 'tile tile_tone_accent' : 'tile');
    },
  };
}

/** Меню «Ещё» дизайн-системы: пункты — `[value, text, icon, danger?]`; выбор — событие menu:select. */
function moreMenu(items) {
  return h('div', { class: 'menu menu_align_end' },
    h('button', { class: 'button button_view_ghost button_shape_round button_size_s menu__trigger', type: 'button', 'aria-label': 'Ещё' }, svgIcon('more', 'button__icon')),
    h('div', { class: 'popup menu__popup', popover: '', role: 'menu' },
      items.map(([value, text, icon, danger]) => h('button', { class: `menu__item${danger ? ' menu__item_tone_danger' : ''}`, role: 'menuitem', type: 'button', dataset: { value } },
        svgIcon(icon), h('span', { class: 'menu__item-text', text })))));
}

/**
 * Страны телефона — чипы-флажки: отмечена — у телефона свой сервер «Contour-XX»
 * в подписке. Чипы пересобираются, только когда сменился сам набор стран, —
 * опрос не сбивает нажатие; отметки ставятся на месте.
 */
function countryChips() {
  const box = h('div', { class: 'cluster cluster_gap_s' });
  const none = h('p', { class: 'text text_style_small text_tone_faint', text: 'у выходов страна ещё не известна — Contour узнаёт её по адресу выхода' });
  const el = h('div', { class: 'stack stack_gap_xs' },
    h('p', { class: 'text text_style_small text_tone_muted', text: 'Выход в стране — свой сервер в телефоне на каждую' }), box, none);
  let shown = '';
  return {
    el,
    set(x) {
      const key = x.all.map((c) => `${c.code}:${c.exit ? 1 : 0}`).join(' ');
      if (key !== shown) {
        shown = key;
        box.replaceChildren(...x.all.map((c) => h('label', { class: 'chip', title: c.exit ? `выход ${c.exit.name}` : 'выхода в этой стране сейчас нет' },
          h('input', { class: 'chip__input visually-hidden', type: 'checkbox', disabled: !c.exit && !x.countries.includes(c.code), dataset: { shareAct: 'country', code: c.code, title: c.title } }),
          svgIcon(c.exit ? 'globe' : 'flag'), c.title)));
      }
      for (const input of box.querySelectorAll('input')) {
        input.dataset.id = x.id;
        input.dataset.name = x.name;
        const on = x.countries.includes(input.dataset.code);
        if (input.checked !== on) input.checked = on;
      }
      setHidden(box, x.all.length === 0);
      setHidden(none, x.all.length > 0);
    },
  };
}

/** Телефон: строка с переключателем «ходит / не ходит» и меню справа, страны, под ними «Подключить» и состояние. */
export function deviceCard() {
  const input = h('input', { class: 'switch__input visually-hidden', type: 'checkbox', role: 'switch', dataset: { shareAct: 'enable' } });
  const toggle = h('label', { class: 'switch' }, input, h('span', { class: 'switch__track', 'aria-hidden': 'true' }), h('span', { class: 'switch__label visually-hidden', text: 'Ходит через дом' }));
  const open = button('Подключить', { icon: 'scan', data: { shareAct: 'open' } });
  const menu = moreMenu([['open', 'Подключить', 'scan'], ['remove', 'Удалить', 'trash', true]]);
  const state = badgeView();
  const row = rowView('phone', h('span', { class: 'cluster cluster_gap_s cluster_nowrap' }, toggle, menu));
  const chips = countryChips();
  const el = h('article', { class: 'card stack stack_gap_m' }, row.el, chips.el, h('div', { class: 'cluster cluster_gap_s' }, open, state.el));
  return {
    el,
    update(x) {
      const active = x.enabled && x.rate.down + x.rate.up > 0;
      row.set({
        title: x.name,
        note: [x.lastSeen ? `был ${ago(x.lastSeen)}` : 'ещё не подключался', `сегодня ${bytes(x.today.down + x.today.up)}`].join(' · '),
        tone: active ? 'accent' : undefined,
      });
      state.set(x.enabled ? (active ? `ходит · ↓ ${speed(x.rate.down)}` : 'включён') : 'выключен', x.enabled ? (active ? 'ok' : null) : 'warn');
      chips.set(x);
      if (input.checked !== x.enabled) input.checked = x.enabled;
      for (const node of [el, input, open]) {
        node.dataset.id = x.id;
        node.dataset.name = x.name;
      }
    },
  };
}

/** Что завести в LogViewer для домена раздачи — парами «что — куда». */
export function routeView() {
  const values = {};
  const pair = (key, label) => [h('dt', { class: 'kv__key', text: label }), (values[key] = h('dd', { class: 'kv__value' }))];
  const el = h('div', { class: 'card stack stack_gap_m' },
    h('header', { class: 'bar bar_size_s' }, glyphView('route').el, h('div', { class: 'bar__text' },
      h('h3', { class: 'bar__title', text: 'Маршрут в nginx' }), h('p', { class: 'bar__subtitle', text: 'заводишь сам, в LogViewer' }))),
    h('dl', { class: 'kv kv_layout_stack' }, ...pair('domain', 'Домен'), ...pair('edge', 'Путь /'), ...pair('list', 'Путь /list/'), ...pair('flags', 'Ещё')));
  return {
    el,
    set(d) {
      setText(values.domain, d.domain ? `${d.domain} — с сертификатом` : 'сначала впиши адрес выше');
      setText(values.edge, `http://127.0.0.1:${d.ports.edge} — край; чужие пути он отвергает сам`);
      setText(values.list, `http://127.0.0.1:${d.ports.list} — правила для телефонов`);
      setText(values.flags, 'WebSocket включён, таймаут чтения 3600 с');
    },
  };
}

/** Стопка телефонов буквами: цвет — от имени, чтобы телефон узнавался везде одинаково. */
function phonesView() {
  const el = h('div', { class: 'avatar-stack', role: 'img' });
  let shown = null;
  return {
    el,
    set(names) {
      const key = names.join('\n');
      if (key === shown) return;
      shown = key;
      const hue = (n) => [...n].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
      const more = names.length > 4 ? [h('span', { class: 'avatar avatar_size_s avatar-stack__more', text: `+${names.length - 3}` })] : [];
      el.replaceChildren(...names.slice(0, more.length > 0 ? 3 : 4).map((n) => h('span', { class: 'avatar avatar_size_s avatar_hued avatar-stack__item', style: { '--avatar-hue': String(hue(n)) }, title: n, text: n.trim().slice(0, 1).toUpperCase() })), ...more);
      el.setAttribute('aria-label', names.length > 0 ? `Открыта: ${names.join(', ')}` : 'Не открыта ни одному телефону');
    },
  };
}

/** Число с подписью (`metric`): сколько сайтов в списке страны и чьих. */
function metricView(label, unit) {
  const number = h('span', { class: 'metric__number' });
  const note = h('span', { class: 'metric__note' });
  const el = h('div', { class: 'metric metric_size_s' }, h('span', { class: 'metric__label', text: label }),
    h('span', { class: 'metric__value' }, number, h('span', { class: 'metric__unit', text: unit })), note);
  return { el, set(n, text = '') { setText(number, String(n)); setText(note, text); } };
}

/** Путь соединения точками (`route`): телефон → Contour → выход в стране. */
function pathView() {
  const stop = (kind) => {
    const place = h('span', { class: 'route__place' });
    const note = h('span', { class: 'route__note' });
    return { el: h('div', { class: `route__stop${kind ? ` route__stop_kind_${kind}` : ''}` }, h('span', { class: 'route__dot', 'aria-hidden': 'true' }), place, note), place, note };
  };
  const stops = [stop('start'), stop(null), stop('end')];
  return {
    el: h('div', { class: 'route' }, h('div', { class: 'route__stops' }, ...stops.map((x) => x.el))),
    set(points) {
      points.forEach(([place, note], i) => { setText(stops[i].place, place); setText(stops[i].note, note); });
    },
  };
}

/**
 * Страна выхода: шапка с состоянием, путь соединения, сколько сайтов идёт в её
 * группу, каким телефонам открыта, свои сайты чипами.
 */
export function countryCard(code) {
  const glyph = glyphView('globe');
  const title = h('h3', { class: 'bar__title' });
  const subtitle = h('p', { class: 'bar__subtitle' });
  const badge = badgeView();
  const route = pathView();
  const common = metricView('Готовый список', 'сайтов');
  const mine = metricView('Свои', 'сайтов');
  const phones = phonesView();
  const phonesNote = h('span', { class: 'metric__note' });
  const who = h('div', { class: 'metric metric_size_s' }, h('span', { class: 'metric__label', text: 'Открыта' }), phones.el, phonesNote);
  const chips = h('div', { class: 'cluster cluster_gap_s', dataset: { shareChips: code } });
  const input = h('input', { class: 'input__control', name: 'site', placeholder: 'bank.example', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Сайт' });
  const form = h('form', { class: 'cluster cluster_gap_s cluster_nowrap', dataset: { shareSite: code } },
    h('div', { class: 'input' }, input), button('Добавить', { icon: 'plus', view: 'primary' }));
  form.querySelector('button').type = 'submit';
  const sitesNote = h('p', { class: 'text text_style_small text_tone_muted' });
  const el = h('article', { class: 'card stack stack_gap_l' },
    h('header', { class: 'bar bar_size_s' }, glyph.el, h('div', { class: 'bar__text' }, title, subtitle), h('div', { class: 'bar__end' }, badge.el)),
    route.el,
    h('div', { class: 'cluster cluster_gap_xl' }, common.el, mine.el, who),
    h('div', { class: 'divider' }),
    h('div', { class: 'stack stack_gap_s' }, sitesNote, chips, form));
  let shown = '';
  return {
    el,
    input,
    update(c) {
      setText(title, c.title);
      setText(subtitle, `сервер ${c.node}`);
      glyph.tone(c.exit?.alive ? 'accent' : null);
      badge.set(c.exit?.alive ? 'работает' : c.exit ? 'не отвечает' : 'выхода нет', c.exit?.alive ? 'ok' : c.exit ? 'danger' : 'warn');
      route.set([
        ['Телефон', 'из любой сети'],
        ['Contour', 'правила и ключи'],
        c.exit
          ? [c.exit.name, [c.exit.direct ? 'прямой' : 'туннель', c.exit.ip].filter(Boolean).join(' · ')]
          : ['Выхода нет', 'появится — заработает сам'],
      ]);
      common.set(c.common, c.common > 0 ? 'обновляется сам' : 'для этой страны нет');
      mine.set(c.own.length, 'из панели');
      phones.set(c.phones);
      setText(phonesNote, c.phones.length > 0 ? `телефонов: ${c.phones.length}` : 'никому — в карточке телефона');
      setText(sitesNote, `В группу «${c.group}» идут сайты списка, всё, что живёт в стране (GEOIP), и твои:`);
      // Чипы — только если список правда сменился: иначе опрос сбивал бы нажатие на крестик.
      const key = c.own.join(' ');
      if (key !== shown) {
        shown = key;
        chips.replaceChildren(...(c.own.length > 0 ? c.own.map((x) => h('span', { class: 'chip chip_static chip_removable', dataset: { value: x } }, x,
          h('button', { class: 'chip__remove', type: 'button', 'aria-label': `Убрать «${x}»` }, svgIcon('close'))))
          : [h('span', { class: 'text text_style_small text_tone_faint', text: 'своих пока нет — банки и прочее, чего нет в готовом списке' })]));
      }
    },
  };
}
