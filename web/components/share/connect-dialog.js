// Окно «Подключить телефон»: подписка (один QR — все серверы телефона) или
// серверы по одному запасным путём, правила — ссылка и «открыть в Shadowrocket»,
// и как включить, с группами открытых телефону стран. Ключи приходят отдельным
// запросом на открытие окна и в разделе не хранятся.
import { api, toast } from '../../utils/api.js';
import { API } from '../../utils/constants.js';
import { copyText } from '../../utils/copy.js';
import { h, svgIcon } from '../../utils/dom.js';

const SUBSCRIPTION = -1;
const HINT = {
  subscription: 'Все серверы этого телефона одной ссылкой. Откроешь ему страну — её сервер появится сам, когда Shadowrocket обновит подписку.',
  plain: 'Запасной путь, без подписки. Обычный сервер: заблокированное — через Contour и его выходы, остальное телефон открывает сам.',
  country: (title) => `Запасной путь, без подписки. Всё, что телефон пошлёт сюда, выйдет в интернет в стране «${title}».`,
};
const COPIED = { server: 'Ссылка скопирована — открой Shadowrocket', config: 'Ссылка на правила скопирована' };

export class ConnectDialog {
  #dlg;
  #links = null;
  #node = SUBSCRIPTION;
  #steps;

  constructor() {
    this.#dlg = document.getElementById('dlg-share');
    this.#steps = this.#dlg.querySelector('[data-share-steps]');
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
    this.#q('title').textContent = `Подключить «${l.name}»`;
    this.#q('config').textContent = l.config;
    this.#q('open').href = l.open;
    // Переключатель — каждый раз заново: у телефона может прибавиться страна.
    const options = [[SUBSCRIPTION, 'Подписка'], ...l.nodes.map((n, i) => [i, n.name])];
    this.#q('nodes').replaceChildren(h('div', { class: 'segmented segmented_wide segmented_scroll', role: 'radiogroup', 'aria-label': 'Что добавить' },
      options.map(([value, text]) => h('label', { class: 'segmented__option' },
        h('input', { class: 'segmented__input visually-hidden', type: 'radio', name: 'share-node', value: String(value), checked: value === SUBSCRIPTION }),
        h('span', { class: 'segmented__label', text })))));
    this.#q('servers').replaceChildren(...l.nodes.map((n) => h('span', { class: `badge${n.country ? ' badge_tone_info' : ' badge_tone_accent'}` }, svgIcon(n.country ? 'globe' : 'server', 'badge__icon'), n.name)));
    this.#groups(l.nodes.filter((n) => n.country));
    this.#show(SUBSCRIPTION);
    this.#dlg.showModal();
  }

  #q(name) {
    return this.#dlg.querySelector(`[data-share-${name}]`);
  }

  /** Шаг 3 — группа на каждую открытую телефону страну; прежние строки групп убираются. */
  #groups(countries) {
    for (const old of this.#steps.querySelectorAll('[data-share-group]')) old.remove();
    const rows = countries.length > 0
      ? countries.flatMap((n) => [
        h('dt', { class: 'kv__key', dataset: { shareGroup: '' }, text: `Группа «${n.group}»` }),
        h('dd', { class: 'kv__value', dataset: { shareGroup: '' }, text: `DIRECT, пока ты там; уехал — ${n.name}` })])
      : [h('dt', { class: 'kv__key', dataset: { shareGroup: '' }, text: 'Группы стран' }),
        h('dd', { class: 'kv__value', dataset: { shareGroup: '' }, text: 'нет — стран этому телефону не открыто (карточка телефона)' })];
    this.#steps.append(...rows);
  }

  #current() {
    const l = this.#links;
    if (!l) return null;
    if (this.#node === SUBSCRIPTION) return { link: l.subscription.url, qr: l.subscription.qr, open: l.subscription.open, hint: HINT.subscription, alt: 'QR подписки' };
    const n = l.nodes[this.#node];
    return n ? { link: n.server, qr: n.qr, open: n.open, hint: n.country ? HINT.country(n.group) : HINT.plain, alt: `QR сервера ${n.name}` } : null;
  }

  #show(index) {
    this.#node = index;
    const c = this.#current();
    if (!c) return;
    this.#q('qr').src = c.qr;
    this.#q('qr').alt = c.alt;
    this.#q('server').textContent = c.link;
    this.#q('hint').textContent = c.hint;
    this.#q('add').href = c.open;
    this.#q('servers').hidden = index !== SUBSCRIPTION;
    this.#q('dup').hidden = index !== SUBSCRIPTION;
  }

  async #copy(what) {
    const text = what === 'server' ? this.#current()?.link : this.#links?.config;
    if (!text) return;
    if (await copyText(text)) toast(COPIED[what], 'ok');
    else toast('Не скопировалось — выдели ссылку и скопируй вручную', 'danger');
  }
}
