// Календарь активности. Данные — data-start (первый день) и data-values
// (по числу в день). Ступени — по четвертям ненулевых дней, как у GitHub:
// шкала честная для любого разброса, а пустой день всегда пустой.
// Стрелки: влево-вправо — неделя, вверх-вниз — день.
import { HEATMAP } from '../../utils/constants.js';
import { h } from '../../utils/dom.js';

const DAY = 86400000;
const plural = (n, [one, few, many]) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  return m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

export class Heatmap {
  #root;
  #days = [];
  #cells = [];
  #grid;
  #tip;
  #active = -1;
  #unit;

  constructor(root) {
    this.#root = root;
  }

  init() {
    const start = new Date(`${this.#root.dataset.start}T00:00:00`);
    const values = (this.#root.dataset.values ?? '').split(',').map((v) => Math.max(0, Number(v) || 0));
    if (Number.isNaN(start.getTime()) || !values.length) return this;
    this.#unit = (this.#root.dataset.unit ?? 'раз|раза|раз').split('|');
    const cuts = this.#cuts(values);
    this.#days = values.map((value, i) => {
      const date = new Date(start.getTime() + i * DAY);
      return { date, value, level: value ? 1 + cuts.filter((cut) => value > cut).length : 0 };
    });
    this.#build();
    this.#bind();
    return this;
  }

  // Границы ступеней 1–4: четверти ненулевых значений.
  #cuts(values) {
    const sorted = values.filter(Boolean).sort((a, b) => a - b);
    if (!sorted.length) return [];
    return [0.25, 0.5, 0.75].map((q) => sorted[Math.floor(q * (sorted.length - 1))]);
  }

  #build() {
    const offset = (this.#days[0].date.getDay() + 6) % 7;
    const weeks = Math.ceil((offset + this.#days.length) / 7);
    this.#cells = this.#days.map((day, i) => {
      const slot = offset + i;
      return h('span', { class: `heatmap__cell heatmap__cell_level_${day.level}`, 'data-index': i, style: { 'grid-row': `${(slot % 7) + 1}`, 'grid-column': `${Math.floor(slot / 7) + 1}` } });
    });
    this.#grid = h('div', { class: 'heatmap__grid', tabindex: 0, role: 'group', 'aria-roledescription': 'календарь', 'aria-label': `${this.#summary()}. ${HEATMAP.hint}` }, this.#cells);
    const body = h('div', { class: 'heatmap__body' }, this.#months(offset, weeks), this.#weekdays(), this.#grid);
    const scroll = h('div', { class: 'heatmap__scroll' }, body);
    this.#tip = h('div', { class: 'heatmap__tip', 'aria-hidden': 'true' });
    this.#root.append(scroll, this.#foot(), this.#tip, this.#table());
    requestAnimationFrame(() => { scroll.scrollLeft = scroll.scrollWidth; });
  }

  #months(offset, weeks) {
    const labels = [];
    let last = -3;
    for (let week = 0; week < weeks; week += 1) {
      const first = Math.max(0, week * 7 - offset);
      const day = this.#days.slice(first, week * 7 - offset + 7).find((d) => d.date.getDate() === 1) ?? (week === 0 ? this.#days[0] : null);
      if (!day || week - last < 3) continue;
      last = week;
      labels.push(h('span', { class: 'heatmap__month', style: { 'grid-column': `${week + 1}` }, text: HEATMAP.month.format(day.date).replace('.', '').slice(0, 3) }));
    }
    return h('div', { class: 'heatmap__months', 'aria-hidden': 'true' }, labels);
  }

  #weekdays() {
    return h('div', { class: 'heatmap__days', 'aria-hidden': 'true' }, HEATMAP.weekdays.map((name) => h('span', { class: 'heatmap__day', text: name })));
  }

  #total() {
    return this.#days.reduce((sum, day) => sum + day.value, 0);
  }

  #summary() {
    const total = this.#total();
    return `${HEATMAP.number.format(total)} ${plural(total, this.#unit)} за ${this.#days.length} дн.`;
  }

  #foot() {
    const scale = h('span', { class: 'heatmap__scale', 'aria-hidden': 'true' }, HEATMAP.less,
      [0, 1, 2, 3, 4].map((level) => h('span', { class: `heatmap__cell heatmap__cell_level_${level}` })), HEATMAP.more);
    return h('div', { class: 'heatmap__foot' }, h('span', { text: this.#summary() }), scale);
  }

  // Двойник для скринридера: итоги по месяцам (365 ячеек вслух не читают).
  #table() {
    const months = new Map();
    this.#days.forEach(({ date, value }) => {
      const key = HEATMAP.monthLong.format(date);
      months.set(key, (months.get(key) ?? 0) + value);
    });
    return h('table', { class: 'visually-hidden' },
      h('caption', { text: this.#summary() }),
      h('tbody', {}, [...months].map(([month, sum]) => h('tr', {}, h('th', { text: month }), h('td', { text: `${sum} ${plural(sum, this.#unit)}` })))));
  }

  #bind() {
    this.#grid.addEventListener('pointerover', (event) => {
      const cell = event.target.closest('.heatmap__cell');
      if (cell) this.#show(Number(cell.dataset.index));
    });
    this.#grid.addEventListener('pointerleave', () => this.#hide());
    this.#grid.addEventListener('blur', () => this.#hide());
    this.#grid.addEventListener('keydown', (event) => this.#key(event));
  }

  #key(event) {
    const moves = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (event.key === 'Escape') { this.#hide(); return; }
    if (!(event.key in moves)) return;
    event.preventDefault();
    const from = this.#active < 0 ? this.#days.length - 1 : this.#active;
    const next = Math.max(0, Math.min(this.#days.length - 1, from + moves[event.key]));
    this.#show(next);
    this.#cells[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  #show(index) {
    this.#cells[this.#active]?.classList.remove('heatmap__cell_active');
    this.#active = index;
    const cell = this.#cells[index];
    const day = this.#days[index];
    cell.classList.add('heatmap__cell_active');
    this.#tip.replaceChildren(h('span', { class: 'heatmap__tip-value', text: `${day.value} ${plural(day.value, this.#unit)}` }), ` · ${HEATMAP.date.format(day.date)}`);
    this.#tip.classList.add('heatmap__tip_shown');
    const box = this.#root.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    const width = this.#tip.offsetWidth;
    const x = Math.max(0, Math.min(box.width - width, rect.left - box.left + rect.width / 2 - width / 2));
    this.#tip.style.setProperty('--tip-x', `${x}px`);
    this.#tip.style.setProperty('--tip-y', `${rect.top - box.top - this.#tip.offsetHeight - 8}px`);
  }

  #hide() {
    this.#cells[this.#active]?.classList.remove('heatmap__cell_active');
    this.#active = -1;
    this.#tip.classList.remove('heatmap__tip_shown');
  }
}
