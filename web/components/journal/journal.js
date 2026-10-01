// Журнал: что Contour сделал и заметил — выход упал и поднялся, переключение,
// сайт ушёл в VPN, вход в панель. Последние записи сверху. Новые записи
// добавляются к списку, старые остаются на месте (utils/view.js).
import { api } from '../../utils/api.js';
import { API, TIMING } from '../../utils/constants.js';
import { empty, group } from '../../utils/dom.js';
import { dateTime } from '../../utils/format.js';
import { badgeView, listSection, rowView, setHidden } from '../../utils/view.js';

const LEVEL = { info: [null, null], warn: ['внимание', 'warn'], error: ['ошибка', 'danger'] };

function entryRow() {
  const level = badgeView();
  const row = rowView(null, level.el);
  return {
    el: row.el,
    update(e) {
      const [text, tone] = LEVEL[e.level] ?? LEVEL.info;
      row.set({ title: e.text, note: `${dateTime(e.t)}${e.src ? ` · ${e.src}` : ''}` });
      level.set(text ?? '', tone);
      setHidden(level.el, !text);
    },
  };
}

export class Journal {
  #root;
  #list;
  #timer = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#list = listSection((e) => `${e.t}|${e.text}`, entryRow, empty('history', 'Пусто', null));
    this.#root.append(group('Журнал', 'с последнего перезапуска Contour; DNS ведёт свой — /var/log/contour/dns.log', this.#list.el));
    new MutationObserver(() => {
      clearInterval(this.#timer);
      if (this.#root.hidden) return;
      void this.#load();
      this.#timer = setInterval(() => void this.#load(), TIMING.slowMs);
    }).observe(this.#root, { attributes: true, attributeFilter: ['hidden'] });
    return this;
  }

  async #load() {
    try {
      this.#list.render(await api(API.journal));
    } catch {
      // следующий раз
    }
  }
}
