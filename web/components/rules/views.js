// Части вкладки «Правила»: «куда пойдёт сайт» путём из точек, карточка своего
// списка, встроенные источники числами. Каждая собирается один раз и отдаёт
// set/update — опрос меняет только значения (utils/view.js).
import { h, svgIcon } from '../../utils/dom.js';
import { ago, plural } from '../../utils/format.js';
import { badgeView, glyphView, rowView, setHidden, setText } from '../../utils/view.js';

const KIND = { url: ['link', 'по ссылке'], file: ['file-text', 'файлом'], manual: ['edit', 'вручную'] };
const LAYER = { manual: 'ручное', loaded: 'загруженное', learned: 'выученное' };
const FORMAT = { auto: 'сам определит', plain: 'простой', clash: 'Clash', shadowrocket: 'Shadowrocket', v2fly: 'v2fly', contour: 'свой, с разделами' };

/** «Куда» словами и тоном бейджа. `titles` — коды стран → названия. */
export function actionText(action, titles = {}) {
  const t = action?.target;
  const name = (c) => titles[c] ?? c;
  const text = !t ? 'по умолчанию'
    : t.kind === 'direct' ? 'напрямую'
      : t.kind === 'tunnel' ? 'через туннель'
        : t.kind === 'reject' ? 'запретить'
          : t.kind === 'country' ? `через: ${name(t.country)}`
            : t.kind === 'avoid' ? `не через: ${t.countries.map(name).join(', ')}`
              : `только через: ${t.outlets.join(', ')}`;
  const tone = !t ? null : { direct: null, tunnel: 'accent', reject: 'danger', country: 'info', avoid: 'info', only: 'warn' }[t.kind];
  return { text: action?.fastest ? `${text} · самый быстрый` : text, tone };
}

/** Путь сайта (`route`): сайт → правило → выход; бейдж — «куда». */
export function checkView() {
  const stop = (kind) => {
    const place = h('span', { class: 'route__place' });
    const note = h('span', { class: 'route__note' });
    return { el: h('div', { class: `route__stop${kind ? ` route__stop_kind_${kind}` : ''}` }, h('span', { class: 'route__dot', 'aria-hidden': 'true' }), place, note), place, note };
  };
  const stops = [stop('start'), stop(null), stop('end')];
  const badge = badgeView();
  const extra = h('p', { class: 'text text_style_small text_tone_muted' });
  const el = h('div', { class: 'stack stack_gap_m', hidden: true },
    h('div', { class: 'route' }, h('div', { class: 'route__stops' }, ...stops.map((s) => s.el)), h('div', { class: 'route__summary' }, badge.el)), extra);
  return {
    el,
    set(r, titles) {
      const d = r.decision;
      const a = actionText(d?.action ?? null, titles);
      const first = r.outlets[0];
      const points = [
        [r.host, d ? `${d.match.kind === 'cidr' ? 'подсеть' : d.match.exact ? 'имя целиком' : 'с поддоменами'}: ${d.matchText}` : 'ни одно правило не берёт'],
        [d ? d.source : 'по умолчанию', d ? `слой «${LAYER[d.layer]}»` : 'прокси — туннель, DNS и телефон — напрямую'],
        r.routed.reject ? ['Отказ', 'соединение не откроется'] : first ? [first.name, [first.direct ? 'прямой' : 'туннель', titles[first.country] ?? first.country, first.state === 'alive' ? 'жив' : first.state].filter(Boolean).join(' · ')] : ['Выхода нет', 'под требование не подходит ни один выход'],
      ];
      points.forEach(([place, note], i) => { setText(stops[i].place, place); setText(stops[i].note, note); });
      badge.set(a.text, r.routed.reject ? 'danger' : a.tone);
      const more = r.outlets.slice(1).map((o) => o.name);
      setText(extra, [more.length > 0 ? `следом попробует: ${more.join(', ')}` : '', r.routed.fenceException ? 'ограда частных адресов пропускает: правило «только через эти выходы»' : ''].filter(Boolean).join(' · '));
      setHidden(el, false);
    },
  };
}

function moreMenu(items) {
  return h('div', { class: 'menu menu_align_end' },
    h('button', { class: 'button button_view_ghost button_shape_round button_size_s menu__trigger', type: 'button', 'aria-label': 'Ещё' }, svgIcon('more', 'button__icon')),
    h('div', { class: 'popup menu__popup', popover: '', role: 'menu' },
      items.map(([value, text, icon, danger]) => h('button', { class: `menu__item${danger ? ' menu__item_tone_danger' : ''}`, role: 'menuitem', type: 'button', dataset: { value } }, svgIcon(icon), h('span', { class: 'menu__item-text', text })))));
}

/** Свой список: значок вида, название, сколько правил, переключатель, «куда», меню. */
export function listCard(list) {
  const input = h('input', { class: 'switch__input visually-hidden', type: 'checkbox', role: 'switch', dataset: { rulesAct: 'enable' } });
  const toggle = h('label', { class: 'switch' }, input, h('span', { class: 'switch__track', 'aria-hidden': 'true' }), h('span', { class: 'switch__label visually-hidden', text: 'Действует' }));
  const items = [['text', 'Показать текст', 'eye'], ...(list.kind === 'url' ? [['refresh', 'Обновить сейчас', 'refresh']] : []), ['remove', 'Удалить', 'trash', true]];
  const row = rowView(KIND[list.kind][0], h('span', { class: 'cluster cluster_gap_s cluster_nowrap' }, toggle, moreMenu(items)));
  const badge = badgeView();
  const fastest = h('span', { class: 'badge badge_tone_accent' }, svgIcon('bolt', 'badge__icon'), 'самый быстрый');
  const note = h('p', { class: 'text text_style_small text_tone_muted' });
  const error = h('p', { class: 'text text_style_small text_tone_danger' });
  const text = h('pre', { class: 'code code_block code_folded', hidden: true });
  const el = h('article', { class: 'card stack stack_gap_m', dataset: { id: list.id } }, row.el, h('div', { class: 'cluster cluster_gap_s' }, badge.el, fastest), note, error, text);
  return {
    el,
    text,
    update(l, titles) {
      el.dataset.title = l.title;
      const s = l.stats;
      row.set({ title: l.title, note: [KIND[l.kind][1], FORMAT[s?.format] ?? FORMAT[l.format], l.updated ? `обновлён ${ago(l.updated)}` : ''].filter(Boolean).join(' · '), tone: l.enabled ? 'accent' : undefined });
      const a = actionText({ target: l.action.target }, titles);
      // У своего формата «куда» — у каждого раздела; общее — только у строк без раздела.
      if (s?.format === 'contour') badge.set('по разделам', 'info');
      else badge.set(a.text, a.tone);
      setHidden(fastest, !l.action.fastest);
      setText(note, s ? [
        plural(s.entries, ['правило', 'правила', 'правил']),
        s.skipped ? `пропущено ${s.skipped} — таких правил Contour не умеет` : '',
        s.fenced ? `${plural(s.fenced, ['частный адрес', 'частных адреса', 'частных адресов'])} — не взяты: только через «только: выход»` : '',
        s.errors ? plural(s.errors, ['ошибка', 'ошибки', 'ошибок']) : '',
      ].filter(Boolean).join(' · ') : 'ещё не разобран');
      setText(error, l.error ?? '');
      setHidden(error, !l.error);
      if (input.checked !== l.enabled) input.checked = l.enabled;
      input.dataset.id = l.id;
    },
  };
}

/** Встроенные источники: сколько правил у каждого, по слоям. */
export function sourcesView() {
  const dl = h('dl', { class: 'kv' });
  const el = h('article', { class: 'card stack stack_gap_m' },
    h('header', { class: 'bar bar_size_s' }, glyphView('layers').el, h('div', { class: 'bar__text' },
      h('h3', { class: 'bar__title', text: 'Все источники' }), h('p', { class: 'bar__subtitle', text: 'ручное сильнее загруженного, загруженное — выученного' }))),
    dl);
  return {
    el,
    set(sources) {
      dl.replaceChildren(...sources.flatMap((s) => [h('dt', { class: 'kv__key', text: s.source }), h('dd', { class: 'kv__value', text: `${s.count} · ${LAYER[s.layer]}` })]));
    },
  };
}

export { FORMAT };
