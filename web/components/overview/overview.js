// Обзор: скорость сейчас, итоги дня, выходы коротко, кто качает, график за сутки.
import { CHART_BUCKET_MIN, EVENTS } from '../../utils/constants.js';
import { badge, empty, group, h, list, metric, row, glyph } from '../../utils/dom.js';
import { bytes, speed, time } from '../../utils/format.js';

const STATE_TONE = { alive: ['работает', 'ok'], dead: ['не отвечает', 'danger'], unknown: ['проверяется', 'warn'], off: ['выключен', null] };

export function outletBadge(o) {
  if (!o.enabled) return badge('выключен');
  const [text, tone] = STATE_TONE[o.state] ?? STATE_TONE.unknown;
  return badge(text, tone);
}

export function whoName(c) {
  if (c.kind === 'program') return c.who === 'alter' ? 'Alter' : c.who;
  return c.name ?? `Устройство ${c.ip}`;
}

export class Overview {
  #root;
  #top;
  #chart;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#top = h('div', { class: 'stack stack_gap_l' });
    this.#chart = h('div', { class: 'card' }, h('p', { class: 'text text_tone_muted', text: 'График за сутки появится через минуту.' }));
    this.#root.append(this.#top, group('Трафик через VPN за сутки', `корзины по ${CHART_BUCKET_MIN} минут`, this.#chart));
    document.addEventListener(EVENTS.state, (e) => { if (!this.#root.hidden) this.#render(e.detail); });
    document.addEventListener(EVENTS.history, (e) => this.#renderChart(e.detail));
    return this;
  }

  #render(state) {
    const down = state.consumers.reduce((s, c) => s + c.rate.down, 0);
    const up = state.consumers.reduce((s, c) => s + c.rate.up, 0);
    const today = state.consumers.reduce((s, c) => s + c.today.down + c.today.up, 0);
    const alive = state.outlets.filter((o) => o.state === 'alive').length;
    const active = state.consumers.filter((c) => c.rate.down + c.rate.up > 0);
    this.#top.replaceChildren(
      h('div', { class: 'console__grid console__grid_wide' },
        metric('Сейчас вниз', speed(down)),
        metric('Сейчас вверх', speed(up)),
        metric('За сегодня', bytes(today)),
        metric('Выходы', `${alive} из ${state.outlets.length}`, alive === 0 ? 'ни один не отвечает' : 'работают')),
      group('Выходы', null, state.outlets.length === 0
        ? empty('globe', 'Выходов нет', 'Добавь ключ на вкладке «Выходы».')
        : list(state.outlets.map((o) => row({
          lead: glyph('globe', o.state === 'alive' ? 'accent' : undefined),
          title: o.name,
          note: [o.externalIp ? `выход ${o.externalIp}` : null, o.latencyMs ? `${o.latencyMs} мс` : null].filter(Boolean).join(' · ') || (o.lastError ?? ''),
          meta: `↓ ${speed(o.rate.down)}`,
          trail: outletBadge(o),
        })))),
      group('Сейчас через VPN', null, active.length === 0
        ? empty('activity', 'Тихо', 'Сейчас через VPN никто ничего не качает.')
        : list(active.map((c) => row({
          lead: glyph(c.kind === 'device' ? 'monitor' : 'terminal'),
          title: whoName(c),
          note: `сегодня ${bytes(c.today.down + c.today.up)}`,
          meta: `↓ ${speed(c.rate.down)} · ↑ ${speed(c.rate.up)}`,
        })))),
    );
  }

  /** История по минутам → корзины → таблица для chart (он читает её один раз — узел заменяется целиком). */
  #renderChart(points) {
    if (!points || points.length === 0) return;
    const step = CHART_BUCKET_MIN * 60_000;
    const outlets = [...new Set(points.flatMap((p) => Object.keys(p.byOutlet)))];
    const series = outlets.length > 0 ? outlets : ['всего'];
    const buckets = new Map();
    for (const p of points) {
      const t = Math.floor(p.t / step) * step;
      const b = buckets.get(t) ?? {};
      for (const s of series) b[s] = (b[s] ?? 0) + (outlets.length > 0 ? p.byOutlet[s] ?? 0 : p.all);
      buckets.set(t, b);
    }
    const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    const mb = (n) => (n / 1_048_576).toFixed(1);
    const table = h('table', { class: 'chart__table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Время' }), series.map((s) => h('th', { text: s })))),
      h('tbody', {}, rows.map(([t, b]) => h('tr', {}, h('th', { text: time(t) }), series.map((s) => h('td', { text: mb(b[s] ?? 0) }))))));
    const figure = h('figure', { class: `chart ${series.length > 1 ? 'chart_form_stacked' : 'chart_form_area'}`, 'data-unit': ' МБ' },
      h('div', { class: 'chart__head' },
        h('figcaption', { class: 'chart__title', text: 'МБ за 15 минут' }),
        h('button', { class: 'button button_size_s button_view_ghost chart__toggle', type: 'button', 'aria-pressed': 'false', text: 'Таблица' })),
      table);
    this.#chart.replaceChildren(figure);
  }
}
