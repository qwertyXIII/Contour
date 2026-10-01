// Раздача: телефоны, которые ходят через Contour из любой сети (Shadowrocket).
// Решает телефон: заблокированное — через дом, остальное — напрямую. Здесь —
// адрес снаружи и маршрут, который владелец заводит в nginx (LogViewer), телефоны
// и окно подключения. Разметка собирается один раз; опрос меняет только значения.
import { api, toast } from '../../utils/api.js';
import { API, TIMING } from '../../utils/constants.js';
import { button, empty, group, h } from '../../utils/dom.js';
import { ago, bytes, speed } from '../../utils/format.js';
import { listSection, rowView, setHidden, setText } from '../../utils/view.js';
import { confirmDialog } from '../outlets/confirm.js';
import { ConnectDialog } from './connect-dialog.js';

function deviceRow() {
  const row = rowView('phone');
  const open = button('Подключить', { icon: 'scan', view: 'ghost', data: { shareAct: 'open' } });
  const toggle = button('Выключить', { view: 'ghost', data: { shareAct: 'enable' } });
  const remove = button(null, { icon: 'trash', view: 'ghost', label: 'Удалить', data: { shareAct: 'remove' } });
  const toggleText = toggle.querySelector('.button__text');
  return {
    // Кнопки — строкой под телефоном: справа на узком экране им не хватит места.
    el: h('div', { class: 'stack stack_gap_s' }, row.el, h('div', { class: 'cluster cluster_gap_s' }, open, toggle, remove)),
    update(x) {
      row.set({
        title: x.name,
        note: [x.enabled ? null : 'выключен', x.lastSeen ? `был ${ago(x.lastSeen)}` : 'ещё не ходил'].filter(Boolean).join(' · '),
        meta: `↓ ${speed(x.rate.down)} · сегодня ${bytes(x.today.down + x.today.up)}`,
        tone: x.rate.down + x.rate.up > 0 ? 'accent' : undefined,
      });
      setText(toggleText, x.enabled ? 'Выключить' : 'Включить');
      for (const b of [open, toggle, remove]) {
        b.dataset.id = x.id;
        b.dataset.name = x.name;
        b.dataset.enabled = String(x.enabled);
      }
    },
  };
}

/** Что завести в nginx (LogViewer) для домена раздачи. */
function routeView() {
  const values = {};
  const pair = (key, label) => [h('dt', { class: 'kv__key', text: label }), (values[key] = h('dd', { class: 'kv__value' }))];
  const kv = h('dl', { class: 'kv kv_layout_stack' },
    ...pair('domain', 'Домен и сертификат'), ...pair('edge', 'Путь /'), ...pair('list', 'Путь /list/'), ...pair('flags', 'Ещё'));
  const el = h('div', { class: 'callout callout_tone_info' }, h('div', { class: 'callout__body stack stack_gap_s' },
    h('p', { class: 'callout__title', text: 'Маршрут в nginx — заводишь сам, в LogViewer' }), kv));
  return {
    el,
    set(d) {
      setText(values.domain, d.domain ?? 'сначала впиши адрес выше');
      setText(values.edge, `→ http://127.0.0.1:${d.ports.edge} — край; чужие пути он отвергает сам`);
      setText(values.list, `→ http://127.0.0.1:${d.ports.list} — правила для телефонов`);
      setText(values.flags, 'WebSocket — включён, таймаут чтения — 3600 с');
    },
  };
}

export class Share {
  #root;
  #domain;
  #route;
  #devices;
  #note;
  #off;
  #body;
  #connect;
  #timer = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#connect = new ConnectDialog();
    this.#route = routeView();
    this.#devices = listSection((x) => x.id, deviceRow, empty('phone', 'Телефонов нет', 'Добавь телефон ниже — и подключи его в Shadowrocket.'));
    const devicesGroup = group('Телефоны', ' ', this.#devices.el);
    this.#note = devicesGroup.querySelector('.group__note');
    this.#off = h('div', { class: 'callout callout_tone_warn', hidden: true }, h('div', { class: 'callout__body' },
      h('p', { class: 'callout__title', text: 'Раздача выключена' }), h('p', { class: 'callout__text', text: 'В /etc/contour/contour.yaml стоит share.enabled: false.' })));
    this.#body = h('div', { class: 'stack stack_gap_l' }, this.#domainForm(), this.#route.el, devicesGroup, this.#addForm());
    this.#root.append(this.#off, this.#body);
    this.#root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-share-act]');
      if (b) void this.#act(b.dataset.shareAct, b.dataset);
    });
    new MutationObserver(() => this.#watch()).observe(this.#root, { attributes: true, attributeFilter: ['hidden'] });
    return this;
  }

  #watch() {
    clearInterval(this.#timer);
    if (this.#root.hidden) return;
    void this.#load();
    this.#timer = setInterval(() => void this.#load(), TIMING.slowMs);
  }

  #domainForm() {
    this.#domain = h('input', { class: 'input__control', name: 'domain', placeholder: 'contour.example.ru', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Адрес снаружи' });
    const form = h('form', { class: 'card cluster cluster_gap_s' },
      h('div', { class: 'input' }, this.#domain),
      h('button', { class: 'button button_view_primary', type: 'submit' }, h('span', { class: 'button__text', text: 'Сохранить' })));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.#post(API.shareSettings, { domain: this.#domain.value }, 'Адрес сохранён');
    });
    return group('Адрес снаружи', 'домен, который nginx ведёт сюда; телефон подключается к нему на 443', form);
  }

  #addForm() {
    const input = h('input', { class: 'input__control', name: 'name', placeholder: 'Мой iPhone', maxlength: '40', autocomplete: 'off', 'aria-label': 'Имя телефона' });
    const form = h('form', { class: 'card cluster cluster_gap_s' },
      h('div', { class: 'input' }, input),
      h('button', { class: 'button button_view_primary', type: 'submit' }, h('span', { class: 'button__text', text: 'Добавить' })));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.#post(API.shareDevices, { name: input.value }, 'Телефон добавлен — нажми «Подключить»').then((ok) => { if (ok) input.value = ''; });
    });
    return group('Новый телефон', 'у каждого свой ключ: выключил один — остальные работают', form);
  }

  async #act(what, d) {
    if (what === 'open') { await this.#connect.open(d.id); return; }
    if (what === 'enable') {
      const on = d.enabled !== 'true';
      await this.#post(`${API.shareDevice(d.id)}/enable`, { enabled: on }, on ? `«${d.name}» включён` : `«${d.name}» выключен — через дом больше не ходит`);
      return;
    }
    if (!(await confirmDialog(`Удалить «${d.name}»?`, 'Его ключ перестанет работать сразу. Вернуть нельзя — только добавить заново и подключить снова.', 'Удалить'))) return;
    try {
      await api(API.shareDevice(d.id), { method: 'DELETE' });
      toast(`«${d.name}» удалён`, 'ok');
      void this.#load();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async #post(path, body, done) {
    try {
      await api(path, { method: 'POST', body });
      toast(done, 'ok');
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
    setText(this.#note, d.running ? 'край работает' : d.devices.some((x) => x.enabled) ? 'край поднимается…' : 'край не запущен — нет включённых телефонов');
    this.#devices.render(d.devices);
  }
}
