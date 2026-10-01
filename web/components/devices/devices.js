// Устройства и программы, которые ходят через Contour: скорость, трафик за день,
// когда были видны. Устройство называется по MAC — имя переживает смену адреса.
// Разметка собирается один раз; тик меняет только значения (utils/view.js).
import { api, toast } from '../../utils/api.js';
import { API, EVENTS } from '../../utils/constants.js';
import { button, empty, group } from '../../utils/dom.js';
import { ago, bytes, speed } from '../../utils/format.js';
import { listSection, rowView, setHidden, setText } from '../../utils/view.js';
import { whoName } from '../overview/overview.js';

function itemRow(first) {
  const device = first.kind === 'device';
  const rename = device ? button('Имя', { icon: 'edit', view: 'ghost' }) : null;
  const row = rowView(device ? 'monitor' : 'terminal', rename);
  return {
    el: row.el,
    update(c) {
      row.set({
        title: whoName(c),
        note: device ? [c.ip, c.mac ?? 'MAC не виден', `был ${ago(c.lastSeen)}`].join(' · ') : `программа на сервере · была ${ago(c.lastSeen)}`,
        meta: `↓ ${speed(c.rate.down)} · сегодня ${bytes(c.today.down + c.today.up)}`,
        tone: c.rate.down + c.rate.up > 0 ? 'accent' : undefined,
      });
      if (!rename) return;
      setHidden(rename, !c.mac);
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
    this.#root.append(devicesGroup, group('Программы на сервере', 'по токенам прокси', this.#programs.el));
    document.addEventListener(EVENTS.state, (e) => { if (!this.#root.hidden) this.#update(e.detail); });
    this.#root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rename]');
      if (b?.dataset.rename) this.#open(b.dataset.rename, b.dataset.title, b.dataset.current ?? '');
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

  #update(state) {
    setText(this.#note, `ходят через VPN, когда DNS — ${state.lan.address}`);
    this.#devices.render(state.consumers.filter((c) => c.kind === 'device'));
    this.#programs.render(state.consumers.filter((c) => c.kind === 'program'));
  }
}
