// Поток по кускам (ADR-0066 Alter'а): ответ агента, который пишется у человека на
// глазах. Пришёл кусок — его буквы сразу проявляются из размытия снизу, не
// дожидаясь конца.
//
//   const s = stream(el);   s.push(кусок) …   await s.end(итог?);   s.cancel()
//
// Рассчитано на длинное: долетевшие слова сливаются в один текстовый узел, в
// полёте — только последние буквы, поэтому разметка не растёт вместе с ответом.
// Очередь идёт с шагом streamStepMs и не отстаёт от пришедшего больше чем на
// streamLagMs: пришло много разом — шаг сжимается, текст не ползёт позади модели.
//
// `end(итог)` — итог продолжает пришедшее: допишется потоком; иначе встанет, когда
// буквы долетят (только пробелы и разметка по краям — у готового ответа они другие).
// «Меньше движения» и спрятанный узел — куски сразу текстом.
import { blurIn, reduced, stop } from '../../utils/motion.js';
import { TEXT_MOTION } from '../../utils/constants.js';
import { h } from '../../utils/dom.js';
import { CLS, graphemes, isSpace, letter, metrics, spoken, unseen } from './letters.js';

const TRAILING_WORD = /\S+$/u;

/** Взять узел под поток; что в нём уже есть — остаётся началом текста. */
export function createStream(el) {
  let text = el.textContent;
  const done = document.createTextNode(text);
  const said = spoken('');
  const visual = h('span', { class: CLS.root, 'aria-hidden': 'true' });
  el.replaceChildren(done, said, visual);

  const landed = new WeakSet();
  const pending = new Set();
  let word = null;
  let nextAt = 0;
  let ended = false;
  let over = false;
  let size = null;

  // Скринридеру: готовое — обычным текстом, хвост в полёте — спрятанной копией.
  const tell = () => { said.textContent = visual.textContent; };

  /** Слово, начатое в готовом тексте, продолжается в той же обёртке — иначе между «при» и «вет» перенос. */
  function openWord() {
    const group = h('span', { class: CLS.word });
    const start = !visual.firstChild && done.data.match(TRAILING_WORD);
    if (start) {
      done.deleteData(done.length - start[0].length, start[0].length);
      group.append(start[0]);
    }
    visual.append(group);
    return group;
  }

  /**
   * Долетевшее — в готовый текст: слова с начала хвоста, у которых сели все
   * буквы и которые уже кончились (за ними пробел, или поток закончен).
   */
  function fold() {
    let node = visual.firstChild;
    while (node) {
      const after = node.nextSibling;
      if (!(node instanceof Text)) {
        if (!ended && !after) break;
        if (![...node.querySelectorAll(`.${CLS.letter}`)].every((one) => landed.has(one))) break;
      }
      done.appendData(node.textContent);
      node.remove();
      node = after;
    }
    tell();
  }

  /** Всё сразу текстом: «меньше движения», отмена, конец без анимации. */
  function flat(final) {
    stop(visual.querySelectorAll(`.${CLS.letter}`));
    pending.clear();
    el.textContent = final;
  }

  function push(chunk) {
    if (over || ended || !chunk) return;
    text += chunk;
    if (reduced() || unseen(el)) {
      if (visual.firstChild) visual.append(chunk);
      else done.appendData(chunk);
      tell();
      return;
    }
    const letters = [];
    for (const g of graphemes(chunk)) {
      if (isSpace(g)) {
        word = null;
        const last = visual.lastChild;
        if (last instanceof Text) last.appendData(g);
        else visual.append(g);
        continue;
      }
      word ??= openWord();
      const one = letter(g);
      word.append(one);
      letters.push(one);
    }
    tell();
    if (!letters.length) return;
    size ??= metrics(el);
    const now = performance.now();
    const delay = Math.min(Math.max(0, nextAt - now), TEXT_MOTION.streamLagMs);
    const room = TEXT_MOTION.streamLagMs - delay;
    const step = letters.length > 1
      ? Math.max(TEXT_MOTION.minStepMs, Math.min(TEXT_MOTION.streamStepMs, room / (letters.length - 1)))
      : 0;
    nextAt = now + delay + step * letters.length;
    const flight = blurIn(letters, { ...size, step, delay, duration: TEXT_MOTION.streamDuration });
    pending.add(flight);
    flight.then(() => {
      pending.delete(flight);
      if (over) return;
      letters.forEach((one) => landed.add(one));
      fold();
    });
  }

  return {
    push,
    /** Поток кончился; `final` — итог (ответ сервера). Обещание — когда буквы долетели. */
    async end(final) {
      if (over) return false;
      const target = final == null ? text : String(final);
      if (target !== text && target.startsWith(text)) push(target.slice(text.length));
      ended = true;
      await Promise.all([...pending]);
      if (over) return false;
      over = true;
      flat(target);
      return true;
    },
    /** Бросить сразу: буквы — текстом того, что пришло (или `final`). */
    cancel(final) {
      if (over) return;
      over = true;
      flat(final == null ? text : String(final));
    },
    text: () => text,
  };
}
