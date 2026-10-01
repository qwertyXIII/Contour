// Устройства и программы, которые ходят через Contour: скорость, трафик за день,
// когда были видны. Устройство называется по MAC — имя переживает смену адреса.
// У устройства — режим шлюза (src/gateway.ts): с ним через VPN идёт всё нужное,
// не только сайты, — голос, игры, QUIC.
// Разметка собирается один раз; тик меняет только значения (utils/view.js).
import { api, toast } from '../../utils/api.js';
import { API, EVENTS } from '../../utils/constants.js';
import { button, empty, group, h } from '../../utils/dom.js';
import { selectField } from '../../utils/select-field.js';
import { ago, bytes, speed } from '../../utils/format.js';
import { listSection, rowView, setHidden, setText } from '../../utils/view.js';
import { whoName } from '../overview/overview.js';

const GATEWAY = [
  { value: '', text: 'Шлюз: выкл' },
  { value: 'blocked', text: 'Шлюз: заблокированное' },
  { value: 'all', text: 'Шлюз: всё через VPN' },
];
const GATEWAY_NOTE = { blocked: 'шлюз: заблокированное через VPN', all: 'шлюз: всё через VPN' };

/** Отметка в панели — ещё не шлюз: пока на устройстве маршрутизатор — роутер, его пакеты идут мимо сервера. */
function gatewayNote(c) {
  if (!c.gateway) return null;
  if (c.gatewayActive === false) return `шлюз ждёт: на устройстве маршрутизатор — ${c.router}`;
  return GATEWAY_NOTE[c.gateway];
}

function itemRow(first) {
  const device = first.kind === 'device';
  const rename = device ? button('Имя', { icon: 'edit', view: 'ghost' }) : null;
  const gateway = device ? selectField(null, 'Режим шлюза') : null;
  const row = rowView(device ? 'monitor' : 'terminal');
  // Выбор шлюза и имя — строкой под устройством, а не справа: на телефоне справа им не хватит места.
  const controls = device ? h('div', { class: 'cluster cluster_gap_s' }, gateway.el, rename) : null;
  return {
    el: device ? h('div', { class: 'stack stack_gap_s' }, row.el, controls) : row.el,
    update(c) {
      row.set({
        title: whoName(c),
        note: device ? [c.ip, c.mac ?? 'MAC не виден', gatewayNote(c), c.lastSeen ? `был ${ago(c.lastSeen)}` : null].filter(Boolean).join(' · ') : `программа на сервере · была ${ago(c.lastSeen)}`,
        meta: `↓ ${speed(c.rate.down)} · сегодня ${bytes(c.today.down + c.today.up)}`,
        tone: c.rate.down + c.rate.up > 0 ? 'accent' : undefined,
      });
      if (!rename) return;
      setHidden(controls, !c.mac);
      if (c.mac) gateway.update({ gw: c.mac }, GATEWAY, c.gateway ?? '');
      // Данные для диалога — в атрибутах кнопки: слушатель один, на разделе.
      rename.dataset.rename = c.mac ?? '';
      rename.dataset.title = `${c.ip} · ${c.mac ?? ''}`;
      rename.dataset.current = c.name ?? '';
    },
  };
}

export class Devices {
  #root;
  #dialog;
  #devices;
  #programs;
  #note;
  #help;
  #address = '';
  #editing = null;

  constructor(root) {
    this.#root = root;
    this.#dialog = document.getElementById('dlg-device');
  }

  init() {
    this.#devices = listSection((c) => c.who, itemRow, empty('tv', 'Пока никого', 'Поставь на устройстве DNS 192.168.0.50 — и оно появится здесь.'));
    this.#programs = listSection((c) => c.who, itemRow, empty('terminal', 'Никого', null));
    const devicesGroup = group('Устройства дома', ' ', this.#devices.el);
    this.#note = devicesGroup.querySelector('.group__note');
    this.#help = h('p', { class: 'callout__text' });
    const help = h('div', { class: 'callout callout_tone_info' },
      h('div', { class: 'callout__body' }, h('p', { class: 'callout__title', text: 'Шлюз — для голоса, игр и всего, что не сайт' }), this.#help));
    this.#root.append(devicesGroup, help, group('Программы на сервере', 'по токенам прокси', this.#programs.el));
    document.addEventListener(EVENTS.state, (e) => { if (!this.#root.hidden) this.#update(e.detail); });
    this.#root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rename]');
      if (b?.dataset.rename) this.#open(b.dataset.rename, b.dataset.title, b.dataset.current ?? '');
    });
    this.#root.addEventListener('change', (e) => {
      if (e.target.matches('.select__native[data-gw]')) void this.#gateway(e.target.dataset.gw, e.target.value || null);
    });
    this.#dialog.querySelector('[data-device-form]').addEventListener('submit', (e) => {
      if (e.submitter?.value === 'save') void this.#save(e.currentTarget.elements.name.value);
    });
    return this;
  }

  #open(mac, title, current) {
    this.#editing = mac;
    this.#dialog.querySelector('[data-device-about]').textContent = title;
    this.#dialog.querySelector('#device-name').value = current;
    this.#dialog.showModal();
  }

  async #save(name) {
    try {
      await api(API.device(this.#editing), { method: 'POST', body: { name } });
      toast(name ? `Теперь это «${name}»` : 'Имя снято', 'ok');
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async #gateway(mac, mode) {
    try {
      await api(`${API.device(mac)}/gateway`, { method: 'POST', body: { mode }, timeout: 30_000 });
      toast(mode ? `Шлюз включён — теперь на устройстве: IP вручную, маршрутизатор ${this.#address}` : 'Шлюз выключен — на устройстве верни «IP автоматически»', 'ok');
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  #update(state) {
    this.#address = state.lan.address;
    setText(this.#note, `ходят через VPN, когда DNS — ${state.lan.address}`);
    setText(this.#help, `Включи шлюз у устройства и на нём в настройках Wi-Fi поставь: IP — вручную${state.lan.freeIp ? `, например ${state.lan.freeIp}` : ''}, маска 255.255.255.0, маршрутизатор и DNS — ${state.lan.address}. Заблокированное (или всё — в режиме «всё через VPN») пойдёт через VPN любым протоколом. Сервер выключен — у такого устройства дома нет интернета; вернуть — «IP автоматически».`);
    this.#devices.render(state.consumers.filter((c) => c.kind === 'device').map((c) => ({ ...c, router: state.lan.address })));
    this.#programs.render(state.consumers.filter((c) => c.kind === 'program'));
  }
}
