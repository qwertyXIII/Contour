// Общее у смены текста и потока (text-motion.js, stream.js): буквы, слова,
// что оставить на месте, сколько двигать.
//
// Буква — графема, а не код символа: «й», флаг и эмодзи с цветом кожи летят
// целиком. Буква в полёте — inline-block (transform у строчного элемента не
// работает), а между inline-block браузер вправе перенести строку где угодно:
// поэтому буквы одного слова держит обёртка без переносов, а пробелы — обычный
// текст между словами. Переносятся строки там же, где у готового текста.
import { h } from '../../utils/dom.js';
import { TEXT_MOTION } from '../../utils/constants.js';

export const CLS = {
  root: 'text-motion',
  rootBlock: 'text-motion_block',
  word: 'text-motion__word',
  letter: 'text-motion__letter',
  swap: 'text-motion__swap',
  gone: 'text-motion__gone',
  goneBlock: 'text-motion__gone_block',
};

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ru', { granularity: 'grapheme' }) : null;

/** Строка → графемы. */
export function graphemes(text) {
  if (!text) return [];
  return segmenter ? [...segmenter.segment(text)].map((s) => s.segment) : Array.from(text);
}

const WORD = /[\p{L}\p{N}\p{M}]/u;
const DIGIT = /\p{Nd}/u;
const SPACE = /^\s+$/u;

export const isSpace = (g) => SPACE.test(g);

/**
 * Можно ли резать строку между i−1 и i, не разрывая слова: у края, у пробела и
 * знака, и между цифрами — число меняется по разрядам, как у табло («15:15» →
 * «15:16» — только последняя цифра). Внутри слова — нет: у «Предложений» и
 * «Поездок» общая «П» — совпадение, а не общая часть.
 */
function cut(list, i) {
  if (i <= 0 || i >= list.length) return true;
  const a = list[i - 1];
  const b = list[i];
  return !WORD.test(a) || !WORD.test(b) || (DIGIT.test(a) && DIGIT.test(b));
}

/**
 * Что у старой и новой строки общего в начале и в конце — это стоит на месте, а
 * меняется только середина. Общее — по границам слов (см. cut) в обеих строках.
 * @returns {{ head: number, tail: number }} — сколько графем с начала и с конца
 */
export function common(before, after) {
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before[head] === after[head]) head += 1;
  while (head > 0 && !(cut(before, head) && cut(after, head))) head -= 1;
  let tail = 0;
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  while (tail > 0 && !(cut(before, before.length - tail) && cut(after, after.length - tail))) tail -= 1;
  return { head, tail };
}

export const letter = (g) => h('span', { class: CLS.letter }, g);

/**
 * Разложить по словам: `parts` — графема (строкой, стоит на месте), буква в
 * полёте (элемент) или готовый узел (обёртка смены — её слово держит целиком).
 * Пробелы — текстом между словами; подряд стоящие графемы склеиваются в один
 * текстовый узел.
 */
export function words(parts) {
  const out = [];
  let word = null;
  let text = null;
  const close = () => { word = null; text = null; };
  for (const part of parts) {
    if (typeof part === 'string' && isSpace(part)) {
      close();
      const last = out.at(-1);
      if (last instanceof Text) last.appendData(part);
      else out.push(document.createTextNode(part));
      continue;
    }
    if (!word) {
      word = h('span', { class: CLS.word });
      out.push(word);
    }
    if (typeof part === 'string') {
      if (text) text.appendData(part);
      else word.append((text = document.createTextNode(part)));
    } else {
      word.append(part);
      text = null;
    }
  }
  return out;
}

/** Сдвиг и размытие — от кегля: у крупного заголовка и мелкой пилюли одна доля высоты. */
export function metrics(el) {
  const size = parseFloat(getComputedStyle(el).fontSize) || 16;
  return { shift: size * TEXT_MOTION.shiftEm, blur: size * TEXT_MOTION.blurEm };
}

/** Шаг очереди: вся очередь — не дольше spanMs. */
export function stepFor(count) {
  return count > 1 ? Math.min(TEXT_MOTION.stepMs, TEXT_MOTION.spanMs / (count - 1)) : 0;
}

/** Показывать нечего: узел не в документе или спрятан — движение никто не увидит. */
export function unseen(el) {
  return !el.isConnected || el.getClientRects().length === 0;
}

/** Итоговый текст для скринридера, пока буквы в полёте (они сами спрятаны от него). */
export const spoken = (text) => h('span', { class: 'visually-hidden' }, text);
