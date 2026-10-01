// Журнал: что Contour сделал и заметил — выход упал и поднялся, переключение,
// сайт ушёл в VPN, вход в панель. Последние записи сверху.
import { api } from '../../utils/api.js';
import { API, TIMING } from '../../utils/constants.js';
import { badge, empty, group, h, list, row } from '../../utils/dom.js';
import { dateTime } from '../../utils/format.js';

const LEVEL = { info: [null, null], warn: ['внимание', 'warn'], error: ['ошибка', 'danger'] };

export class Journal {
  #root;
  #timer = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    new MutationObserver(() => {
      clearInterval(this.#timer);
      if (this.#root.hidden) return;
      void this.#load();
      this.#timer = setInterval(() => void this.#load(), TIMING.slowMs);
    }).observe(this.#root, { attributes: true, attributeFilter: ['hidden'] });
    return this;
  }

  async #load() {
    let entries;
    try {
      entries = await api(API.journal);
    } catch {
      return;
    }
    this.#root.replaceChildren(group('Журнал', 'с последнего перезапуска Contour; DNS ведёт свой — /var/log/contour/dns.log', entries.length === 0
      ? empty('history', 'Пусто', null)
      : list(entries.map((e) => {
        const [text, tone] = LEVEL[e.level] ?? LEVEL.info;
        return row({ title: e.text, note: `${dateTime(e.t)}${e.src ? ` · ${e.src}` : ''}`, trail: text ? badge(text, tone) : null });
      }))));
  }
}
