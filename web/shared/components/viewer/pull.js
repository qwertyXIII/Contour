// Смахнуть вниз — закрыть просмотр, потянуть вверх — «О файле» (если хозяин его
// дал: `info.can()`). Вбок ленту листает браузер (touch-action: pan-x), поэтому
// сюда доходят вертикальные движения пальца. Мышь не смахивает: у неё есть
// «закрыть», ⓘ и Esc. Отпустили рано — лента возвращается упругой пружиной.
// Текст со своей прокруткой (data-viewer-scroll) жест не перехватывает.
import { VIEWER } from '../../utils/constants.js';
import { move, stop } from '../../utils/motion.js';

export class Pull {
  #root;
  #track;
  #close;
  #start = null;
  #pulling = false;
  #swallowClick = false;
  #info;

  constructor(root, track, close, info = { can: () => false, open: () => {} }) {
    this.#root = root;
    this.#track = track;
    this.#close = close;
    this.#info = info;
  }

  mount() {
    this.#track.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' || !event.isPrimary) return;
      if (event.target.closest('[data-viewer-scroll], .viewer__wave, button')) return;
      this.#start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    });
    this.#track.addEventListener('pointermove', (event) => this.#move(event));
    this.#track.addEventListener('pointerup', (event) => this.#end(event));
    this.#track.addEventListener('pointercancel', () => this.#back());
    // Отпустили после смахивания — это не касание: рамку не прятать.
    this.#track.addEventListener('click', (event) => {
      if (!this.#swallowClick) return;
      this.#swallowClick = false;
      event.stopPropagation();
    }, true);
    return this;
  }

  #move(event) {
    if (!this.#start || event.pointerId !== this.#start.id) return;
    const dx = event.clientX - this.#start.x;
    const dy = event.clientY - this.#start.y;
    if (!this.#pulling && !this.#decide(dx, dy, event.pointerId)) return;
    const pull = dy >= 0 ? dy : this.#info.can() ? dy * VIEWER.upResistance : 0;
    this.#root.style.setProperty('--viewer-pull', `${pull}px`);
    this.#root.style.setProperty('--viewer-fade', String(1 - Math.min(1, Math.max(0, pull) / VIEWER.fadeAt)));
  }

  // Вниз (или вверх, если есть «О файле») больше, чем вбок, — это наше; вбок —
  // лента, отпускаем палец браузеру.
  #decide(dx, dy, pointerId) {
    const up = dy < 0 && this.#info.can();
    const vertical = up ? -dy : dy;
    if (Math.abs(dx) > VIEWER.tapSlop && Math.abs(dx) >= vertical) {
      this.#start = null;
      return false;
    }
    if (vertical <= VIEWER.tapSlop) return false;
    // Подхватили ленту, пока она ещё пружинит назад, — дальше её ведёт палец.
    stop(this.#root);
    this.#pulling = true;
    this.#root.classList.add(VIEWER.pulling);
    try {
      this.#track.setPointerCapture(pointerId);
    } catch {
      // Указатель уже отпущен — жест доведут события, пришедшие на ленту.
    }
    return true;
  }

  #end(event) {
    if (!this.#pulling) {
      this.#start = null;
      return;
    }
    const dy = event.clientY - this.#start.y;
    this.#swallowClick = true;
    if (dy < 0 && this.#info.can() && -dy >= VIEWER.infoAt) {
      // Лента остаётся, где её отпустил палец: подъём «О файле» продолжит оттуда.
      this.#start = null;
      this.#pulling = false;
      this.#root.classList.remove(VIEWER.pulling);
      this.#info.open();
      return;
    }
    if (dy <= VIEWER.closeAt) {
      this.#back();
      return;
    }
    // Закрытие сначала запоминает, где фото сейчас (оттуда полетит в плитку),
    // и только потом лента встаёт на место — уже спрятанная.
    this.#close();
    this.#reset();
  }

  /** Отпустили рано или жест отменили — пружиной на место, подложка темнеет обратно. */
  #back() {
    if (!this.#pulling) {
      this.#start = null;
      return;
    }
    const style = this.#root.style;
    const pull = style.getPropertyValue('--viewer-pull') || '0px';
    const fade = style.getPropertyValue('--viewer-fade') || '1';
    this.#start = null;
    this.#pulling = false;
    this.#root.classList.remove(VIEWER.pulling);
    move(this.#root, { '--viewer-pull': [pull, '0px'], '--viewer-fade': [fade, '1'] }, { spring: 'bouncy' })
      .then((done) => {
        if (done) this.#reset();
      });
  }

  #reset() {
    stop(this.#root);
    this.#start = null;
    this.#pulling = false;
    this.#root.classList.remove(VIEWER.pulling);
    this.#root.style.removeProperty('--viewer-pull');
    this.#root.style.removeProperty('--viewer-fade');
  }
}
