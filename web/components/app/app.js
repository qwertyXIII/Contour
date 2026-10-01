// Каркас панели: вход и выход, опрос сервера, ожидание после перезапуска.
// Данные расходятся событиями — разделы друг о друге не знают:
//   contour:state   — обзор раз в TIMING.stateMs (detail — ответ /api/state);
//   contour:history — история за сутки раз в TIMING.historyMs;
//   contour:restart — раздел что-то поменял, Contour перезапускается: ждём и обновляем.
import { api, ApiError, toast } from '../../utils/api.js';
import { API, EVENTS, TIMING } from '../../utils/constants.js';
import { speed } from '../../utils/format.js';

export class App {
  #root;
  #timers = [];
  #headline;

  constructor(root) {
    this.#root = root;
    this.#headline = root.querySelector('[data-headline]');
  }

  init() {
    this.#root.querySelector('[data-login]').addEventListener('submit', (e) => { e.preventDefault(); void this.#login(e.currentTarget); });
    this.#root.querySelector('[data-logout]').addEventListener('click', () => void this.#logout());
    document.addEventListener(EVENTS.authLost, () => this.#show('login'));
    document.addEventListener(EVENTS.restart, (e) => void this.#waitRestart(e.detail?.text));
    // Переключили вкладку — свежие данные сразу, а не через тик.
    this.#root.addEventListener('click', (e) => { if (e.target.closest('.tabs__tab')) setTimeout(() => this.#tick(), 0); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.#tick(); });
    void this.#boot();
    return this;
  }

  async #boot() {
    try {
      const me = await api(API.me);
      if (me.authed) this.#start();
      else this.#show('login', me.configured ? '' : 'Пароль панели не задан — sudo bash deploy/panel-password.sh');
    } catch (error) {
      this.#show('login', error.message);
    }
  }

  #show(view, message = '') {
    for (const el of this.#root.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== view;
    if (view !== 'app') this.#stop();
    const err = this.#root.querySelector('[data-login-error]');
    err.textContent = message;
    err.hidden = !message;
    if (view === 'login') this.#root.querySelector('#login-password')?.focus();
  }

  async #login(form) {
    const password = form.elements.password.value;
    try {
      await api(API.login, { method: 'POST', body: { password } });
      form.reset();
      this.#start();
    } catch (error) {
      this.#show('login', error instanceof ApiError ? error.message : 'не вышло');
    }
  }

  async #logout() {
    await api(API.logout, { method: 'POST' }).catch(() => undefined);
    this.#show('login');
  }

  #start() {
    this.#show('app');
    this.#stop();
    this.#tick();
    void this.#history();
    this.#timers.push(setInterval(() => this.#tick(), TIMING.stateMs), setInterval(() => void this.#history(), TIMING.historyMs));
  }

  #stop() {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }

  async #tick() {
    if (document.hidden) return;
    try {
      const state = await api(API.state);
      this.#headline.textContent = this.#headlineOf(state);
      document.dispatchEvent(new CustomEvent(EVENTS.state, { detail: state }));
    } catch (error) {
      if (error.code === 'NETWORK') this.#headline.textContent = 'нет связи с Contour';
    }
  }

  async #history() {
    try {
      document.dispatchEvent(new CustomEvent(EVENTS.history, { detail: await api(API.history) }));
    } catch {
      // следующий раз
    }
  }

  #headlineOf(state) {
    const alive = state.outlets.filter((o) => o.state === 'alive').length;
    const down = state.consumers.reduce((s, c) => s + c.rate.down, 0);
    const outs = alive === 0 ? 'ни один выход не отвечает' : `выходов работает: ${alive} из ${state.outlets.length}`;
    return `${outs} · сейчас ${speed(down)}`;
  }

  /** После правки выхода помощник перезапускает Contour: ждём, пока он вернётся. */
  async #waitRestart(text = 'Contour перезапускается…') {
    toast(text);
    this.#stop();
    const until = Date.now() + TIMING.restartWaitMs;
    await new Promise((r) => setTimeout(r, 1_500));
    while (Date.now() < until) {
      try {
        const me = await api(API.me, { timeout: 2_000 });
        if (me.authed) { this.#start(); toast('Contour снова на связи', 'ok'); return; }
        this.#show('login');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    toast('Contour не вернулся за 40 с — посмотри журнал на сервере', 'danger');
    this.#start();
  }
}
