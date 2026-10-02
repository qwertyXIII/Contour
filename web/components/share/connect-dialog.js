// Окно «Подключить телефон»: серверы (Contour и по одному на страну) — QR и ссылка,
// правила — ссылка и «открыть в Shadowrocket», и как включить. Ключи приходят
// отдельным запросом на открытие окна и в разделе не хранятся.
import { api, toast } from '../../utils/api.js';
import { API } from '../../utils/constants.js';
import { copyText } from '../../utils/copy.js';
import { h } from '../../utils/dom.js';

const HINT = {
  plain: 'Обычный: заблокированное — через дом и VPN, остальное телефон открывает сам.',
  country: (c) => `Для поездок: всё, что телефон пошлёт сюда, выйдет в интернет с адресом страны ${c} — из дома.`,
};
const COPIED = { server: 'Ссылка сервера скопирована — открой Shadowrocket', config: 'Ссылка на правила скопирована' };

export class ConnectDialog {
  #dlg;
  #links = null;
  #node = 0;

  constructor() {
    this.#dlg = document.getElementById('dlg-share');
    this.#dlg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-share-copy]');
      if (b) void this.#copy(b.dataset.shareCopy);
    });
    this.#dlg.addEventListener('change', (e) => {
      if (e.target.name === 'share-node') this.#show(Number(e.target.value));
    });
    this.#dlg.addEventListener('close', () => { this.#links = null; });
  }

  async open(id) {
    try {
      this.#links = await api(`${API.shareDevice(id)}/links`);
    } catch (error) {
      toast(error.message, 'danger');
      return;
    }
    const l = this.#links;
    this.#dlg.querySelector('[data-share-title]').textContent = `Подключить «${l.name}»`;
    this.#dlg.querySelector('[data-share-config]').textContent = l.config;
    this.#dlg.querySelector('[data-share-open]').href = l.open;
    // Переключатель серверов — каждый раз заново: у телефона может прибавиться страна.
    this.#dlg.querySelector('[data-share-nodes]').replaceChildren(h('div', { class: 'segmented segmented_wide', role: 'radiogroup', 'aria-label': 'Сервер' },
      l.nodes.map((n, i) => h('label', { class: 'segmented__option' },
        h('input', { class: 'segmented__input visually-hidden', type: 'radio', name: 'share-node', value: String(i), checked: i === 0 }),
        h('span', { class: 'segmented__label', text: n.name })))));
    const country = l.nodes.find((n) => n.country);
    this.#dlg.querySelector('[data-share-group]').textContent = country
      ? `DIRECT, пока ты дома; уехал — ${country.name}`
      : 'групп стран нет (share.countries пуст)';
    this.#show(0);
    this.#dlg.showModal();
  }

  #show(index) {
    const n = this.#links?.nodes[index];
    if (!n) return;
    this.#node = index;
    this.#dlg.querySelector('[data-share-qr]').src = n.qr;
    this.#dlg.querySelector('[data-share-qr]').alt = `QR сервера ${n.name}`;
    this.#dlg.querySelector('[data-share-server]').textContent = n.server;
    this.#dlg.querySelector('[data-share-hint]').textContent = n.country ? HINT.country(n.country) : HINT.plain;
  }

  async #copy(what) {
    const text = what === 'server' ? this.#links?.nodes[this.#node]?.server : this.#links?.config;
    if (!text) return;
    if (await copyText(text)) toast(COPIED[what], 'ok');
    else toast('Не скопировалось — выдели ссылку и скопируй вручную', 'danger');
  }
}
