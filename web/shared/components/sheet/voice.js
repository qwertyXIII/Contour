// Голосовой режим в панели разговора (sheet_layered, ADR-0072 Alter'а).
//
// Микрофон строки ввода тянут вверх — он становится кольцом: поле и «Отправить»
// уезжают вниз, реплики разлетаются снизу по очереди (Alter'а — влево, свои —
// вправо), кольцо растёт и встаёт на место. Кольцо тянут вниз — то же движение
// назад. Ход — доля --voice-p (0…1): её ведёт палец или пружина отпускания, а
// кольцо и реплики догоняют её каждое своей пружиной (utils/springs.js) — с
// запозданием и лёгким перелётом, «подпружиненно» (владелец). Кольцо ещё и чуть
// тянется по ходу движения (--voice-jelly).
//
// ⚠️ Доля пишется прямо на слой и на поле, а не на корень: реплик на корне сотня, а
// WebKit не пересчитывает `inherit` ненаследуемой переменной глубже одного уровня —
// на iPhone кольцо так и стояло прозрачным (2026-10-01). Поэтому здесь всё — обычными
// наследуемыми переменными слоя.
//
// Свернули панель при открытом голосе — голос не выключается: кольцо уходит в
// левую часть пилюли (CSS — из --sheet-p), справа — бегущая строка хозяина.
//
// Решение «открыть» или «закрыть» — событие sheet:voice { open } прямо из
// отпускания пальца, синхронно: хозяин заводит там звук, а iOS пускает его только
// из жеста. Нажатие без движения — обычный щелчок (микрофон пишет голосовое,
// кольцо — «замолчи»); щелчок после жеста гасится.
import { EVENTS, SHEET } from '../../utils/constants.js';
import { emit } from '../../utils/dom.js';
import { fling, stop } from '../../utils/motion.js';
import { Spring, frameLoop } from '../../utils/springs.js';

const V = SHEET.voice;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const ease = (t) => t * t * (3 - 2 * t);
const px = (style, name) => parseFloat(style.getPropertyValue(name)) || 0;

export class SheetVoice {
  #layer;
  #root;
  #motion = { value: 0 };
  #open = false;
  #gesture = null;
  #slots = [];
  #mic = null;
  #foot = null;
  #guardUntil = 0;
  #orb = new Spring(V.springs.orb);
  #loop = frameLoop((dt) => this.#tick(dt));

  constructor(layer) {
    this.#layer = layer;
    this.#root = layer.closest('.sheet');
  }

  init() {
    const root = this.#root;
    if (!root) return this;
    root.addEventListener('pointerdown', (event) => this.#down(event));
    root.addEventListener('pointermove', (event) => this.#move(event));
    root.addEventListener('pointerup', (event) => this.#up(event, false));
    root.addEventListener('pointercancel', (event) => this.#up(event, true));
    root.addEventListener('click', (event) => {
      if (performance.now() >= this.#guardUntil) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    root.addEventListener(EVENTS.sheetVoiceSet, (event) => this.#set(event.detail ?? {}));
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.#open || !root.classList.contains(SHEET.class.open)) return;
      this.#begin();
      this.#decide(false);
      void this.#go(0);
    });
    window.addEventListener('resize', () => { if (root.classList.contains(V.class.on)) this.#measure(); });
    this.#write(0);
    return this;
  }

  // Микрофон — у раскрытой панели, пока не пишет голосовое; кольцо — у открытого голоса.
  #kindAt(target) {
    const root = this.#root;
    if (!root.classList.contains(SHEET.class.open)) return null;
    if (!this.#open && target.closest(V.mic) && !target.closest('.composer_recording')) return 'mic';
    if (this.#open && target.closest(V.ring)) return 'ring';
    return null;
  }

  #down(event) {
    if (this.#gesture || event.button > 0) return;
    const kind = this.#kindAt(event.target);
    if (!kind) return;
    this.#gesture = {
      kind, id: event.pointerId, x0: event.clientX, y0: event.clientY, moved: false,
      samples: [{ y: event.clientY, t: event.timeStamp }],
    };
  }

  #move(event) {
    const g = this.#gesture;
    if (!g || event.pointerId !== g.id) return;
    const dx = event.clientX - g.x0;
    const dy = event.clientY - g.y0;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < SHEET.moveThreshold * 2) return;
      // Микрофон — только вверх, кольцо — только вниз; вбок или не туда — не жест.
      const along = g.kind === 'mic' ? -dy : dy;
      if (along <= Math.abs(dx)) { this.#gesture = null; return; }
      g.moved = true;
      try { this.#root.setPointerCapture(event.pointerId); } catch {}
      this.#begin();
    }
    g.samples.push({ y: event.clientY, t: event.timeStamp });
    while (g.samples.length > 2 && g.samples.at(-1).t - g.samples[0].t > SHEET.velocityWindowMs * 2) g.samples.shift();
    const share = dy / this.#travel();
    this.#write(clamp(g.kind === 'mic' ? -share : 1 - share, 0, 1));
  }

  #up(event, cancelled) {
    const g = this.#gesture;
    if (!g || event.pointerId !== g.id) return;
    this.#gesture = null;
    if (!g.moved) return;
    this.#guardUntil = performance.now() + SHEET.clickGuardMs;
    const v = velocity(g.samples);
    const p = this.#motion.value;
    const open = cancelled
      ? g.kind === 'ring'
      : g.kind === 'mic' ? p >= V.commit || v < -SHEET.flick : !(p < V.commit || v > SHEET.flick);
    // Решение — здесь же, в отпускании: хозяин заводит звук только из жеста.
    this.#decide(open);
    void this.#go(open ? 1 : 0, -v / this.#travel());
  }

  #travel() {
    return Math.max(1, window.innerHeight * V.travel);
  }

  #decide(open) {
    if (open === this.#open) return;
    this.#open = open;
    emit(this.#root, EVENTS.sheetVoice, { open });
  }

  /** Жест пошёл: слой виден, реплики и кольцо перемерены. */
  #begin() {
    const root = this.#root;
    stop(this.#motion);
    root.classList.add(V.class.on);
    root.classList.remove(V.class.open);
    document.activeElement?.blur?.();
    this.#measure();
    this.#collect();
    this.#write(this.#motion.value);
  }

  // Доля доезжает пружиной; классы — когда улеглись и кольцо, и реплики: спрятать
  // ленту, пока реплика ещё выглядывает у края, значило бы оборвать её полёт.
  async #go(target, velocity = 0) {
    const done = await fling(this.#motion, target, (p) => this.#write(p), { spring: 'soft', velocity });
    if (!done) return;
    this.#write(target);
    await this.#loop.idle();
    if (this.#motion.value !== target || this.#gesture?.moved) return;
    if (target === 1) this.#root.classList.add(V.class.open);
    else this.#rest();
  }

  /** Голос выключен и слой спрятан: реплики на местах, микрофон виден. */
  #rest() {
    const was = this.#root.classList.contains(V.class.on);
    this.#root.classList.remove(V.class.on, V.class.open);
    for (const { el } of this.#slots) {
      el.style.transform = '';
      el.style.opacity = '';
    }
    this.#slots = [];
    if (this.#mic) this.#mic.style.opacity = '';
    this.#orb.snap(0);
    if (was) emit(this.#root, EVENTS.sheetVoiceRest);
  }

  /** Открыть или закрыть из кода (выход из привязки, витрина): без события. */
  #set({ open = false, animate = true }) {
    if (open === this.#open && (open ? this.#motion.value === 1 : !this.#root.classList.contains(V.class.on))) return;
    this.#open = Boolean(open);
    this.#begin();
    if (animate) { void this.#go(open ? 1 : 0); return; }
    stop(this.#motion);
    this.#write(open ? 1 : 0);
    this.#orb.snap(open ? 1 : 0);
    this.#slots.forEach((slot) => slot.spring.snap(slot.spring.target));
    this.#tick(0);
    if (open) this.#root.classList.add(V.class.open);
    else this.#rest();
  }

  /*
   * Где кольцо: открытое — на своём месте в сцене (его рамка без transform), у
   * микрофона — на месте значка его размером, в пилюле — слева её размера. CSS
   * смешивает три места по --voice-p и --sheet-p; числа — здесь, раз на жест.
   */
  #measure() {
    const root = this.#root;
    const orb = root.querySelector(V.orb);
    const stage = orb?.offsetParent;
    if (!orb || !stage) return;
    const box = stage.getBoundingClientRect();
    const cx = box.left + orb.offsetLeft;
    const cy = box.top + orb.offsetTop;
    const size = orb.offsetWidth || 1;
    const set = (name, value) => this.#layer.style.setProperty(name, value);

    this.#mic = root.querySelector(V.mic);
    this.#foot = root.querySelector('.sheet__foot');
    const icon = this.#mic?.querySelector('.icon') ?? this.#mic;
    if (icon) {
      const r = icon.getBoundingClientRect();
      // Поле могло уже уехать вниз (закрываем) — место значка без этого сдвига.
      const foot = icon.closest('.sheet__foot');
      const shift = foot ? new DOMMatrix(getComputedStyle(foot).transform).m42 : 0;
      set('--voice-mic-dx', `${(r.left + r.width / 2 - cx).toFixed(1)}px`);
      set('--voice-mic-dy', `${(r.top - shift + r.height / 2 - cy).toFixed(1)}px`);
      set('--voice-mic-s', (r.width / size).toFixed(4));
    }

    // Пилюля — от краёв самой панели, не окна (в витрине панель лежит в макете).
    const style = getComputedStyle(root);
    const frame = root.getBoundingClientRect();
    const gap = px(style, '--sheet-gap');
    const low = px(style, '--sheet-low') || px(style, '--sheet-closed');
    const { size: pill, inset, nudge } = V.pill;
    const pillCx = gap + inset + pill / 2;
    set('--voice-pill-dx', `${(pillCx - (cx - frame.left)).toFixed(1)}px`);
    set('--voice-pill-dy', `${(low / 2 + nudge - (cy - frame.top)).toFixed(1)}px`);
    set('--voice-pill-s', (pill / size).toFixed(4));
    set('--voice-pill-end', `${(pillCx + pill / 2).toFixed(1)}px`);
  }

  /** Видимые реплики — снизу вверх: каждой своё начало хода и сторона. */
  #collect() {
    for (const { el } of this.#slots) {
      el.style.transform = '';
      el.style.opacity = '';
    }
    const body = this.#root.querySelector(SHEET.body);
    if (!body) { this.#slots = []; return; }
    // Пока голос был открыт, лента могла дописаться — показать её конец.
    if (this.#open) body.scrollTop = body.scrollHeight;
    const box = body.getBoundingClientRect();
    const seen = [...body.querySelectorAll('.messages > *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0 && r.bottom > box.top && r.top < box.bottom)
      .sort((a, b) => b.r.bottom - a.r.bottom);
    const { start, step, spread } = V.fly;
    const gapStep = seen.length > 1 ? Math.min(step, spread / (seen.length - 1)) : 0;
    const far = window.innerWidth;
    this.#slots = seen.map(({ el }, i) => {
      const slot = { el, dir: el.classList.contains('message_from_me') ? 1 : -1, start: start + i * gapStep, spring: new Spring(V.springs.line) };
      // Реплика начинает оттуда, где её оставили: открыт голос — она уже за краем.
      slot.spring.snap(this.#target(slot, this.#motion.value, far));
      return slot;
    });
  }

  /** Куда реплике при доле p: за край в свою сторону, по очереди снизу. */
  #target(slot, p, far = window.innerWidth) {
    return slot.dir * ease(clamp((p - slot.start) / V.fly.span, 0, 1)) * far;
  }

  /** Доля хода: цели пружин, поле, значок. Кадр рисует #tick. */
  #write(p) {
    this.#motion.value = p;
    const value = p.toFixed(4);
    this.#layer.style.setProperty('--voice-p', value);
    this.#foot?.style.setProperty('--voice-p', value);
    this.#orb.target = p;
    const far = window.innerWidth;
    for (const slot of this.#slots) slot.spring.target = this.#target(slot, p, far);
    // Значок гаснет сразу: на его месте уже маленькое кольцо.
    if (this.#mic) this.#mic.style.opacity = p > 0 ? String(clamp(1 - p / 0.08, 0, 1)) : '';
    this.#loop.wake();
  }

  /** Кадр пружин: кольцо (с растяжением по скорости) и реплики. */
  #tick(dt) {
    let moving = false;
    const orb = this.#orb.step(dt);
    const { gain, max } = V.springs.jelly;
    this.#layer.style.setProperty('--voice-orb', orb.toFixed(4));
    this.#layer.style.setProperty('--voice-jelly', Math.min(max, Math.abs(this.#orb.v) * gain).toFixed(4));
    moving ||= !this.#orb.resting;
    const far = window.innerWidth;
    const { fade } = V.fly;
    for (const slot of this.#slots) {
      const x = slot.spring.step(dt);
      const share = Math.min(1, Math.abs(x) / far);
      slot.el.style.transform = Math.abs(x) > 0.1 ? `translate3d(${x.toFixed(1)}px, 0, 0)` : '';
      slot.el.style.opacity = share > 0.001 ? (1 - share * fade).toFixed(3) : '';
      moving ||= !slot.spring.resting;
    }
    return moving;
  }
}

/** Скорость пальца (px/мс, вниз — плюс) по окну последних событий. */
function velocity(samples) {
  const now = samples.at(-1);
  const from = samples.find((s) => now.t - s.t <= SHEET.velocityWindowMs) ?? now;
  return now.t > from.t ? (now.y - from.y) / (now.t - from.t) : 0;
}
