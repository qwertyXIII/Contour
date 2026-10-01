// Обзор: скорость сейчас, итоги дня, выходы коротко, кто качает, график за сутки.
// Разметка собирается один раз; тик меняет только значения (utils/view.js).
// График — тоже данными: меняются ячейки его таблицы, он перерисовывается сам.
import { CHART_BUCKET_MIN, EVENTS } from '../../utils/constants.js';
import { empty, group, h } from '../../utils/dom.js';
import { bytes, speed, time } from '../../utils/format.js';
import { badgeView, Keyed, listSection, rowView, setText } from '../../utils/view.js';

const STATE_TONE = { alive: ['работает', 'ok'], dead: ['не отвечает', 'danger'], unknown: ['проверяется', 'warn'], standby: ['запасной', null], off: ['выключен', null] };

/** Текст и тон бейджа выхода. */
export function outletStatus(o) {
  if (!o.enabled) return ['выключен', null];
  return STATE_TONE[o.state] ?? STATE_TONE.unknown;
}

export function whoName(c) {
  if (c.kind === 'program') return c.who === 'alter' ? 'Alter' : c.who;
  if (c.kind === 'share') return c.name ?? 'Телефон снаружи';
  return c.name ?? `Устройство ${c.ip}`;
}

/** Метрика с числом и единицей раздельно: «100,5» + «Мбит/с». */
function metricView(label) {
  const number = h('span', { class: 'metric__number' });
  const unit = h('span', { class: 'metric__unit' });
  const note = h('span', { class: 'metric__note' });
  const el = h('div', { class: 'card' }, h('div', { class: 'metric metric_size_s' },
    h('span', { class: 'metric__label', text: label }), h('span', { class: 'metric__value' }, number, unit), note));
  return {
    el,
    set(value, noteText = '') {
      const at = value.lastIndexOf(' ');
      const split = at > 0 && /[^\d\s,.]/.test(value.slice(at + 1));
      setText(number, split ? value.slice(0, at) : value);
      setText(unit, split ? value.slice(at + 1) : '');
      setText(note, noteText);
    },
  };
}

function outletRow() {
  const status = badgeView();
  const row = rowView('globe', status.el);
  return {
    el: row.el,
    update(o) {
      row.set({
        title: o.name,
        note: [o.externalIp ? `выход ${o.externalIp}` : null, o.latencyMs ? `${o.latencyMs} мс` : null].filter(Boolean).join(' · ') || (o.lastError ?? ''),
        meta: `↓ ${speed(o.rate.down)}`,
        tone: o.state === 'alive' ? 'accent' : undefined,
      });
      status.set(...outletStatus(o));
    },
  };
}

function activeRow(c) {
  const row = rowView(c.kind === 'device' ? 'monitor' : 'terminal');
  return {
    el: row.el,
    update: (x) => row.set({ title: whoName(x), note: `сегодня ${bytes(x.today.down + x.today.up)}`, meta: `↓ ${speed(x.rate.down)} · ↑ ${speed(x.rate.up)}` }),
  };
}

/**
 * График за сутки: фигура и таблица собираются один раз; новые данные — это
 * новые строки и ячейки таблицы (по ключу — времени корзины), график следит
 * за таблицей сам. Заголовки рядов меняются, только когда меняется набор выходов.
 */
class TrafficChart {
  el;
  #head;
  #rows;
  #series = [];

  constructor() {
    this.#head = h('tr', {}, h('th', { text: 'Время' }));
    const body = h('tbody', {});
    this.#rows = new Keyed(body, ([t]) => t, () => {
      const label = h('th', {});
      const tr = h('tr', {}, label);
      return {
        el: tr,
        update: ([t, b]) => {
          setText(label, time(t));
          while (tr.cells.length - 1 < this.#series.length) tr.append(h('td', {}));
          while (tr.cells.length - 1 > this.#series.length) tr.lastElementChild.remove();
          this.#series.forEach((s, i) => setText(tr.cells[i + 1], ((b[s] ?? 0) / 1_048_576).toFixed(1)));
        },
      };
    });
    this.el = h('figure', { class: 'chart chart_form_area', 'data-unit': ' МБ' },
      h('div', { class: 'chart__head' },
        h('figcaption', { class: 'chart__title', text: `МБ за ${CHART_BUCKET_MIN} минут` }),
        h('button', { class: 'button button_size_s button_view_ghost chart__toggle', type: 'button', 'aria-pressed': 'false', text: 'Таблица' })),
      h('table', { class: 'chart__table' }, h('thead', {}, this.#head), body));
  }

  update(points) {
    const step = CHART_BUCKET_MIN * 60_000;
    const outlets = [...new Set(points.flatMap((p) => Object.keys(p.byOutlet)))].sort();
    const series = outlets.length > 0 ? outlets : ['всего'];
    if (series.join('|') !== this.#series.join('|')) {
      this.#series = series;
      this.#head.replaceChildren(h('th', { text: 'Время' }), ...series.map((s) => h('th', { text: s })));
    }
    const buckets = new Map();
    for (const p of points) {
      const t = Math.floor(p.t / step) * step;
      const b = buckets.get(t) ?? {};
      for (const s of series) b[s] = (b[s] ?? 0) + (outlets.length > 0 ? p.byOutlet[s] ?? 0 : p.all);
      buckets.set(t, b);
    }
    this.#rows.render([...buckets.entries()].sort((a, b) => a[0] - b[0]));
  }
}

export class Overview {
  #root;
  #metrics;
  #outlets;
  #active;
  #chart;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#metrics = { down: metricView('Сейчас вниз'), up: metricView('Сейчас вверх'), today: metricView('За сегодня'), outlets: metricView('Выходы') };
    this.#outlets = listSection((o) => o.name, outletRow, empty('globe', 'Выходов нет', 'Добавь ключ на вкладке «Выходы».'));
    this.#active = listSection((c) => c.who, activeRow, empty('activity', 'Тихо', 'Сейчас через VPN никто ничего не качает.'));
    this.#chart = new TrafficChart();
    this.#root.append(
      h('div', { class: 'console__grid console__grid_wide' }, Object.values(this.#metrics).map((m) => m.el)),
      group('Выходы', null, this.#outlets.el),
      group('Сейчас через VPN', null, this.#active.el),
      group('Трафик через VPN за сутки', `корзины по ${CHART_BUCKET_MIN} минут`, h('div', { class: 'card' }, this.#chart.el)),
    );
    document.addEventListener(EVENTS.state, (e) => { if (!this.#root.hidden) this.#update(e.detail); });
    document.addEventListener(EVENTS.history, (e) => { if (e.detail?.length) this.#chart.update(e.detail); });
    return this;
  }

  #update(state) {
    const sum = (f) => state.consumers.reduce((s, c) => s + f(c), 0);
    const alive = state.outlets.filter((o) => o.state === 'alive').length;
    this.#metrics.down.set(speed(sum((c) => c.rate.down)));
    this.#metrics.up.set(speed(sum((c) => c.rate.up)));
    this.#metrics.today.set(bytes(sum((c) => c.today.down + c.today.up)));
    this.#metrics.outlets.set(`${alive} из ${state.outlets.length}`, alive === 0 ? 'ни один не отвечает' : 'работают');
    this.#outlets.render(state.outlets);
    this.#active.render(state.consumers.filter((c) => c.rate.down + c.rate.up > 0));
  }
}
