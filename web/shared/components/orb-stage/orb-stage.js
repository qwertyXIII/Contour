// Сцена кольца (блок orb-stage): кольцо Alter'а и место под то, что он
// показывает, пока говорит. Движок кольца — components/orb/ (createOrb); здесь он
// только создаётся и получает команды.
//
// Хозяин (голосовой экран) говорит событием orb-stage:set { mode, layout, busy,
// look, brightness, regions, shape }: режим кольца, раскладка (center | top |
// corner — круг уезжает и уменьшается), свет занятости (thinking | tool | null),
// вид кольца из настроек («Кольцо и звук» Alter'а: maxLength — длина капсул и
// т. д.; ключи понимает и проверяет сам движок), яркость цветов обложки под
// музыкой (множитель, 1 — как разобрано), зоны кольца и фигура:
//   - regions — зоны, как их понимает движок: дуга, сторона капсулы, источник
//     (функция — договор). Так живой разговор рисует «внутрь — микрофон, наружу —
//     голос Alter'а» разом, а превью — синтетику. null — обратно к спектру на обе
//     стороны. Под музыкой кольцо у неё; ушла музыка — вернутся зоны хозяина;
//   - shape — фигура из капсул (функция из components/orb/orb-shapes.js) или null — кольцо.
// Легла на сцену музыка — вид плеера player_view_voice — кольцо отдаёт центр
// обложке (music.js).
//
// Вид при создании — атрибут data-look (JSON тех же ключей, что look). Не
// событием: вставленная разметка оживает микрозадачей позже, и событие сразу
// после вставки теряется; а вид, пришедший после создания, перестраивал бы
// капсулы на глазах (36 → 96).
//
// Ожив, сцена сообщает orb-stage:ready: кто строит её и сразу шлёт зоны
// (функции в атрибут не положить), ждёт этого события.
//
// Кадры кольцо рисует, только пока сцену видно.
import { EVENTS, ORB_STAGE } from '../../utils/constants.js';
import { emit } from '../../utils/dom.js';
// Движок кольца — рядом, components/orb/: один на все поверхности (ADR-0069).
import { createOrb } from '../orb/orb.js';
import { sanitizeLook } from '../orb/orb-config.js';
import { MusicRing } from './music.js';

export class OrbStage {
  #root;
  #orb = null;
  #music = null;
  #mode = 'idle';
  // Зоны хозяина; null — как до них: спектр на обе стороны.
  #regions = null;

  constructor(root) {
    this.#root = root;
  }

  init() {
    const holder = this.#root.querySelector('.orb-stage__orb');
    if (!holder) return this;
    this.#orb = createOrb(holder, initialLook(this.#root));
    this.#music = new MusicRing(this.#orb, this.#root, () => this.#applyMode(), () => this.#hostRegions());
    this.#set({ mode: this.#root.dataset.mode || 'idle' });
    this.#root.addEventListener(EVENTS.orbStageSet, (event) => this.#set(event.detail));
    new MutationObserver(() => this.#music.sync()).observe(this.#root, { childList: true });
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) this.#orb.start();
      else this.#orb.stop();
    }).observe(this.#root);
    this.#music.sync();
    emit(this.#root, EVENTS.orbStageReady);
    return this;
  }

  #set({ mode, layout, busy, look, brightness, regions, shape } = {}) {
    if (look) {
      this.#orb.configure(look);
      this.#music.refresh();
    }
    if (brightness !== undefined) this.#music.setBrightness(brightness);
    if (ORB_STAGE.modes.includes(mode)) {
      this.#mode = mode;
      this.#applyMode();
    }
    if (ORB_STAGE.layouts.includes(layout)) {
      ORB_STAGE.layouts.forEach((name) => this.#root.classList.toggle(ORB_STAGE.layoutClass(name), name === layout && name !== 'center'));
    }
    if (busy !== undefined) this.#orb.setBusy(busy);
    if (regions !== undefined) this.#setRegions(regions);
    if (shape !== undefined) this.#orb.setShape(typeof shape === 'function' ? shape : null);
  }

  // Под музыкой кольцо у неё: зоны хозяина запоминаются и вернутся, когда она уйдёт.
  #setRegions(regions) {
    this.#regions = Array.isArray(regions) && regions.length ? regions : null;
    if (!this.#music.active) this.#orb.setRegions(this.#hostRegions());
  }

  #hostRegions() {
    return this.#regions ?? ORB_STAGE.plainRegions;
  }

  // Под музыкой «тишина» хозяина светится как «говорит»: вокруг играющей
  // обложки кольцо не должно почти пропадать.
  #applyMode() {
    const quiet = this.#mode === 'idle' && this.#music.active;
    this.#orb.setMode(quiet ? ORB_STAGE.musicMode : this.#mode);
  }
}

// Вид при создании — из data-look: только понятое движку и в его границах.
function initialLook(root) {
  try {
    const look = JSON.parse(root.getAttribute(ORB_STAGE.lookAttribute) || '{}');
    return look && typeof look === 'object' ? sanitizeLook(look) : {};
  } catch {
    return {};
  }
}
