// Выходы: состояние туннелей, замер скорости, перезапуск, вкл/выкл, удаление,
// добавление. Всё, что требует root, делает помощник contour-root.
import { api, toast } from '../../utils/api.js';
import { API, EVENTS, TIMING } from '../../utils/constants.js';
import { badge, button, empty, glyph, group, h, kv } from '../../utils/dom.js';
import { ago, bytes, secondsAgo, speed } from '../../utils/format.js';
import { outletBadge } from '../overview/overview.js';
import { AddOutlet } from './add-outlet.js';
import { confirmDialog } from './confirm.js';

const KIND = { netns: 'ядро, своё пространство сети', mihomo: 'mihomo' };
const PROTO = { amneziawg: 'AmneziaWG', wireguard: 'WireGuard', openvpn: 'OpenVPN', link: 'ссылка', subscription: 'подписка' };
const UNIT_TONE = { active: 'ok', failed: 'danger', inactive: null, activating: 'warn' };

export class Outlets {
  #root;
  #add;
  #busy = new Set();
  #last = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#add = new AddOutlet(document.getElementById('dlg-outlet')).init();
    document.addEventListener(EVENTS.state, (e) => {
      this.#last = e.detail;
      if (!this.#root.hidden && this.#busy.size === 0 && !document.querySelector('dialog[open]')) this.#render(e.detail);
    });
    this.#root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) void this.#act(b.dataset.act, b.dataset.name, b);
    });
    return this;
  }

  async #act(act, name, el) {
    if (act === 'add') { this.#add.open(); return; }
    const o = this.#last?.outlets.find((x) => x.name === name);
    if (act === 'speed') return this.#speed(name, el);
    if (act === 'remove' && !(await confirmDialog(`Удалить выход «${name}»?`, 'Ключ уедет в keys/removed на сервере — вернуть можно руками.', 'Удалить'))) return;
    const req = {
      restart: [API.outlet(name) + '/restart', {}],
      toggle: [API.outlet(name) + '/enable', { enabled: !o?.enabled }],
      remove: [API.outlet(name), undefined],
    }[act];
    if (!req) return;
    this.#busy.add(name);
    try {
      await api(req[0], { method: act === 'remove' ? 'DELETE' : 'POST', body: req[1], timeout: 120_000 });
      const restarts = act !== 'restart' || o?.kind === 'mihomo';
      if (restarts) document.dispatchEvent(new CustomEvent(EVENTS.restart));
      else toast(`Выход «${name}» перезапущен`, 'ok');
    } catch (error) {
      toast(error.message, 'danger');
    } finally {
      this.#busy.delete(name);
    }
  }

  async #speed(name, el) {
    el.classList.add('button_loading');
    el.disabled = true;
    this.#busy.add(name);
    try {
      const r = await api(API.speedtest, { method: 'POST', body: { outlet: name }, timeout: TIMING.speedtestMs });
      toast(`«${name}»: ${r.mbps} Мбит/с (${bytes(r.bytes)} за ${(r.ms / 1000).toFixed(1)} с)`, 'ok');
    } catch (error) {
      toast(`Замер «${name}»: ${error.message}`, 'danger');
    } finally {
      this.#busy.delete(name);
      el.classList.remove('button_loading');
      el.disabled = false;
    }
  }

  #card(o) {
    const tunnel = o.kind === 'netns'
      ? [['Туннель', o.tunnelUp ? 'поднят' : 'не поднят'], o.protocol !== 'openvpn' ? ['Рукопожатие', secondsAgo(o.handshakeAgoS)] : null, ['Через туннель', o.tunnelRx === null ? '—' : `↓ ${bytes(o.tunnelRx)} · ↑ ${bytes(o.tunnelTx)}`]]
      : [];
    return h('article', { class: 'card stack stack_gap_m' },
      h('header', { class: 'bar bar_size_s' },
        glyph('globe', o.state === 'alive' ? 'accent' : undefined),
        h('div', { class: 'bar__text' }, h('h3', { class: 'bar__title', text: o.name }), h('p', { class: 'bar__subtitle', text: [PROTO[o.protocol] ?? o.protocol, KIND[o.kind]].filter(Boolean).join(' · ') || 'данных помощника нет' })),
        h('div', { class: 'bar__end' }, outletBadge(o))),
      kv([
        ['Внешний адрес', o.externalIp ?? '—'],
        ['Задержка', o.latencyMs ? `${o.latencyMs} мс` : '—'],
        ['Сейчас', `↓ ${speed(o.rate.down)} · ↑ ${speed(o.rate.up)}`],
        ['Сегодня', bytes(o.today.down + o.today.up)],
        ...tunnel,
        ['Приоритет', String(o.priority ?? '—')],
        o.speed ? ['Последний замер', `${o.speed.mbps} Мбит/с, ${ago(o.speed.at)}`] : null,
        o.lastError && o.state !== 'alive' ? ['Ошибка', o.lastError] : null,
      ]),
      h('div', { class: 'cluster cluster_gap_s' },
        o.enabled ? button('Замерить', { icon: 'activity', data: { act: 'speed', name: o.name } }) : null,
        button('Перезапустить', { icon: 'refresh', view: 'ghost', data: { act: 'restart', name: o.name } }),
        button(o.enabled ? 'Выключить' : 'Включить', { icon: 'power', view: 'ghost', data: { act: 'toggle', name: o.name } }),
        button('Удалить', { icon: 'trash', view: 'danger', data: { act: 'remove', name: o.name } })));
  }

  #units(state) {
    const entries = Object.entries(state.units);
    if (state.rootError) return h('div', { class: 'callout callout_tone_warn' }, h('div', { class: 'callout__body' }, h('p', { class: 'callout__title', text: 'Помощник от root недоступен' }), h('p', { class: 'callout__text', text: `${state.rootError}. Управлять выходами нельзя, смотреть — можно.` })));
    return h('div', { class: 'card' }, h('div', { class: 'cluster cluster_gap_s' }, entries.map(([u, s]) => badge(`${u.replace('.service', '')}: ${s}`, UNIT_TONE[s]))));
  }

  #render(state) {
    this.#root.replaceChildren(
      h('div', { class: 'cluster cluster_justify_between' },
        h('p', { class: 'text text_tone_muted', text: 'Трафик идёт в живой выход с меньшим приоритетом; упал — сразу в следующий.' }),
        button('Добавить выход', { icon: 'plus', view: 'primary', size: 'm', data: { act: 'add' } })),
      state.outlets.length === 0
        ? empty('key', 'Выходов нет', 'Добавь ключ AmneziaWG, WireGuard, OpenVPN или ссылку VLESS.')
        : h('div', { class: 'console__grid' }, state.outlets.map((o) => this.#card(o))),
      group('Службы', null, this.#units(state)),
    );
  }
}
