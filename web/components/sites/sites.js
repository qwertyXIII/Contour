// Сайты: что идёт через VPN и почему — ручные решения, выученное, трафик.
// Ручное решение сильнее общего списка и самообучения; «Авто» его снимает.
import { api, toast } from '../../utils/api.js';
import { API, TIMING } from '../../utils/constants.js';
import { badge, button, empty, group, h, list, row } from '../../utils/dom.js';
import { ago, bytes, dateTime } from '../../utils/format.js';

const VIA = { tunnel: ['через VPN', 'accent'], direct: ['напрямую', null] };

export class Sites {
  #root;
  #lists;
  #timer = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#lists = h('div', { class: 'stack stack_gap_l' });
    this.#root.append(this.#form(), this.#lists);
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
    try {
      this.#render(await api(API.sites));
    } catch {
      // следующий раз
    }
  }

  #render(d) {
    const manual = Object.entries(d.overrides);
    this.#lists.replaceChildren(
      group('Мои решения', null, manual.length === 0
        ? empty('star', 'Своих решений нет', 'Всё решают общий список и автоматика.')
        : list(manual.map(([name, via]) => row({ title: name, trail: h('span', { class: 'cluster cluster_gap_s' }, badge(...VIA[via]), button('Авто', { view: 'ghost', data: { site: name, via: 'auto' } })) })))),
      group('Сайты с трафиком через VPN', 'с последнего перезапуска', d.top.length === 0
        ? empty('globe', 'Пока пусто', null)
        : list(d.top.slice(0, 40).map((s) => row({
          title: s.host,
          note: `${s.who.length} ${s.who.length === 1 ? 'источник' : 'источника'} · ${ago(s.last)}`,
          meta: bytes(s.bytes),
          trail: button('Не через VPN', { view: 'ghost', data: { site: s.host, via: 'direct' } }),
        })))),
      group('Выучено: через VPN', `напрямую не открылись · ещё в общем списке ${d.common} сайтов`, d.learnedTunnel.length === 0
        ? empty('radar', 'Ничего не выучено', 'Сайты из общего списка сюда не попадают — они через VPN сразу.')
        : list(d.learnedTunnel.map((l) => row({ title: l.name, note: `${l.why} · до ${dateTime(l.until)}`, trail: button('Напрямую', { view: 'ghost', data: { site: l.name, via: 'direct' } }) })))),
    );
  }
}
