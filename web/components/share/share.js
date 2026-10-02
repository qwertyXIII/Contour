// Раздача: телефоны, которые ходят через Contour из любой сети (Shadowrocket).
// Решает телефон: заблокированное — через Contour и его выходы, остальное —
// напрямую; уехал — сайты страны через выход в этой стране (сервер «Contour-XX»,
// стране его открывают в карточке телефона). Здесь — что работает (плитки),
// телефоны, страны выходов, адрес снаружи и маршрут nginx. Разметка собирается
// один раз; опрос меняет только значения.
import { api, toast } from '../../utils/api.js';
import { API, TIMING } from '../../utils/constants.js';
import { button, empty, group, h, svgIcon } from '../../utils/dom.js';
import { bytes } from '../../utils/format.js';
import { cardList, Keyed, setHidden, setText } from '../../utils/view.js';
import { confirmDialog } from '../outlets/confirm.js';
import { ConnectDialog } from './connect-dialog.js';
import { countryCard, deviceCard, routeView, tileView } from './views.js';

/** Поле с кнопкой в одну строку: адрес снаружи, новый телефон. */
function inlineForm(input, text, icon, onSubmit) {
  const submit = button(text, { icon, view: 'primary' });
  submit.type = 'submit';
  // Карточка и строка — разными узлами: обе задают раскладку и на одном элементе спорят.
  const form = h('form', { class: 'cluster cluster_gap_s cluster_nowrap' }, h('div', { class: 'input' }, input), submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); void onSubmit(); });
  return h('div', { class: 'card' }, form);
}

export class Share {
  #root;
  #domain;
  #tiles = {};
  #route;
  #devices;
  #devicesNote;
  #countries;
  #countryBox;
  #countryGroup;
  #off;
  #body;
  #connect;
  #timer = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#connect = new ConnectDialog();
    this.#off = h('div', { class: 'callout callout_tone_warn', hidden: true }, h('div', { class: 'callout__body' },
      h('p', { class: 'callout__title', text: 'Раздача выключена' }), h('p', { class: 'callout__text', text: 'В /etc/contour/contour.yaml стоит share.enabled: false.' })));
    this.#body = h('div', { class: 'stack stack_gap_l' }, this.#tilesView(), this.#devicesView(), this.#countriesView(), this.#domainView());
    this.#root.append(this.#off, this.#body);
    this.#listen();
    new MutationObserver(() => this.#watch()).observe(this.#root, { attributes: true, attributeFilter: ['hidden'] });
    return this;
  }

  #tilesView() {
    this.#tiles.edge = tileView('Вход', 'shield-check');
    this.#tiles.phones = tileView('Телефоны', 'phone');
    this.#tiles.today = tileView('Сегодня', 'activity');
    this.#tiles.countries = tileView('Страны', 'globe');
    return h('div', { class: 'tiles' }, ...Object.values(this.#tiles).map((t) => t.el));
  }

  #devicesView() {
    this.#devices = cardList((x) => x.id, deviceCard, empty('phone', 'Телефонов нет', 'Добавь телефон ниже — и подключи его в Shadowrocket.'));
    const name = h('input', { class: 'input__control', name: 'name', placeholder: 'Мой iPhone', maxlength: '40', autocomplete: 'off', 'aria-label': 'Имя телефона' });
    const add = inlineForm(name, 'Добавить', 'plus', async () => {
      if (await this.#post(API.shareDevices, { name: name.value }, 'Телефон добавлен — нажми «Подключить»')) name.value = '';
    });
    const g = group('Телефоны', ' ', this.#devices.el, add);
    this.#devicesNote = g.querySelector('.group__note');
    return g;
  }

  #countriesView() {
    this.#countryBox = h('div', { class: 'stack stack_gap_l' });
    this.#countries = new Keyed(this.#countryBox, (c) => c.code, (c) => countryCard(c.code));
    // Памятка для поездок — одна на раздел: в каждой стране она одинаковая.
    const tip = h('div', { class: 'callout callout_tone_info' }, svgIcon('plane', 'callout__icon'), h('div', { class: 'callout__body' },
      h('p', { class: 'callout__title', text: 'Уехал из страны' }),
      h('p', { class: 'callout__text', text: 'В Shadowrocket на главной, в группе страны, выбери её сервер (Contour-RU, Contour-DE) — её сайты пойдут с её адресом. Вернулся — DIRECT. Заблокированное в обоих случаях идёт через Contour.' })));
    this.#countryGroup = group('Выход в другой стране', 'страны выходов Contour: у каждой свой сервер в телефоне — местные банки и госсервисы не пускают чужие адреса', this.#countryBox, tip);
    return this.#countryGroup;
  }

  #domainView() {
    this.#domain = h('input', { class: 'input__control', name: 'domain', placeholder: 'contour.example.ru', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Адрес снаружи' });
    const form = inlineForm(this.#domain, 'Сохранить', 'check', () => this.#post(API.shareSettings, { domain: this.#domain.value }, 'Адрес сохранён'));
    this.#route = routeView();
    return group('Адрес снаружи', 'домен, который nginx ведёт сюда; телефон подключается к нему на 443', form, this.#route.el);
  }

  #listen() {
    this.#root.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-share-act="open"]');
      if (b) void this.#connect.open(b.dataset.id);
    });
    this.#root.addEventListener('change', (e) => {
      const t = e.target.closest('input[data-share-act="enable"]');
      if (t) void this.#enable(t.dataset.id, t.dataset.name, t.checked);
      const c = e.target.closest('input[data-share-act="country"]');
      if (c) void this.#country(c.dataset, c.checked);
    });
    this.#root.addEventListener('menu:select', (e) => {
      const card = e.target.closest('article[data-id]');
      if (!card) return;
      if (e.detail.value === 'open') void this.#connect.open(card.dataset.id);
      if (e.detail.value === 'remove') void this.#remove(card.dataset.id, card.dataset.name);
    });
    this.#root.addEventListener('chip:remove', (e) => {
      const code = e.target.closest('[data-share-chips]')?.dataset.shareChips;
      if (code) void this.#site(code, e.detail.value, false);
    });
    this.#root.addEventListener('submit', (e) => {
      const form = e.target.closest('form[data-share-site]');
      if (!form) return;
      e.preventDefault();
      const input = form.querySelector('input');
      void this.#site(form.dataset.shareSite, input.value, true).then((ok) => { if (ok) input.value = ''; });
    });
  }

  #watch() {
    clearInterval(this.#timer);
    if (this.#root.hidden) return;
    void this.#load();
    this.#timer = setInterval(() => void this.#load(), TIMING.slowMs);
  }

  async #enable(id, name, on) {
    await this.#post(`${API.shareDevice(id)}/enable`, { enabled: on }, on ? `«${name}» снова ходит через дом` : `«${name}» выключен — через дом больше не ходит`);
  }

  #country({ id, name, code, title }, on) {
    const done = on ? `«${name}»: ${title} открыта — обнови подписку в Shadowrocket` : `«${name}»: ${title} закрыта`;
    return this.#post(`${API.shareDevice(id)}/countries/${encodeURIComponent(code)}`, { on }, done);
  }

  async #remove(id, name) {
    if (!(await confirmDialog(`Удалить «${name}»?`, 'Его ключи перестанут работать сразу. Вернуть нельзя — только добавить заново и подключить снова.', 'Удалить'))) return;
    try {
      await api(API.shareDevice(id), { method: 'DELETE' });
      toast(`«${name}» удалён`, 'ok');
      void this.#load();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  #site(code, name, on) {
    return this.#post(API.shareCountrySites(code), { name, on }, on ? `«${name}» — в группе страны ${code}` : `«${name}» убран из списка`);
  }

  async #post(path, body, done) {
    try {
      await api(path, { method: 'POST', body });
      toast(done, 'ok');
      void this.#load();
      return true;
    } catch (error) {
      toast(error.message, 'danger');
      void this.#load();
      return false;
    }
  }

  async #load() {
    let d;
    try {
      d = await api(API.share);
    } catch {
      return;
    }
    setHidden(this.#off, d.enabled);
    setHidden(this.#body, !d.enabled);
    if (!d.enabled) return;
    // Своё поле не трогаем, пока в нём печатают.
    if (document.activeElement !== this.#domain) this.#domain.value = d.domain ?? '';
    this.#route.set(d);
    this.#update(d);
  }

  #update(d) {
    const on = d.devices.filter((x) => x.enabled);
    const now = d.devices.filter((x) => x.enabled && x.rate.down + x.rate.up > 0);
    const today = d.devices.reduce((s, x) => s + x.today.down + x.today.up, 0);
    const alive = d.countries.filter((c) => c.exit?.alive);
    this.#tiles.edge.set(d.running ? 'работает' : on.length > 0 ? 'поднимается' : 'спит', d.domain ?? 'адрес не задан', d.running);
    this.#tiles.phones.set(String(d.devices.length), now.length > 0 ? `сейчас ходят: ${now.length}` : `включено: ${on.length}`);
    this.#tiles.today.set(bytes(today), 'через Contour, TCP');
    this.#tiles.countries.set(String(alive.length), d.countries.length > 0 ? d.countries.map((c) => c.title).join(', ') : 'страна выходов ещё не известна', alive.length > 0);
    setText(this.#devicesNote, 'у каждого свои ключи и свои страны: выключил один — остальные работают');
    this.#devices.render(d.devices.map((x) => ({ ...x, all: d.countries })));
    this.#countries.render(d.countries);
    setHidden(this.#countryGroup, d.countries.length === 0);
  }
}
