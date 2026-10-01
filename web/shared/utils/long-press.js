// Долгое нажатие — касанием, мышью, пером: держат дольше `ms` и не уводят палец
// дальше `slop`. Правая кнопка и долгое нажатие Android (contextmenu) — тоже оно.
//
//   const off = longPress(root, { selector, onHold(target), onPress(target) });
//
// `onHold` — в миг, когда нажатие засчитано (палец ещё держат): показать, что
// сработало. `onPress` — когда палец УЖЕ отпущен: щелчок после касания браузер
// отдаёт в точку отпускания, и открытый по таймеру лист поймал бы его и сам нажал
// свою кнопку (так «Удалить экран» открывался сам). Щелчок после нажатия проходит
// к тому, что под пальцем (пилюля выбирается), и только потом — `onPress`.
//
// На iPhone держат ещё выделение текста, выноска и лупа — у самого блока
// `-webkit-touch-callout: none` и `user-select: none`, иначе система заберёт
// касание (pointercancel) раньше таймера.
import { SCREENS } from './constants.js';

/** Отпустили, а щелчка нет (так бывает после долгого нажатия) — столько ждать. */
const RELEASE_MS = 350;

/** Когда палец отпущен — позвать `open` (после щелчка, если он будет). */
function afterRelease(open) {
  let done = false;
  let timer = 0;
  const types = ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'click'];
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    types.forEach((type) => document.removeEventListener(type, on, true));
    setTimeout(open, 0);
  };
  const on = (event) => {
    if (event.type === 'click') go();
    else if (!timer) timer = setTimeout(go, RELEASE_MS);
  };
  types.forEach((type) => document.addEventListener(type, on, true));
}

export function longPress(root, { selector, ms = SCREENS.longPressMs, slop = SCREENS.pressSlop, onHold, onPress }) {
  let press = null;
  let held = null;

  const cancel = () => {
    clearTimeout(press?.timer);
    press = null;
  };
  const release = () => {
    if (!held) return;
    const target = held;
    afterRelease(() => {
      if (held === target) held = null;
      onPress(target);
    });
  };

  const down = (event) => {
    if (event.button > 0) return;
    const target = event.target.closest(selector);
    if (!target || !root.contains(target)) return;
    cancel();
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        press = null;
        held = target;
        onHold?.(target);
        release();
      }, ms),
    };
  };
  const move = (event) => {
    if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > slop) cancel();
  };
  const up = (event) => {
    if (press && event.pointerId === press.id) cancel();
  };
  // Мышь увели с элемента — не нажатие; палец уходит сдвигом, это ловит move.
  const leave = (event) => {
    if (event.pointerType === 'mouse') up(event);
  };
  // Меню браузера не показывать; правая кнопка без долгого удержания — сразу нажатие.
  const menu = (event) => {
    const target = event.target.closest(selector);
    if (!target || !root.contains(target)) return;
    event.preventDefault();
    if (held || press) return;
    held = target;
    onHold?.(target);
    setTimeout(() => {
      held = null;
      onPress(target);
    }, 0);
  };

  const handlers = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: up, pointerleave: leave, contextmenu: menu };
  Object.entries(handlers).forEach(([type, fn]) => root.addEventListener(type, fn));
  return () => {
    cancel();
    Object.entries(handlers).forEach(([type, fn]) => root.removeEventListener(type, fn));
  };
}
