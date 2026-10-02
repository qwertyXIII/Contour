// Части вкладки «Раздача»: плитки состояния, карточка телефона, маршрут nginx,
// страна выхода. Каждая собирается один раз и отдаёт update — опрос меняет
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

/** Телефон: строка с переключателем «ходит / не ходит» и меню справа, под ней «Подключить» и состояние. */
export function deviceCard() {
  const input = h('input', { class: 'switch__input visually-hidden', type: 'checkbox', role: 'switch', dataset: { shareAct: 'enable' } });
  const toggle = h('label', { class: 'switch' }, input, h('span', { class: 'switch__track', 'aria-hidden': 'true' }), h('span', { class: 'switch__label visually-hidden', text: 'Ходит через дом' }));
  const open = button('Подключить', { icon: 'scan', data: { shareAct: 'open' } });
  const menu = moreMenu([['open', 'Подключить', 'scan'], ['remove', 'Удалить', 'trash', true]]);
  const state = badgeView();
  const row = rowView('phone', h('span', { class: 'cluster cluster_gap_s cluster_nowrap' }, toggle, menu));
  const el = h('article', { class: 'card stack stack_gap_s' }, row.el, h('div', { class: 'cluster cluster_gap_s' }, open, state.el));
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

/** Страна выхода: чем выпускаем, свои сайты чипами, поле «добавить», памятка для поездок. */
export function countryCard(code) {
  const badge = badgeView();
  const exit = rowView('home', badge.el);
  const common = h('p', { class: 'text text_style_small text_tone_muted' });
  const chips = h('div', { class: 'cluster cluster_gap_s', dataset: { shareChips: code } });
  const input = h('input', { class: 'input__control', name: 'site', placeholder: 'alfabank.ru', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Сайт' });
  const form = h('form', { class: 'cluster cluster_gap_s cluster_nowrap', dataset: { shareSite: code } },
    h('div', { class: 'input' }, input), button('Добавить', { icon: 'plus', view: 'primary' }));
  form.querySelector('button').type = 'submit';
  const tip = h('p', { class: 'callout__text' });
  const el = h('div', { class: 'stack stack_gap_m' },
    h('article', { class: 'card stack stack_gap_m' }, exit.el, common, chips, form),
    h('div', { class: 'callout callout_tone_info' }, svgIcon('plane', 'callout__icon'),
      h('div', { class: 'callout__body' }, h('p', { class: 'callout__title', text: 'Уехал за границу' }), tip)));
  let shown = '';
  return {
    el,
    input,
    update(c) {
      exit.set({
        title: c.exit ? `Выход в стране ${c.code}: ${c.exit.name}` : `Выхода в стране ${c.code} нет`,
        note: c.exit ? [c.exit.direct ? 'прямой — интернет этого сервера' : 'туннель', c.exit.ip].filter(Boolean).join(' · ') : 'Contour узнаёт страну выхода по его адресу — подожди минуту после запуска',
        tone: c.exit?.alive ? 'accent' : undefined,
      });
      badge.set(c.exit?.alive ? 'работает' : c.exit ? 'не отвечает' : 'нет', c.exit?.alive ? 'ok' : 'danger');
      setText(common, `Через ${c.node} идут: ${c.common} сайтов общего списка (Госуслуги, налоговая, Озон, РЖД…), всё, что живёт в стране ${c.code} (GEOIP), и твои:`);
      // Чипы — только если список правда сменился: иначе опрос сбивал бы нажатие на крестик.
      const key = c.own.join(' ');
      if (key !== shown) {
        shown = key;
        chips.replaceChildren(...(c.own.length > 0 ? c.own.map((s) => h('span', { class: 'chip chip_static chip_removable', dataset: { value: s } }, s,
          h('button', { class: 'chip__remove', type: 'button', 'aria-label': `Убрать «${s}»` }, svgIcon('close'))))
          : [h('span', { class: 'text text_style_small text_tone_faint', text: 'своих пока нет — банки и прочее, чего нет в общем списке' })]));
      }
      setText(tip, `В Shadowrocket на главной, в группе «${c.group}», выбери ${c.node} — российское пойдёт через дом с российским адресом. Вернулся — выбери DIRECT. Заблокированное в обоих случаях идёт через Contour.`);
      setHidden(form, false);
    },
  };
}
