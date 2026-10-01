// Выходы: состояние туннелей, замер скорости, перезапуск, вкл/выкл, удаление,
// добавление. Всё, что требует root, делает помощник contour-root.
// Карточка собирается один раз; тик меняет только значения (utils/view.js).
import { api, toast } from '../../utils/api.js';
import { API, EVENTS, TIMING } from '../../utils/constants.js';
import { button, empty, group, h } from '../../utils/dom.js';
import { ago, bytes, secondsAgo, speed } from '../../utils/format.js';
import { badgeView, glyphView, Keyed, setHidden, setText } from '../../utils/view.js';
import { outletStatus } from '../overview/overview.js';
import { AddOutlet } from './add-outlet.js';
import { confirmDialog } from './confirm.js';

const KIND = { netns: 'ядро, своё пространство сети', mihomo: 'mihomo' };
const PROTO = { amneziawg: 'AmneziaWG', wireguard: 'WireGuard', openvpn: 'OpenVPN', link: 'ссылка', subscription: 'подписка' };
const UNIT_TONE = { active: 'ok', failed: 'danger', inactive: null, activating: 'warn' };

/** Порты выхода словами: «все», «режет 9339, 5222…» или «не проверены». */
function portsText(p) {
  if (!p) return null;
  if (p.filter === 'all') return `все${p.checkedAt ? `, проверено ${ago(p.checkedAt)}` : ''}`;
  if (p.filter === 'unknown') return 'не проверены';
  const shown = p.cut.slice(0, 6).join(', ');
  return `только ходовые: режет ${shown}${p.cut.length > 6 ? ` и ещё ${p.cut.length - 6}` : ''}`;
}

/** Строки карточки — все сразу; ненужные этому выходу прячутся, а не пересобираются. */
const FIELDS = [
  ['ip', 'Внешний адрес', (o) => o.externalIp ?? '—'],
  ['latency', 'Задержка', (o) => (o.latencyMs ? `${o.latencyMs} мс` : '—')],
  ['now', 'Сейчас', (o) => `↓ ${speed(o.rate.down)} · ↑ ${speed(o.rate.up)}`],
  ['today', 'Сегодня', (o) => bytes(o.today.down + o.today.up)],
  ['tunnel', 'Туннель', (o) => (o.kind !== 'netns' ? null : o.tunnelUp ? 'поднят' : 'не поднят')],
  ['handshake', 'Рукопожатие', (o) => (o.kind !== 'netns' || o.protocol === 'openvpn' ? null : secondsAgo(o.handshakeAgoS))],
  ['traffic', 'Через туннель', (o) => (o.kind !== 'netns' ? null : o.tunnelRx === null ? '—' : `↓ ${bytes(o.tunnelRx)} · ↑ ${bytes(o.tunnelTx)}`)],
  ['priority', 'Приоритет', (o) => String(o.priority ?? '—')],
  ['speed', 'Последний замер', (o) => (o.speed ? `${o.speed.mbps} Мбит/с, ${ago(o.speed.at)}` : null)],
  ['ports', 'Порты', (o) => (o.enabled ? portsText(o.ports) : null)],
  ['error', 'Ошибка', (o) => (o.lastError && o.state !== 'alive' ? o.lastError : null)],
];

function outletCard() {
  const lead = glyphView('globe');
  const title = h('h3', { class: 'bar__title' });
  const subtitle = h('p', { class: 'bar__subtitle' });
  const status = badgeView();
  const fields = FIELDS.map(([key, label, value]) => {
    const dt = h('dt', { class: 'kv__key', text: label });
    const dd = h('dd', { class: 'kv__value' });
    return { key, value, dt, dd };
  });
  const speedBtn = button('Замерить', { icon: 'activity', data: { act: 'speed' } });
  const portsBtn = button('Проверить порты', { icon: 'scan', view: 'ghost', data: { act: 'ports' } });
  const restartBtn = button('Перезапустить', { icon: 'refresh', view: 'ghost', data: { act: 'restart' } });
  const toggleBtn = button('', { icon: 'power', view: 'ghost', data: { act: 'toggle' } });
  const removeBtn = button('Удалить', { icon: 'trash', view: 'danger', data: { act: 'remove' } });
  const toggleText = h('span', { class: 'button__text' });
  toggleBtn.append(toggleText);
  const el = h('article', { class: 'card stack stack_gap_m' },
    h('header', { class: 'bar bar_size_s' }, lead.el, h('div', { class: 'bar__text' }, title, subtitle), h('div', { class: 'bar__end' }, status.el)),
    h('dl', { class: 'kv' }, fields.flatMap((f) => [f.dt, f.dd])),
    h('div', { class: 'cluster cluster_gap_s' }, speedBtn, portsBtn, restartBtn, toggleBtn, removeBtn));
  return {
    el,
    update(o) {
      lead.tone(o.state === 'alive' ? 'accent' : undefined);
      setText(title, o.name);
      setText(subtitle, [PROTO[o.protocol] ?? o.protocol, KIND[o.kind]].filter(Boolean).join(' · ') || 'данных помощника нет');
      status.set(...outletStatus(o));
      for (const f of fields) {
        const v = f.value(o);
        setHidden(f.dt, v === null);
        setHidden(f.dd, v === null);
        if (v !== null) setText(f.dd, v);
      }
      setHidden(speedBtn, !o.enabled);
      setHidden(portsBtn, !o.enabled);
      setText(toggleText, o.enabled ? 'Выключить' : 'Включить');
      for (const b of [speedBtn, portsBtn, restartBtn, toggleBtn, removeBtn]) b.dataset.name = o.name;
    },
  };
}

function unitBadge() {
  const b = badgeView();
  return { el: b.el, update: ([unit, s]) => b.set(`${unit.replace('.service', '')}: ${s}`, UNIT_TONE[s]) };
}

export class Outlets {
  #root;
  #add;
  #cards;
  #cardsBox;
  #empty;
  #units;
  #unitsCard;
  #rootWarn;
  #rootWarnText;
  #last = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    this.#add = new AddOutlet(document.getElementById('dlg-outlet')).init();
    this.#build();
    document.addEventListener(EVENTS.state, (e) => {
      this.#last = e.detail;
      if (!this.#root.hidden) this.#update(e.detail);
    });
    this.#root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) void this.#act(b.dataset.act, b.dataset.name, b);
    });
    return this;
  }

  #build() {
    this.#cardsBox = h('div', { class: 'console__grid' });
    this.#cards = new Keyed(this.#cardsBox, (o) => o.name, outletCard);
    this.#empty = empty('key', 'Выходов нет', 'Добавь ключ AmneziaWG, WireGuard, OpenVPN или ссылку VLESS.');
    const unitsBox = h('div', { class: 'cluster cluster_gap_s' });
    this.#units = new Keyed(unitsBox, ([unit]) => unit, unitBadge);
    this.#unitsCard = h('div', { class: 'card' }, unitsBox);
    this.#rootWarnText = h('p', { class: 'callout__text' });
    this.#rootWarn = h('div', { class: 'callout callout_tone_warn', hidden: true },
      h('div', { class: 'callout__body' }, h('p', { class: 'callout__title', text: 'Помощник от root недоступен' }), this.#rootWarnText));
    this.#root.append(
      h('div', { class: 'cluster cluster_justify_between' },
        h('p', { class: 'text text_tone_muted', text: 'Трафик идёт в живой выход с меньшим приоритетом; упал — сразу в следующий.' }),
        button('Добавить выход', { icon: 'plus', view: 'primary', size: 'm', data: { act: 'add' } })),
      this.#cardsBox, this.#empty,
      group('Службы', null, this.#unitsCard, this.#rootWarn));
  }

  #update(state) {
    this.#cards.render(state.outlets);
    setHidden(this.#cardsBox, state.outlets.length === 0);
    setHidden(this.#empty, state.outlets.length > 0);
    this.#units.render(Object.entries(state.units));
    setHidden(this.#unitsCard, Boolean(state.rootError));
    setHidden(this.#rootWarn, !state.rootError);
    setText(this.#rootWarnText, state.rootError ? `${state.rootError}. Управлять выходами нельзя, смотреть — можно.` : '');
  }

  async #act(act, name, el) {
    if (act === 'add') { this.#add.open(); return; }
    if (act === 'speed') { await this.#speed(name, el); return; }
    if (act === 'ports') { await this.#ports(name, el); return; }
    const o = this.#last?.outlets.find((x) => x.name === name);
    if (act === 'remove' && !(await confirmDialog(`Удалить выход «${name}»?`, 'Ключ уедет в keys/removed на сервере — вернуть можно руками.', 'Удалить'))) return;
    const req = {
      restart: [`${API.outlet(name)}/restart`, {}],
      toggle: [`${API.outlet(name)}/enable`, { enabled: !o?.enabled }],
      remove: [API.outlet(name), undefined],
    }[act];
    if (!req) return;
    await this.#busy(el, async () => {
      await api(req[0], { method: act === 'remove' ? 'DELETE' : 'POST', body: req[1], timeout: 120_000 });
      if (act !== 'restart' || o?.kind === 'mihomo') document.dispatchEvent(new CustomEvent(EVENTS.restart));
      else toast(`Выход «${name}» перезапущен`, 'ok');
    });
  }

  async #speed(name, el) {
    await this.#busy(el, async () => {
      const r = await api(API.speedtest, { method: 'POST', body: { outlet: name }, timeout: TIMING.speedtestMs });
      toast(`«${name}»: ${r.mbps} Мбит/с (${bytes(r.bytes)} за ${(r.ms / 1000).toFixed(1)} с)`, 'ok');
    }, `Замер «${name}»: `);
  }

  async #ports(name, el) {
    await this.#busy(el, async () => {
      const r = await api(API.ports, { method: 'POST', body: { outlet: name }, timeout: TIMING.portsMs });
      toast(r.summary, r.filter === 'all' ? 'ok' : 'warn');
    }, `Порты «${name}»: `);
  }

  /** Кнопка крутится, пока идёт действие; ошибка — тостом. */
  async #busy(el, job, prefix = '') {
    el.classList.add('button_loading');
    el.disabled = true;
    try {
      await job();
    } catch (error) {
      toast(`${prefix}${error.message}`, 'danger');
    } finally {
      el.classList.remove('button_loading');
      el.disabled = false;
    }
  }
}
