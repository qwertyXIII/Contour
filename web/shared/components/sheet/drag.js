// Жест листа: палец за ручку или шапку — pointer-события; у свёрнутого листа — и
// за тело (там нечего прокручивать). У раскрытого тело прокручивается само, а
// тянуть лист вниз можно, когда оно прокручено до верха, — это touch-события:
// pointer браузер отнимает (pointercancel), как только начнёт прокрутку, а отменить
// её можно только из touchmove.
//
// Хозяину — пять слов: start() — жест пошёл; move(dy, v) — палец ушёл на dy от
// начала (вниз — плюс), v — скорость в px/мс по окну последних событий; end(v) —
// отпустили; tap(target) — нажали, не сдвинув; zone(target, kind) — брать ли жест
// ('pointer' | 'pull'): решает, где на листе палец и в каком лист положении.
import { SHEET } from '../../utils/constants.js';

/** Скорость по окну последних событий: на телефоне они приходят пачками. */
function velocity(samples) {
  const now = samples.at(-1);
  const from = samples.find((s) => now.t - s.t <= SHEET.velocityWindowMs) ?? now;
  return now.t > from.t ? (now.y - from.y) / (now.t - from.t) : 0;
}

function record(samples, y, t) {
  samples.push({ y, t });
  while (samples.length > 2 && samples.at(-1).t - samples[0].t > SHEET.velocityWindowMs * 2) samples.shift();
}

export function trackDrag(root, { zone, start, move, end, tap }) {
  let gesture = null; // { id, y0, samples, moved, kind, target }
  let guardUntil = 0;

  const begin = (kind, id, y, t, target) => {
    gesture = { id, y0: y, samples: [{ y, t }], moved: false, kind, target };
  };

  const step = (y, t) => {
    record(gesture.samples, y, t);
    const dy = y - gesture.y0;
    if (!gesture.moved && Math.abs(dy) > SHEET.moveThreshold) {
      gesture.moved = true;
      start();
    }
    if (gesture.moved) move(dy, velocity(gesture.samples));
  };

  const finish = (cancelled) => {
    const done = gesture;
    gesture = null;
    if (done.moved) {
      // Щелчок, который браузер отдаст после перетаскивания, — не нажатие.
      guardUntil = performance.now() + SHEET.clickGuardMs;
      end(velocity(done.samples));
    } else if (!cancelled) {
      tap(done.target);
    }
  };

  root.addEventListener('pointerdown', (event) => {
    if (gesture || event.button > 0 || !zone(event.target, 'pointer')) return;
    begin('pointer', event.pointerId, event.clientY, event.timeStamp, event.target);
  });
  root.addEventListener('pointermove', (event) => {
    if (gesture?.kind !== 'pointer' || event.pointerId !== gesture.id) return;
    // Захват — только когда жест пошёл: с захватом с первого касания щелчок по
    // кнопке в шапке ушёл бы корню, и кнопка перестала бы нажиматься.
    if (!gesture.moved && Math.abs(event.clientY - gesture.y0) > SHEET.moveThreshold) {
      try { root.setPointerCapture(event.pointerId); } catch {}
    }
    step(event.clientY, event.timeStamp);
  });
  const up = (event) => {
    if (gesture?.kind !== 'pointer' || event.pointerId !== gesture.id) return;
    finish(event.type === 'pointercancel');
  };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);

  // Тянут раскрытый лист за тело, прокрученное до верха: первое же движение вниз
  // у верха отменяем сразу — иначе iOS успеет начать свою резинку прокрутки.
  root.addEventListener('touchstart', (event) => {
    if (gesture || event.touches.length !== 1 || !zone(event.target, 'pull')) return;
    const touch = event.touches[0];
    begin('pull', touch.identifier, touch.clientY, event.timeStamp, event.target);
    gesture.body = event.target.closest(SHEET.body);
    gesture.claimed = false;
  }, { passive: true });
  root.addEventListener('touchmove', (event) => {
    if (gesture?.kind !== 'pull') return;
    const touch = [...event.changedTouches].find((t) => t.identifier === gesture.id);
    if (!touch) return;
    const dy = touch.clientY - gesture.y0;
    if (!gesture.claimed) {
      if (dy < 0 || gesture.body.scrollTop > 0) { gesture = null; return; }
      if (dy === 0) return;
      gesture.claimed = true;
    }
    if (event.cancelable) event.preventDefault();
    step(touch.clientY, event.timeStamp);
  }, { passive: false });
  const release = (event) => {
    if (gesture?.kind !== 'pull') return;
    if (![...event.changedTouches].some((t) => t.identifier === gesture.id)) return;
    if (!gesture.claimed) { gesture = null; return; }
    finish(event.type === 'touchcancel');
  };
  root.addEventListener('touchend', release);
  root.addEventListener('touchcancel', release);

  root.addEventListener('click', (event) => {
    if (performance.now() < guardUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  return { active: () => Boolean(gesture?.moved) };
}
