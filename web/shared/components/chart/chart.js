// График из таблицы данных. Таблица — источник и двойник: скринридер читает
// её, «Таблица» показывает её вместо графика. Форма — модификатор блока:
// line · area (линии), stacked · grouped · layered (столбики).
//
// Рисуется в пикселях поля, а не растяжением viewBox: волоски сетки остаются
// в 1px, линии — в 2px. Поле поменяло ширину — график перерисовывается.
//
// ⚠️ ЛОКАЛЬНАЯ ПРАВКА копии в Contour (2026-10-01, владелец: «график должен
// обновляться именно данными»; в Alter перенесёт его агент): график следит за
// своей таблицей. Поменялись ячейки, строки или ряды — данные перечитываются и
// график перерисовывается на месте: без пересоздания узла и без вступления,
// скрытые в легенде ряды остаются скрытыми. Пустая при запуске таблица — тоже
// не конец: график оживёт, когда в ней появятся данные.
import { CHART } from '../../utils/constants.js';
import { h } from '../../utils/dom.js';
import { drawColumns, columnsMax } from './columns.js';
import { colorOf, markCells, readTable } from './data.js';
import { drawLines, linesMax } from './lines.js';
import { niceTicks, tickLabel } from './scale.js';
import { s } from './svg.js';
import { placeTip, tipContent } from './tip.js';

export class Chart {
  #root;
  #table;
  #data;
  #form;
  #plot;
  #svg;
  #tip;
  #legend;
  #geo = null;
  #active = -1;
  #frame = 0;

  constructor(root) {
    this.#root = root;
    this.#table = root.querySelector('.chart__table');
  }

  init() {
    if (!this.#table) return this;
    this.#data = readTable(this.#table);
    if (!this.#data.categories.length || !this.#data.series.length) {
      this.#waitForData();
      return this;
    }
    markCells(this.#table);
    this.#form = CHART.forms.find((form) => this.#root.classList.contains(`chart_form_${form}`)) ?? 'grouped';
    this.#build();
    this.#bind();
    this.#root.classList.add(CHART.enhanced, CHART.intro);
    setTimeout(() => this.#root.classList.remove(CHART.intro), CHART.introMs);
    return this;
  }

  get #lines() {
    return this.#form === 'line' || this.#form === 'area';
  }

  #build() {
    this.#svg = s('svg', { class: 'chart__svg', 'aria-hidden': 'true' });
    this.#tip = h('div', { class: 'chart__tip', 'aria-hidden': 'true' });
    const title = this.#root.querySelector('.chart__title')?.textContent.trim() ?? '';
    this.#plot = h('div', {
      class: 'chart__plot',
      tabindex: 0,
      role: 'group',
      'aria-roledescription': 'график',
      'aria-label': `${title}. ${CHART.hint}`,
    }, this.#svg, this.#tip);
    if (this.#data.series.length > 1) this.#legend = this.#buildLegend();
    this.#table.before(...[this.#legend, this.#plot].filter(Boolean));
    const data = h('div', { class: 'chart__data' });
    this.#table.before(data);
    data.append(this.#table);
  }

  #buildLegend() {
    const kind = this.#lines ? ' chart__swatch_kind_line' : '';
    return h('ul', { class: 'chart__legend' }, this.#data.series.map((item) => h('li', {},
      h('button', {
        class: 'chart__key',
        type: 'button',
        'aria-pressed': 'true',
        on: { click: (event) => this.#toggleSeries(item, event.currentTarget) },
      }, h('span', { class: `chart__swatch${kind}`, style: { '--key-color': colorOf(item.slot) } }), item.name))));
  }

  /** Таблица пока пустая — ждать данных и тогда ожить. */
  #waitForData() {
    const watch = new MutationObserver(() => {
      if (!readTable(this.#table).categories.length) return;
      watch.disconnect();
      this.init();
    });
    watch.observe(this.#table, { childList: true, subtree: true, characterData: true });
  }

  #schedule() {
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => this.#render());
  }

  /** Таблица поменялась — перечитать данные, сохранить скрытые ряды, перерисовать. */
  #refresh() {
    const next = readTable(this.#table);
    if (!next.categories.length || !next.series.length) return;
    const hidden = new Set(this.#data.series.filter((item) => item.hidden).map((item) => item.name));
    next.series.forEach((item) => { item.hidden = hidden.has(item.name); });
    if (next.series.every((item) => item.hidden)) next.series[0].hidden = false;
    const names = (d) => d.series.map((item) => `${item.name}:${item.slot}`).join('|');
    const legendChanged = names(next) !== names(this.#data);
    this.#data = next;
    markCells(this.#table);
    if (legendChanged) this.#rebuildLegend();
    if (this.#active >= next.categories.length) this.#hide();
    this.#schedule();
  }

  #rebuildLegend() {
    const legend = this.#data.series.length > 1 ? this.#buildLegend() : null;
    if (this.#legend) this.#legend.replaceWith(...(legend ? [legend] : []));
    else if (legend) this.#plot.before(legend);
    this.#legend = legend;
    this.#legend?.querySelectorAll('.chart__key').forEach((key, i) => key.setAttribute('aria-pressed', String(!this.#data.series[i].hidden)));
  }

  #bind() {
    // Данные — данными: правка таблицы (ячейки, строки, ряды) перерисовывает график на месте.
    new MutationObserver(() => this.#refresh()).observe(this.#table, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-value', 'data-series'],
    });
    new ResizeObserver(() => {
      cancelAnimationFrame(this.#frame);
      this.#frame = requestAnimationFrame(() => this.#render());
    }).observe(this.#plot);
    this.#plot.addEventListener('pointermove', (event) => this.#pointAt(event));
    this.#plot.addEventListener('pointerdown', (event) => this.#pointAt(event));
    this.#plot.addEventListener('pointerleave', () => this.#hide());
    this.#plot.addEventListener('keydown', (event) => this.#key(event));
    this.#plot.addEventListener('blur', () => this.#hide());
    this.#root.querySelector('.chart__toggle')?.addEventListener('click', (event) => this.#toggleView(event.currentTarget));
  }

  // ── отрисовка ─────────────────────────────────────────

  #visible() {
    return this.#data.series.filter((item) => !item.hidden);
  }

  #measure(text) {
    const probe = s('text', { class: 'chart__tick', text });
    this.#svg.append(probe);
    const width = probe.getComputedTextLength();
    probe.remove();
    return width;
  }

  #render() {
    const width = this.#plot.clientWidth;
    const height = this.#plot.clientHeight;
    if (!width || !height) return;
    const series = this.#visible();
    const count = this.#data.categories.length;
    const raw = this.#lines ? linesMax(series) : columnsMax(this.#form, series, count);
    const { max, ticks } = niceTicks(raw);
    this.#svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.#svg.replaceChildren();
    const labels = this.#lines && series.length > 1 && series.length <= CHART.maxLabels && width > CHART.labelsFrom;
    const right = labels ? Math.max(...series.map((item) => this.#measure(item.name))) + 16 : 8;
    const left = Math.max(...ticks.map((tick) => this.#measure(tickLabel(tick)))) + 10;
    const axis = parseFloat(getComputedStyle(this.#root).getPropertyValue('--chart-axis')) || 22;
    const frame = { left, top: 8, width: Math.max(10, width - left - right), height: Math.max(10, height - axis - 8) };
    const scale = (value) => frame.top + frame.height - (value / max) * frame.height;
    this.#drawGrid(frame, ticks, scale);
    const marks = s('g', {});
    this.#svg.append(marks);
    const draw = this.#lines ? drawLines : drawColumns;
    const geo = draw(marks, { form: this.#form, frame, count, series, scale, labels });
    this.#drawAxis(frame, geo, axis);
    this.#overlay = s('g', {});
    this.#svg.append(this.#overlay);
    this.#geo = { ...geo, frame, scale, width };
    if (this.#active >= 0) this.#show(this.#active);
  }

  #overlay = null;

  #drawGrid(frame, ticks, scale) {
    ticks.forEach((tick) => {
      const y = Math.round(scale(tick)) + 0.5;
      this.#svg.append(
        s('line', { class: tick === 0 ? 'chart__baseline' : 'chart__grid', x1: frame.left, x2: frame.left + frame.width, y1: y, y2: y }),
        s('text', { class: 'chart__tick', x: frame.left - 10, y: y + 4, 'text-anchor': 'end', text: tickLabel(tick) }),
      );
    });
  }

  // Подписи оси X: если тесно — каждая вторая, третья… (с первой, без насильной последней: иначе наезжают)
  #drawAxis(frame, geo, axis) {
    const { categories } = this.#data;
    const widest = Math.max(...categories.map((label) => this.#measure(label))) + 8;
    const pitch = categories.length > 1 ? Math.abs(geo.centerOf(1) - geo.centerOf(0)) : frame.width;
    const every = Math.max(1, Math.ceil(widest / Math.max(1, pitch)));
    categories.forEach((label, i) => {
      if (i % every) return;
      this.#svg.append(s('text', { class: 'chart__tick', x: geo.centerOf(i), y: frame.top + frame.height + axis - 6, 'text-anchor': 'middle', text: label }));
    });
  }

  // ── подсказка ─────────────────────────────────────────

  #pointAt(event) {
    if (!this.#geo) return;
    const box = this.#plot.getBoundingClientRect();
    this.#show(this.#geo.indexAt(event.clientX - box.left));
  }

  #show(index) {
    const geo = this.#geo;
    if (!geo) return;
    this.#active = index;
    const series = this.#visible();
    const x = geo.centerOf(index);
    this.#overlay.replaceChildren();
    if (this.#lines) this.#drawCross(index, x, series);
    this.#svg.classList.toggle('chart__svg_focus', !this.#lines);
    this.#svg.querySelectorAll('.chart__col').forEach((col) => col.classList.toggle('chart__col_active', Number(col.dataset.index) === index));
    this.#tip.replaceChildren(...tipContent({
      category: this.#data.categories[index], series, index, unit: this.#root.dataset.unit ?? '', total: this.#form === 'stacked' && series.length > 1,
    }).filter(Boolean));
    this.#tip.classList.add(CHART.tipShown);
    placeTip(this.#tip, x, geo.frame.top, geo.width);
  }

  #drawCross(index, x, series) {
    const { frame, scale } = this.#geo;
    this.#overlay.append(s('line', { class: 'chart__cross', x1: Math.round(x) + 0.5, x2: Math.round(x) + 0.5, y1: frame.top, y2: frame.top + frame.height }));
    series.forEach((item) => {
      const value = item.values[index];
      if (value !== null) this.#overlay.append(s('circle', { class: 'chart__dot', cx: x, cy: scale(value), r: 4, style: { '--mark-color': colorOf(item.slot) } }));
    });
  }

  #hide() {
    this.#active = -1;
    this.#overlay?.replaceChildren();
    this.#svg?.classList.remove('chart__svg_focus');
    this.#tip?.classList.remove(CHART.tipShown);
  }

  #key(event) {
    const count = this.#data.categories.length;
    const moves = { ArrowRight: 1, ArrowLeft: -1, Home: -count, End: count };
    if (event.key === 'Escape') { this.#hide(); return; }
    if (!(event.key in moves)) return;
    event.preventDefault();
    const from = this.#active < 0 ? (moves[event.key] > 0 ? -1 : count) : this.#active;
    this.#show(Math.max(0, Math.min(count - 1, from + moves[event.key])));
  }

  // ── легенда и вид ─────────────────────────────────────

  #toggleSeries(item, button) {
    if (!item.hidden && this.#visible().length === 1) return;
    item.hidden = !item.hidden;
    button.setAttribute('aria-pressed', String(!item.hidden));
    this.#render();
  }

  #toggleView(button) {
    const table = !this.#root.classList.contains(CHART.tableView);
    this.#root.classList.toggle(CHART.tableView, table);
    button.setAttribute('aria-pressed', String(table));
    button.textContent = table ? CHART.labels.chart : CHART.labels.table;
    if (!table) this.#render();
  }
}
