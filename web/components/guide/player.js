// Плеер ролика: время, один цикл кадров (засыпает сам, когда стоим), пуск и пауза,
// шаг вперёд и назад, «сначала», полоса шагов, повтор по кругу с паузой на конце.
// Сам играет, когда сцена видна и вкладка браузера открыта; ушла из вида — пауза,
// вернулась — играет дальше (если не остановили кнопкой). «Меньше движения» — без
// автопуска и без полётов: показывается кадр конца шага, шаги — мгновенно.
import { QUERIES } from '/shared/utils/constants.js';
import { setIcon } from '/shared/utils/dom.js';
import { reduced } from '/shared/utils/motion.js';
import { frameLoop } from '/shared/utils/springs.js';
import { h, svgIcon } from '../../utils/dom.js';

/** Последний кадр стоит столько, прежде чем ролик начнётся снова. */
const HOLD_MS = 2600;
const KEYS = { ArrowLeft: -1, ArrowRight: 1 };

function control(icon, label, view = 'ghost') {
  return h('button', { class: `button button_view_${view} button_shape_round${view === 'ghost' ? ' button_size_s' : ''}`, type: 'button', 'aria-label': label }, svgIcon(icon, 'button__icon'));
}

export class Player {
  el;
  #reel;
  #stage;
  #onStep;
  #t = 0;
  #step = -1;
  #playing = false;
  #held = false;
  #visible = false;
  #loop;
  #seen;
  #play;
  #count;
  #fills = [];
  #painted = -1;
  #onHidden = () => this.#auto();
  #still = window.matchMedia(QUERIES.reducedMotion);
  #onStill = () => { this.#painted = -1; this.#auto(); this.#render(); };

  #titles;
  #now;

  constructor(reel, stage, { titles, onStep }) {
    this.#reel = reel;
    this.#titles = titles;
    this.#stage = stage;
    this.#onStep = onStep;
    const segs = titles.map((title, i) => {
      const fill = h('span', { class: 'reel__fill' });
      this.#fills.push(fill);
      return h('button', { class: 'reel__seg', type: 'button', 'aria-label': `Шаг ${i + 1}: ${title}`, dataset: { reelStep: String(i) } }, fill);
    });
    this.#play = control('play', 'Смотреть', 'primary');
    // Какой шаг идёт — над полосой: на телефоне список шагов под роликом, его не видно.
    this.#count = h('span', { class: 'reel__count' });
    this.#now = h('span', { class: 'reel__title' });
    const restart = control('refresh', 'Сначала');
    const prev = control('skip-prev', 'Предыдущий шаг');
    const next = control('skip-next', 'Следующий шаг');
    this.el = h('div', { class: 'reel', role: 'group', 'aria-label': 'Ролик' },
      h('p', { class: 'reel__now', 'aria-hidden': 'true' }, this.#count, this.#now),
      h('div', { class: 'reel__track' }, segs),
      h('div', { class: 'reel__bar' }, restart, prev, this.#play, next));
    this.#play.addEventListener('click', () => this.toggle());
    restart.addEventListener('click', () => this.seek(0, true));
    prev.addEventListener('click', () => this.seek(this.#step - 1, true));
    next.addEventListener('click', () => this.seek(this.#step + 1, true));
    this.el.addEventListener('click', (e) => {
      const seg = e.target.closest('[data-reel-step]');
      if (seg) this.seek(Number(seg.dataset.reelStep), true);
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key in KEYS) {
        e.preventDefault();
        this.seek(this.#step + KEYS[e.key], true);
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.seek(0, true);
      }
    });
    this.#loop = frameLoop((dt) => this.#tick(dt));
    // Видна ли сцена: вкладка панели спрятана (hidden) — тоже «не видна».
    this.#seen = new IntersectionObserver(([entry]) => {
      this.#visible = entry.isIntersecting;
      this.#auto();
    }, { threshold: 0.35 });
    this.#seen.observe(stage.el);
    document.addEventListener('visibilitychange', this.#onHidden);
    this.#still.addEventListener('change', this.#onStill);
    this.#render();
  }

  /** Перерисовать кадр: сцена сменила размер, пришёл шрифт. */
  repaint() {
    this.#painted = -1;
    this.#stage.snap();
    this.#render();
  }

  /** Остановить всё: сценарий сменили, плеер уходит со страницы. */
  destroy() {
    this.#playing = false;
    this.#seen.disconnect();
    this.#stage.destroy();
    document.removeEventListener('visibilitychange', this.#onHidden);
    this.#still.removeEventListener('change', this.#onStill);
  }

  /** Кнопка «смотреть / пауза» — решение человека: автопуск его не перебивает. */
  toggle() {
    this.#held = this.#playing;
    this.#set(!this.#playing);
  }

  /** Перемотать к шагу; `go` — и смотреть его (нажали шаг — значит, хотят увидеть). */
  seek(i, go = false) {
    const steps = this.#reel.steps;
    const step = Math.min(steps.length - 1, Math.max(0, i));
    this.#t = steps[step].start;
    this.#stage.snap();
    this.#render();
    if (go && !reduced()) {
      this.#held = false;
      this.#set(true);
    }
  }

  #auto() {
    const want = this.#visible && !document.hidden && !this.#held && !reduced();
    if (want !== this.#playing) this.#set(want);
  }

  #set(on) {
    this.#playing = on;
    setIcon(this.#play.querySelector('.icon'), on ? 'pause' : 'play');
    this.#play.setAttribute('aria-label', on ? 'Пауза' : 'Смотреть');
    if (on) this.#loop.wake();
  }

  #tick(dt) {
    if (!this.#playing) return false;
    this.#t += dt * 1000;
    if (this.#t >= this.#reel.total + HOLD_MS) {
      this.#t = 0;
      this.#stage.snap();
    }
    this.#render();
    return true;
  }

  #render() {
    const steps = this.#reel.steps;
    const t = Math.min(this.#t, this.#reel.total - 1);
    const step = this.#reel.stepAt(t);
    const still = reduced();
    // Меньше движения: кадр конца шага — то, что должно получиться, без полётов.
    if (!still || this.#painted !== step) {
      this.#stage.paint(this.#reel.frameAt(still ? steps[step].end - 1 : t), still ? steps[step].end : t);
      this.#painted = step;
    }
    if (step !== this.#step) {
      this.#fills.forEach((fill, i) => { fill.style.transform = `scaleX(${i < step ? 1 : 0})`; });
      this.#count.textContent = `Шаг ${step + 1} из ${steps.length}`;
      this.#now.textContent = this.#titles[step];
      this.#step = step;
      this.#onStep(step);
    }
    const s = steps[step];
    const share = still ? 1 : Math.min(1, (t - s.start) / (s.end - s.start));
    this.#fills[step].style.transform = `scaleX(${share.toFixed(4)})`;
  }
}
