// Окно «Подключить телефон»: QR сервера, ссылка на правила, «открыть в Shadowrocket».
// Ключи приходят отдельным запросом на открытие окна и в разделе не хранятся.
import { api, toast } from '../../utils/api.js';
import { API } from '../../utils/constants.js';
import { copyText } from '../../utils/copy.js';

const COPIED = { server: 'Сервер скопирован — открой Shadowrocket', config: 'Ссылка на правила скопирована' };

export class ConnectDialog {
  #dlg;
  #links = null;

  constructor() {
    this.#dlg = document.getElementById('dlg-share');
    this.#dlg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-share-copy]');
      if (b) void this.#copy(b.dataset.shareCopy);
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
    this.#dlg.querySelector('[data-share-qr]').src = l.qr;
    this.#dlg.querySelector('[data-share-config]').textContent = l.config;
    this.#dlg.querySelector('[data-share-open]').href = l.open;
    this.#dlg.showModal();
  }

  async #copy(what) {
    const text = this.#links?.[what];
    if (!text) return;
    if (await copyText(text)) toast(COPIED[what], 'ok');
    else toast('Не скопировалось — выдели ссылку и скопируй вручную', 'danger');
  }
}
