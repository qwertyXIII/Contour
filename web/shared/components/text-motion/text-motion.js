// Текст, который меняется на месте (ADR-0066 Alter'а): заголовки, пилюли, шапки,
// статусы, значения, реплики, пустые состояния, уведомления. Длинные списки
// сюда не ходят — их строки появляются целиком (сотни букв в полёте телефон не тянет).
//
//   setText(el, text) → Promise<boolean>
//     el — узел, чьим текстом владеет компонент: всё внутри он заменяет сам (текст
//     кнопки со значком — в своём span). Было пусто — буквы появляются по одной
//     из размытия снизу; стало пусто — уходят так же, обратно и с последней;
//     сменилось — старые улетают вверх, новые поднимаются снизу. Общее начало и
//     конец стоят на месте — по границам слов, число — по разрядам («15:15» →
//     «15:16» меняет одну цифру). true — доиграло, false — перебили новой сменой:
//     она продолжит с того места, где буквы сейчас, мусора не остаётся.
//   textOf(el) — итоговый текст, даже посреди смены.
//   settle(el) — сразу в конец: буквы — в обычный текст.
//   stream(el) → { push(кусок), end(итог?), cancel() } — поток ответа, stream.js.
//
// Посреди смены в узле — итоговый текст для скринридера (спрятан глазами) и буквы
// (спрятаны от скринридера). Доиграло — один обычный текстовый узел: разметка не
// пухнет. «Меньше движения» и спрятанный узел — сразу; строка длиннее maxLetters
// появляется целиком одним движением, а меняется сразу.
import { appear, blurIn, blurOut, reduced, stop } from '../../utils/motion.js';
import { TEXT_MOTION } from '../../utils/constants.js';
import { h } from '../../utils/dom.js';
import { CLS, common, graphemes, isSpace, letter, metrics, spoken, stepFor, unseen, words } from './letters.js';
import { createStream } from './stream.js';

/**
 * Узел посреди смены: `text` — итог, `units` — его графемы (у ещё проявляющихся —
 * их буква), `ghosts` — уходящие буквы прошлых смен, `pending` — их обещания:
 * слить в текст можно, только когда доиграли все.
 */
const states = new WeakMap();

const isNode = (part) => typeof part !== 'string';

/** Состояние узла, если разметку не заменили снаружи (тогда буквы уже не наши). */
function current(el) {
  const st = states.get(el);
  if (!st) return null;
  if (st.visual.parentNode === el) return st;
  stop(st.visual.querySelectorAll(`.${CLS.letter}`));
  states.delete(el);
  st.resolve(false);
  return null;
}

/** Итоговый текст узла — и посреди смены. */
export function textOf(el) {
  return current(el)?.text ?? el.textContent;
}

/** Сразу в конец: буквы — в обычный текст. */
export function settle(el) {
  const st = current(el);
  if (!st) return;
  stop(st.visual.querySelectorAll(`.${CLS.letter}`));
  states.delete(el);
  el.textContent = st.text;
  st.resolve(true);
}

/** Поток по кускам (stream.js); смена, что шла в узле, — сразу в конец. */
export function stream(el) {
  settle(el);
  return createStream(el);
}

/** Сменить сразу; появиться с нуля длинной строкой — одним движением. */
function instant(el, text, from) {
  const st = states.get(el);
  if (st) {
    stop(st.visual.querySelectorAll(`.${CLS.letter}`));
    states.delete(el);
    st.resolve(false);
  }
  el.textContent = text;
  if (text && !from && !reduced() && !unseen(el)) void appear(el);
  return Promise.resolve(true);
}

export function setText(el, value) {
  const text = value == null ? '' : String(value);
  const st = current(el);
  const units = st ? st.units : graphemes(el.textContent).map((g) => ({ g, span: null }));
  const from = units.map((u) => u.g).join('');
  if (from === text) return st ? st.done : Promise.resolve(true);
  const next = graphemes(text);
  if (reduced() || unseen(el) || Math.max(units.length, next.length) > TEXT_MOTION.maxLetters) return instant(el, text, from);

  const { head, tail } = common(units.map((u) => u.g), next);
  const part = (u) => u.span ?? u.g;
  // Уходящие: проявлявшиеся уходят со своей буквой — с того места, где они сейчас.
  const leaving = units.slice(head, units.length - tail).map((u) => (isSpace(u.g) ? u.g : u.span ?? letter(u.g)));
  const entering = next.slice(head, next.length - tail).map((g) => ({ g, span: isSpace(g) ? null : letter(g) }));
  const ghosts = [...(st?.ghosts ?? [])];
  const cleared = !text;

  // Ушедшие прошлых смен и (кроме удаления) нынешние — поверх, с места смены:
  // строка уже встала по новому тексту. Удаление держит буквы в строке до конца,
  // иначе узел схлопнулся бы раньше, чем они уйдут. Меняется всё с начала, а узел —
  // блок (заголовок, абзац) — ушедшие ложатся поверх всего блока и переносятся по
  // его ширине, как стояли: иначе строка в две строки уходила бы одной, за край.
  const block = !getComputedStyle(el).display.startsWith('inline');
  const whole = block && head === 0;
  const overlay = [...ghosts, ...(cleared ? [] : leaving)];
  const gone = overlay.length > 0 && h('span', { class: whole ? `${CLS.gone} ${CLS.goneBlock}` : CLS.gone }, ...words(overlay));
  const swap = h('span', { class: CLS.swap }, !whole && gone, ...words(cleared ? leaving : entering.map(part)));
  // Место смены — вне слов по краям: внутри обёртки без переносов длинная новая
  // строка (реплика чата) не переносилась бы, пока буквы летят.
  const visual = h('span', { class: block ? `${CLS.root} ${CLS.rootBlock}` : CLS.root, 'aria-hidden': 'true' },
    whole && gone, ...words(units.slice(0, head).map(part)), swap, ...words(units.slice(units.length - tail).map(part)));
  el.replaceChildren(spoken(text), visual);

  const { shift, blur } = metrics(el);
  const outgoing = leaving.filter(isNode);
  const incoming = entering.map((u) => u.span).filter(Boolean);
  const out = blurOut(outgoing, { to: cleared ? 'below' : 'above', shift, blur, step: stepFor(outgoing.length), reverse: cleared });
  const into = blurIn(incoming, { shift, blur, step: stepFor(incoming.length), delay: from ? TEXT_MOTION.swapDelayMs : 0 });

  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const state = {
    text,
    units: [...units.slice(0, head), ...entering, ...units.slice(units.length - tail)],
    ghosts: [...ghosts, ...outgoing],
    pending: [...(st?.pending ?? []), out, into],
    visual,
    done,
    resolve,
  };
  st?.resolve(false);
  states.set(el, state);
  Promise.all(state.pending).then(() => {
    if (states.get(el) !== state) return;
    states.delete(el);
    el.textContent = text;
    resolve(true);
  });
  return done;
}
