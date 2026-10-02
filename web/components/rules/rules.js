// Правила «что + куда»: проверить, куда пойдёт сайт; свои списки (по ссылке,
// файлом, вручную) с назначением; все источники числами. Один набор правил на
// прокси, телевизор, шлюз и телефоны. Разметка собирается один раз; опрос
// меняет только значения.
import { api, toast } from '../../utils/api.js';
import { API, TIMING } from '../../utils/constants.js';
import { button, empty, group, h } from '../../utils/dom.js';
import { plural } from '../../utils/format.js';
import { cardList, setHidden } from '../../utils/view.js';
import { confirmDialog } from '../outlets/confirm.js';
import { addForm } from './add-form.js';
import { checkView, listCard, sourcesView } from './views.js';

export class Rules {
  #root;
  #check;
  #host;
  #lists;
  #cards = new Map();
  #form;
  #sources;
  #titles = {};
  #timer = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#root.append(this.#checkView(), this.#listsView(), this.#sourcesGroup());
    this.#listen();
    new MutationObserver(() => this.#watch()).observe(this.#root, { attributes: true, attributeFilter: ['hidden'] });
    return this;
  }

  #checkView() {
    this.#host = h('input', { class: 'input__control', name: 'host', placeholder: 'chatgpt.com или 172.16.42.2', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Сайт или адрес' });
    const submit = button('Проверить', { icon: 'search', view: 'primary' });
    submit.type = 'submit';
    const form = h('form', { class: 'cluster cluster_gap_s cluster_nowrap' }, h('div', { class: 'input' }, this.#host), submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); void this.#run(); });
    this.#check = checkView();
    return group('Куда пойдёт сайт', 'какое правило его берёт и через какой выход Contour его поведёт', h('div', { class: 'card stack stack_gap_l' }, form, this.#check.el));
  }

  #listsView() {
    this.#lists = cardList((l) => l.id, (l) => {
      const card = listCard(l);
      this.#cards.set(l.id, card);
      return { el: card.el, update: (x) => card.update(x, this.#titles) };
    }, empty('list', 'Своих списков нет', 'Добавь готовый список по ссылке или файлом — или свой, с разделами «куда».'));
    this.#form = addForm((body) => this.#add(body));
    return group('Свои списки', 'ручной — сильнее загруженных, загруженный — сильнее выученного; внутри — точное сильнее широкого', this.#lists.el, this.#form.el);
  }

  #sourcesGroup() {
    this.#sources = sourcesView();
    return group('Набор целиком', 'встроенное (свой и общий список, подсети сервисов, страны, выученное) и твоё', this.#sources.el);
  }

  #listen() {
    this.#root.addEventListener('change', (e) => {
      const t = e.target.closest('input[data-rules-act="enable"]');
      if (t) void this.#post(API.rulesList(t.dataset.id), { enabled: t.checked }, t.checked ? 'Список действует' : 'Список выключен');
    });
    this.#root.addEventListener('menu:select', (e) => {
      const card = e.target.closest('article[data-id]');
      if (!card) return;
      const { id, title } = card.dataset;
      if (e.detail.value === 'remove') void this.#remove(id, title);
      if (e.detail.value === 'refresh') void this.#post(`${API.rulesList(id)}/refresh`, {}, `«${title}» обновлён`);
      if (e.detail.value === 'text') void this.#text(id);
    });
  }

  #watch() {
    clearInterval(this.#timer);
    if (this.#root.hidden) return;
    void this.#load();
    this.#timer = setInterval(() => void this.#load(), TIMING.slowMs);
  }

  async #run() {
    const host = this.#host.value.trim();
    if (!host) return;
    try {
      this.#check.set(await api(API.rulesCheck(host)), this.#titles);
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async #add(body) {
    try {
      const l = await api(API.rulesLists, { method: 'POST', body });
      toast(`«${l.title}»: ${plural(l.stats?.entries ?? 0, ['правило', 'правила', 'правил'])}`, 'ok');
      void this.#load();
      return true;
    } catch (error) {
      toast(error.message, 'danger');
      return false;
    }
  }

  async #text(id) {
    const card = this.#cards.get(id);
    if (!card) return;
    if (!card.text.hidden) { setHidden(card.text, true); return; }
    try {
      card.text.textContent = (await api(`${API.rulesList(id)}/text`)).text || '(пусто)';
      setHidden(card.text, false);
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async #remove(id, title) {
    if (!(await confirmDialog(`Удалить «${title}»?`, 'Его правила перестанут действовать сразу — у прокси, телевизора и телефонов.', 'Удалить'))) return;
    try {
      await api(API.rulesList(id), { method: 'DELETE' });
      toast(`«${title}» удалён`, 'ok');
      void this.#load();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async #post(path, body, done) {
    try {
      await api(path, { method: 'POST', body });
      toast(done, 'ok');
    } catch (error) {
      toast(error.message, 'danger');
    }
    void this.#load();
  }

  async #load() {
    let d;
    try {
      d = await api(API.rules);
    } catch {
      return;
    }
    this.#titles = Object.fromEntries(d.countries.map((c) => [c.code, c.title]));
    this.#form.set(d.countries, d.outlets);
    this.#lists.render(d.lists);
    this.#sources.set(d.sources);
  }
}
