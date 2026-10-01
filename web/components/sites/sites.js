// Сайты: что идёт через VPN и почему — ручные решения, выученное, трафик.
// Ручное решение сильнее общего списка и самообучения; «Авто» его снимает.
// Разметка собирается один раз; обновление меняет только строки (utils/view.js).
import { api, toast } from '../../utils/api.js';
import { API, TIMING } from '../../utils/constants.js';
import { button, empty, group, h } from '../../utils/dom.js';
import { ago, bytes, dateTime } from '../../utils/format.js';
import { badgeView, listSection, rowView, setText } from '../../utils/view.js';

const VIA = { tunnel: ['через VPN', 'accent'], direct: ['напрямую', null] };

/** Строка сайта с кнопкой решения; имя сайта — в атрибуте кнопки, слушатель один на разделе. */
function siteRow(label, via, withBadge = false) {
  const act = button(label, { view: 'ghost', data: { via } });
  const status = withBadge ? badgeView() : null;
  const row = rowView(null, status ? h('span', { class: 'cluster cluster_gap_s' }, status.el, act) : act);
  return { act, status, row };
}

function manualRow() {
  const v = siteRow('Авто', 'auto', true);
  return { el: v.row.el, update: ([name, via]) => { v.row.set({ title: name }); v.status.set(...VIA[via]); v.act.dataset.site = name; } };
}

function topRow() {
  const v = siteRow('Не через VPN', 'direct');
  return {
    el: v.row.el,
    update: (s) => {
      v.row.set({ title: s.host, note: `${s.who.length} ${s.who.length === 1 ? 'источник' : 'источника'} · ${ago(s.last)}`, meta: bytes(s.bytes) });
      v.act.dataset.site = s.host;
    },
  };
}

function learnedRow() {
  const v = siteRow('Напрямую', 'direct');
  return { el: v.row.el, update: (l) => { v.row.set({ title: l.name, note: `${l.why} · до ${dateTime(l.until)}` }); v.act.dataset.site = l.name; } };
}

export class Sites {
  #root;
  #manual;
  #top;
  #learned;
  #learnedNote;
  #timer = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#manual = listSection(([name]) => name, manualRow, empty('star', 'Своих решений нет', 'Всё решают общий список и автоматика.'));
    this.#top = listSection((s) => s.host, topRow, empty('globe', 'Пока пусто', null));
    this.#learned = listSection((l) => l.name, learnedRow, empty('radar', 'Ничего не выучено', 'Сайты из общего списка сюда не попадают — они через VPN сразу.'));
    const learnedGroup = group('Выучено: через VPN', ' ', this.#learned.el);
    this.#learnedNote = learnedGroup.querySelector('.group__note');
    this.#root.append(this.#form(), group('Мои решения', null, this.#manual.el), group('Сайты с трафиком через VPN', 'с последнего перезапуска', this.#top.el), learnedGroup);
    this.#root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-site]');
      if (b) void this.#set(b.dataset.site, b.dataset.via);
    });
    // Своя частота: вкладка видна — раз в 10 с, иначе молчим.
    new MutationObserver(() => this.#watch()).observe(this.#root, { attributes: true, attributeFilter: ['hidden'] });
    return this;
  }

  #watch() {
    clearInterval(this.#timer);
    if (this.#root.hidden) return;
    void this.#load();
    this.#timer = setInterval(() => void this.#load(), TIMING.slowMs);
  }

  #form() {
    const input = h('input', { class: 'input__control', name: 'site', placeholder: 'instagram.com', autocomplete: 'off', 'aria-label': 'Сайт' });
    const choice = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Как вести' },
      ['tunnel', 'direct'].map((v, i) => h('label', { class: 'segmented__option' },
        h('input', { class: 'segmented__input visually-hidden', type: 'radio', name: 'via', value: v, checked: i === 0 }),
        h('span', { class: 'segmented__label', text: v === 'tunnel' ? 'Всегда через VPN' : 'Никогда' }))));
    const form = h('form', { class: 'card stack stack_gap_m' },
      h('div', { class: 'input' }, input),
      h('div', { class: 'cluster cluster_justify_between' }, choice, h('button', { class: 'button button_view_primary', type: 'submit' }, h('span', { class: 'button__text', text: 'Сохранить' }))));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.#set(input.value, form.elements.via.value).then((ok) => { if (ok) input.value = ''; });
    });
    return group('Свой выбор', 'сильнее списков и автоматики; с поддоменами', form);
  }

  async #set(name, via) {
    try {
      await api(API.sites, { method: 'POST', body: { name, via } });
      toast(via === 'auto' ? `«${name}» — решает автоматика` : `«${name}» — ${VIA[via][0]}`, 'ok');
      void this.#load();
      return true;
    } catch (error) {
      toast(error.message, 'danger');
      return false;
    }
  }

  async #load() {
    let d;
    try {
      d = await api(API.sites);
    } catch {
      return;
    }
    setText(this.#learnedNote, `напрямую не открылись · ещё в общем списке ${d.common} сайтов`);
    this.#manual.render(Object.entries(d.overrides));
    this.#top.render(d.top.slice(0, 40));
    this.#learned.render(d.learnedTunnel);
  }
}
