// Движение системы — единственное место, которое знает anime.js (ADR-0008,
// ADR-0013). Компоненты говорят словами словаря:
//
//   appear — появиться: снизу, сверху (упасть), сбоку, вырасти; order — по очереди;
//   leave  — уйти туда же; swap — сменить: старое уходит, новое приходит с другой стороны;
//   move   — переехать к значениям пружиной (CSS-переменные, left/top, прозрачность);
//   run    — прогнать долю 0 → 1 (линию маршрута так дорисовывает провайдер);
//   fling  — довести число до цели пружиной с разгона пальца (лист, отпущенный на ходу);
//   hide   — спрятать до появления; stop — остановить там, где стоит;
//   blurIn / blurOut — буквы: проявиться из размытия снизу, уйти в размытие
//            (components/text-motion — текст, который меняется на месте).
//
// Длительности, кривые и пружины — токены движения (tokens/motion.css). Они
// читаются в момент перехода: подстроил токен на странице — следующий
// переход идёт по-новому. «Меньше движения» решается здесь же: переход сразу
// встаёт в конечное состояние, обещание выполняется. Смысловые циклы
// (спиннер, эквалайзер) живут в CSS и сюда не относятся.
//
// Пока идёт появление или уход, inline-прозрачность и transform элемента
// принадлежат обёртке; появившись, элемент их теряет — снова правит CSS.
import { animate, cubicBezier, remove, set, spring, stagger, svg } from '../vendor/anime/anime.esm.min.js';
import { MOTION, QUERIES } from './constants.js';

const REST = { x: 0, y: 0, scale: 1 };

const still = () => window.matchMedia(QUERIES.reducedMotion).matches;

const tokens = () => getComputedStyle(document.documentElement);

// Один элемент, список или объект состояния (у run) — всегда массив.
function list(targets) {
  if (!targets) return [];
  if (targets instanceof Element || typeof targets[Symbol.iterator] !== 'function') return [targets];
  return [...targets].filter(Boolean);
}

function ms(style, name, fallback) {
  const raw = style.getPropertyValue(name).trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  if (raw.endsWith('ms')) return value;
  return raw.endsWith('s') ? value * 1000 : value;
}

function curve(style, name) {
  const [x1, y1, x2, y2] = style.getPropertyValue(name).match(/-?[\d.]+/g)?.map(Number) ?? [];
  return Number.isFinite(y2) ? cubicBezier(x1, y1, x2, y2) : 'out(3)';
}

/** Как идти: пружина из токенов ({ spring: 'soft' }) или длительность с кривой ({ duration: 'fast', ease: 'in-out' }). */
function timing({ spring: kind, duration = 'normal', ease = 'out' } = {}) {
  const style = tokens();
  if (kind) {
    return {
      ease: spring({
        bounce: parseFloat(style.getPropertyValue(`--spring-${kind}-bounce`)) || 0,
        duration: ms(style, `--spring-${kind}-duration`, 400),
      }),
    };
  }
  return { duration: ms(style, `--duration-${duration}`, 280), ease: curve(style, `--ease-${ease}`) };
}

/** Откуда появляется и куда уходит: сдвиг и масштаб. */
function away(side) {
  const shift = parseFloat(tokens().getPropertyValue('--motion-shift')) || 12;
  const sides = {
    below: { y: shift },
    above: { y: -shift * MOTION.dropShift },
    next: { x: shift },
    prev: { x: -shift },
    grow: { scale: MOTION.growFrom },
  };
  return sides[side] ?? {};
}

// Шаг «по очереди»: из токена, но вся очередь — не дольше staggerSpan.
function step(count) {
  const base = ms(tokens(), '--duration-stagger', 45);
  return count > 1 ? Math.min(base, MOTION.staggerSpan / (count - 1)) : 0;
}

function finals(props) {
  return Object.fromEntries(Object.entries(props).map(([key, value]) => [key, Array.isArray(value) ? value.at(-1) : value]));
}

function strip(el) {
  el.style?.removeProperty('opacity');
  el.style?.removeProperty('transform');
}

// Обещание конца: true — доиграл, false — остановили или перебили другим переходом.
function play(targets, props, how, { after, ...extra } = {}) {
  return new Promise((resolve) => {
    animate(targets, {
      ...props,
      ...timing(how),
      ...extra,
      onComplete: () => {
        after?.();
        resolve(true);
      },
      onPause: () => resolve(false),
    });
  });
}

/** Появиться. from: below | above | next | prev | grow | none; order — по очереди, в порядке списка. */
export function appear(targets, { from = 'below', order = false, delay = 0, spring: kind = 'soft' } = {}) {
  const els = list(targets);
  if (!els.length) return Promise.resolve(true);
  remove(els);
  if (still()) {
    els.forEach(strip);
    return Promise.resolve(true);
  }
  const start = { opacity: 0, ...away(from) };
  // Начальное состояние — сразу: у стоящих в очереди его иначе нет до их задержки.
  set(els, start);
  const props = Object.fromEntries(Object.entries(start).map(([key, value]) => [key, [value, REST[key] ?? 1]]));
  // Отскок — у движения; проявление ровное, иначе у упругой пружины метка мигала бы.
  props.opacity = { from: 0, to: 1, ...timing({ duration: 'normal' }) };
  return play(els, props, { spring: kind }, {
    delay: order ? stagger(step(els.length), { start: delay }) : delay,
    after: () => els.forEach(strip),
  });
}

/** Уйти (элемент остаётся в разметке невидимым — убрать его или показать снова решает хозяин). */
export function leave(targets, { to = 'below', duration = 'fast' } = {}) {
  const els = list(targets);
  if (!els.length) return Promise.resolve(true);
  remove(els);
  const end = { opacity: 0, ...away(to) };
  if (still()) {
    set(els, end);
    return Promise.resolve(true);
  }
  return play(els, end, { duration, ease: 'in-out' });
}

/*
 * Буквы (components/text-motion): у каждой — прозрачность, сдвиг по вертикали и
 * размытие, по очереди с шагом `step` (мс) от задержки `delay`; `reverse` — очередь
 * с последней. Сдвиг и размытие — в px: хозяин считает их от кегля своего текста.
 * Кривая, а не пружина: у сотни букв пружина — сотня расчётов на кадр без
 * видимой разницы. Время — токен --duration-slow (поток — --duration-normal).
 *
 * Покадрово, как всё остальное, а не Web Animations: замер 2026-09-30 (×4, поток на
 * 1260 знаков) — у WAAPI главный поток занят почти вдвое дольше (9,9 с против 5,5):
 * размытие не уходит в композитор, и браузер пересчитывает стиль каждой буквы сам.
 *
 * Стили букв после конца остаются — букв уже не будет: хозяин сливает их в текст.
 */
function letterTiming(step, delay, reverse, duration) {
  return {
    ...timing({ duration, ease: 'out' }),
    delay: step > 0 ? stagger(step, { start: delay, from: reverse ? 'last' : 'first' }) : delay,
  };
}

/** Проявиться из размытия, поднимаясь на `shift` px; `duration` — токен (поток ответа — короче). */
export function blurIn(targets, { shift = 0, blur = 0, step = 0, delay = 0, reverse = false, duration = 'slow' } = {}) {
  const els = list(targets);
  if (!els.length) return Promise.resolve(true);
  remove(els);
  if (still()) return Promise.resolve(true);
  set(els, { opacity: 0, y: shift, filter: `blur(${blur}px)` });
  return play(els, { opacity: [0, 1], y: [shift, 0], filter: [`blur(${blur}px)`, 'blur(0px)'] }, {}, letterTiming(step, delay, reverse, duration));
}

/**
 * Уйти в размытие: to — above (вверх: сменились) или below (вниз: удалены).
 * Идёт от того, где буква сейчас: перебитая посреди появления уходит с полпути.
 */
export function blurOut(targets, { to = 'above', shift = 0, blur = 0, step = 0, delay = 0, reverse = false, duration = 'slow' } = {}) {
  const els = list(targets);
  if (!els.length) return Promise.resolve(true);
  remove(els);
  const end = { opacity: 0, y: to === 'above' ? -shift : shift, filter: `blur(${blur}px)` };
  if (still()) {
    set(els, end);
    return Promise.resolve(true);
  }
  return play(els, end, {}, letterTiming(step, delay, reverse, duration));
}

/** Сменить содержимое: direction 1 — вперёд (новое приходит справа), −1 — назад. */
export async function swap(targets, change, { direction = 1 } = {}) {
  const forward = direction >= 0;
  if (!(await leave(targets, { to: forward ? 'prev' : 'next' }))) return false;
  change();
  return appear(targets, { from: forward ? 'next' : 'prev' });
}

/**
 * Переехать к значениям: { '--thumb-x': ['0px', '80px'] } — от и до, или
 * только «до». how — { spring } или { duration, ease }.
 */
export function move(targets, props, how = { spring: 'soft' }) {
  const els = list(targets);
  if (!els.length) return Promise.resolve(true);
  if (still()) {
    remove(els);
    set(els, finals(props));
    return Promise.resolve(true);
  }
  return play(els, props, how);
}

/** Прогнать долю 0 → 1: state — объект хозяина (по нему же stop), onShare(доля) — на каждом кадре. */
export function run(state, onShare, how = { duration: 'draw', ease: 'in-out' }) {
  remove(state);
  if (still()) {
    onShare(1);
    return Promise.resolve(true);
  }
  state.share = 0;
  onShare(0);
  return play(state, { share: 1 }, how, { onUpdate: () => onShare(state.share) });
}

/**
 * Жёсткость и затухание пружины из токенов — по тем же формулам, что у anime.js
 * для «отскок + время»: с ними он скорость не берёт (обнуляет), а отпущенному
 * пальцем она нужна — иначе лист на броске сначала замирает, потом едет.
 */
function physics(kind) {
  const style = tokens();
  const bounce = parseFloat(style.getPropertyValue(`--spring-${kind}-bounce`)) || 0;
  const period = ms(style, `--spring-${kind}-duration`, 400) / 1000;
  const damping = bounce >= 0 ? (4 * (1 - bounce) * Math.PI) / period : (4 * Math.PI) / (period * (1 + bounce));
  return { mass: 1, stiffness: ((2 * Math.PI) / period) ** 2, damping };
}

/**
 * Довести число до цели пружиной с разгона: state.value → to, onValue(значение) —
 * на каждом кадре (пишет хозяин: одну переменную, transform). velocity — скорость
 * пальца в единицах значения за миллисекунду, знак — как у роста значения.
 * Перехват — тем же state: новый fling или stop(state) останавливают прежний там,
 * где он стоит (обещание — false). «Меньше движения» — сразу в цель.
 */
export function fling(state, to, onValue, { spring: kind = 'bouncy', velocity = 0 } = {}) {
  remove(state);
  const from = Number.isFinite(state.value) ? state.value : to;
  if (still() || from === to) {
    state.value = to;
    onValue(to);
    return Promise.resolve(true);
  }
  state.value = from;
  // anime.js меряет начальную скорость пружины долей пути за секунду.
  const share = (velocity * 1000) / (to - from);
  return play(state, { value: to }, {}, {
    ease: spring({ ...physics(kind), velocity: share }),
    onUpdate: () => onValue(state.value),
  });
}

/** Спрятать до появления: appear потом начнёт отсюда же. */
export function hide(targets, { from = 'below' } = {}) {
  const els = list(targets);
  if (!els.length || still()) return;
  remove(els);
  set(els, { opacity: 0, ...away(from) });
}

/** Остановить переходы там, где они сейчас. */
export function stop(targets) {
  remove(list(targets));
}

/** Линия SVG, которую проводят долей: line(0.4) — видны первые 40 % пути. */
export function drawable(paths) {
  const lines = svg.createDrawable(list(paths), 0, 1);
  return (share) => lines.forEach((line) => line.setAttribute('draw', `0 ${share}`));
}

/** Движение сейчас гасится (prefers-reduced-motion) — хозяину, чтобы не готовить того, что не сыграет. */
export const reduced = still;
