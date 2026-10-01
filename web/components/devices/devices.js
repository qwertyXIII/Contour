// Устройства и программы, которые ходят через Contour: скорость, трафик за день,
// когда были видны. Устройство называется по MAC — имя переживает смену адреса.
import { api, toast } from '../../utils/api.js';
import { API, EVENTS } from '../../utils/constants.js';
import { button, empty, glyph, group, h, list, row } from '../../utils/dom.js';
import { ago, bytes, speed } from '../../utils/format.js';
import { whoName } from '../overview/overview.js';

export class Devices {
  #root;
  #dialog;
  #editing = null;

  constructor(root) {
    this.#root = root;
    this.#dialog = document.getElementById('dlg-device');
  }

  init() {
    document.addEventListener(EVENTS.state, (e) => { if (!this.#root.hidden && !this.#dialog.open) this.#render(e.detail); });
    this.#root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rename]');
      if (b) this.#open(b.dataset.rename, b.dataset.title, b.dataset.current ?? '');
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

  #item(c) {
    const note = c.kind === 'device'
      ? [c.ip, c.mac ?? 'MAC не виден', `был ${ago(c.lastSeen)}`].join(' · ')
      : `программа на сервере · была ${ago(c.lastSeen)}`;
    const rename = c.kind === 'device' && c.mac
      ? button('Имя', { icon: 'edit', view: 'ghost', data: { rename: c.mac, title: `${c.ip} · ${c.mac}`, current: c.name ?? '' } })
      : null;
    return row({
      lead: glyph(c.kind === 'device' ? 'monitor' : 'terminal', c.rate.down + c.rate.up > 0 ? 'accent' : undefined),
      title: whoName(c),
      note,
      meta: `↓ ${speed(c.rate.down)} · сегодня ${bytes(c.today.down + c.today.up)}`,
      trail: rename,
    });
  }

  #render(state) {
    const devices = state.consumers.filter((c) => c.kind === 'device');
    const programs = state.consumers.filter((c) => c.kind === 'program');
    this.#root.replaceChildren(
      group('Устройства дома', `ходят через VPN, когда DNS — ${state.lan.address}`, devices.length === 0
        ? empty('tv', 'Пока никого', `Поставь на устройстве DNS ${state.lan.address} — и оно появится здесь.`)
        : list(devices.map((c) => this.#item(c)))),
      group('Программы на сервере', 'по токенам прокси', programs.length === 0
        ? empty('terminal', 'Никого', null)
        : list(programs.map((c) => this.#item(c)))),
    );
  }
}
