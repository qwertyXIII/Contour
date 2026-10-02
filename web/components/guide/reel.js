// Ролик сценария: шаги → удары («нажать», «вписать», «перейти», «пульт: OK»…) с
// длительностями, и кадр в любой момент — чистой функцией от времени. Поэтому
// перемотка к шагу, пауза посреди движения и «меньше движения» (кадр конца шага)
// получаются сами, без отдельного кода. Кадр считается заново от снимка начала
// шага: ударов в шаге десяток, пересчитать их дешевле и надёжнее, чем откатывать
// перемены назад.
//
// Удар в данных — массив: [глагол, цель, …]. Цель — id узла текущего экрана
// (`wifi`, `home.info`) или узел другого экрана (`ios.net#dns`). Глаголы:
//   screen id            — начать с экрана, без перехода;
//   go id how?           — перейти: push | back | fade | rise | open; чужое устройство — смена устройства;
//   tap id fx?           — нажать (курсор, палец; на ТВ — рамка фокуса + OK); fx — что поменялось;
//   toggle id on fx?     — нажать переключатель; pick id fx? — выбрать один из соседей;
//   focus id · ok fx? · key name fx?  — пульт телевизора;
//   type id text o?      — вписать посимвольно (сначала нажать поле; o.tap: false — без этого);
//   paste id text        — вставить целиком; scroll id — пролистать к узлу;
//   show|hide|gone ids o? · set id patch — перемена без нажатия (ответ системы);
//   mark id say · wait ms · done text · enter lines · scan id · play id.
// fx: { go, how, show, hide, gone, set: { id: patch }, say }.
import { indexScreen, siblings } from './mock.js';

export const TIME = {
  move: 560, press: 150, release: 230, go: 520, swap: 820, focus: 360, key: 430,
  char: 80, dot: 130, pad: 260, scroll: 1150, mark: 1500, done: 1700, set: 450,
  line: 260, scan: 1600, play: 2200, tail: 1100,
};

const KEY_SAY = { menu: 'Пульт: кнопка настроек', home: 'Пульт: «Домой»', back: 'Пульт: «Назад»', right: 'Пульт: вправо', left: 'Пульт: влево' };

const clamp = (v) => Math.min(1, Math.max(0, v));
const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// Кривые — из токенов движения (одна рука со всей системой): cubic-bezier решением Ньютона.
function bezier([x1, y1, x2, y2]) {
  const at = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  const slope = (a, b, t) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;
  return (x) => {
    if (x <= 0 || x >= 1) return clamp(x);
    let t = x;
    for (let i = 0; i < 6; i += 1) t -= (at(x1, x2, t) - x) / (slope(x1, x2, t) || 1);
    return at(y1, y2, clamp(t));
  };
}

function curve(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).match(/-?[\d.]+/g)?.map(Number);
  return bezier(raw?.length === 4 ? raw : fallback);
}

const blank = () => ({
  screen: null, device: null, from: null, swap: null, nodes: {}, scroll: {}, cam: null,
  ptr: { from: 'rest', to: 'rest', k: 1, press: 0, shown: 0 },
  ripple: null, ring: null, lit: null, pad: null, mark: null, done: null, say: null,
});

export class Reel {
  /** `registry` — id экрана → определение; `deviceOf` — экран → устройство. */
  constructor(scenario, registry) {
    this.registry = registry;
    this.#indexes = new Map();
    this.ease = curve('--ease-out', [0.22, 1, 0.36, 1]);
    this.move = curve('--ease-in-out', [0.65, 0, 0.35, 1]);
    this.steps = this.#compile(scenario);
    this.total = this.steps.at(-1)?.end ?? 0;
  }

  #indexes;
  #snaps = [];

  index(screen) {
    if (!this.#indexes.has(screen)) this.#indexes.set(screen, indexScreen(this.registry[screen]));
    return this.#indexes.get(screen);
  }

  /** Экраны, которые ролик покажет, — собрать заранее. */
  screens() {
    return [...new Set(this.steps.flatMap((s) => s.beats.flatMap((b) => [b.screen, b.ref?.split('#')[0]]).filter(Boolean)))];
  }

  stepAt(t) {
    const i = this.steps.findIndex((s) => t < s.end);
    return i === -1 ? this.steps.length - 1 : i;
  }

  /** Кадр в момент t: { step, S }. */
  frameAt(t) {
    const step = this.stepAt(t);
    const S = structuredClone(this.#snap(step));
    for (const b of this.steps[step].beats) {
      if (t < b.start) break;
      this.#apply(S, b, Math.min(b.dur, t - b.start));
    }
    return { step, S };
  }

  #snap(i) {
    if (!this.#snaps[0]) this.#snaps[0] = blank();
    for (let k = this.#snaps.length; k <= i; k += 1) {
      const S = structuredClone(this.#snaps[k - 1]);
      for (const b of this.steps[k - 1].beats) this.#apply(S, b, b.dur);
      // Отметки шага остаются в его конце, следующий начинается чистым.
      Object.assign(S, { mark: null, done: null, say: null, ripple: null, lit: null, from: null, swap: null });
      this.#snaps[k] = S;
    }
    return this.#snaps[i];
  }

  // ——— Сборка: глаголы данных → удары с длительностью и подписью.

  #compile(scenario) {
    const c = { screen: null, device: null, ring: null };
    let clock = 0;
    return scenario.steps.map((step) => {
      const beats = (step.scene ?? []).flatMap((raw) => this.#expand(raw, c));
      this.#padFlow(beats);
      // Шаг начинается без своей подписи (переход, смена устройства) — субтитр: название шага.
      if (beats[0] && !beats[0].say) beats[0].say = step.title;
      const start = clock;
      for (const b of beats) {
        b.start = clock;
        clock += b.dur;
      }
      clock += TIME.tail;
      return { start, end: clock, beats };
    });
  }

  #ref(c, id) {
    return id.includes('#') ? id : `${c.screen}#${id}`;
  }

  #label(ref) {
    const [screen, id] = ref.split('#');
    return this.index(screen).get(id)?.label ?? '';
  }

  #fx(c, ref, f) {
    f ??= {};
    const out = [];
    const put = (ids, patch) => list(ids).forEach((id) => out.push([this.#ref(c, id), patch]));
    put(f.show, { off: false, gone: false });
    put(f.hide, { off: true });
    put(f.gone, { gone: true });
    for (const [id, patch] of Object.entries(f.set ?? {})) put(id, patch);
    return out;
  }

  // Переход по умолчанию — как на самом устройстве: телефон листает вбок, окна и ТВ сменяются наплывом.
  #go(c, screen, how) {
    const device = this.registry[screen].device;
    how ??= device === 'phone' ? 'push' : 'fade';
    const swap = device !== c.device;
    c.screen = screen;
    c.device = device;
    if (swap) c.ring = null;
    return { v: 'go', screen, device, how, dur: swap ? TIME.swap : TIME.go };
  }

  #press(c, id, fx, say) {
    const ref = this.#ref(c, id);
    const text = this.#label(ref);
    // Подпись части строки уже с кавычками («ⓘ у «Домашняя»») — второй раз не оборачиваем.
    const label = say ?? (!text ? '' : text.includes('«') ? text : `«${text}»`);
    const after = fx?.go ? [this.#go(c, fx.go, fx.how)] : [];
    const effects = this.#fx(c, ref, fx);
    if (c.device === 'tv') {
      c.ring = ref;
      return [{ v: 'focus', ref, dur: TIME.focus }, { v: 'key', key: 'ok', dur: TIME.key, fx: effects, say: fx?.say ?? `OK — ${label}` }, ...after];
    }
    return [{ v: 'tap', ref, fx: effects, say: fx?.say ?? label, dur: TIME.move + TIME.press + TIME.release }, ...after];
  }

  #expand([verb, a, b, o], c) {
    const ref = typeof a === 'string' && verb !== 'screen' && verb !== 'go' && verb !== 'key' && verb !== 'done' ? this.#ref(c, a) : null;
    switch (verb) {
      case 'screen': {
        c.screen = a;
        c.device = this.registry[a].device;
        return [{ v: 'screen', screen: a, device: c.device, dur: 0 }];
      }
      case 'go': return [this.#go(c, a, b)];
      case 'tap': return this.#press(c, a, b, b?.say);
      case 'toggle': {
        const fx = { ...o, set: { ...o?.set, [a]: { ...o?.set?.[a], on: b } } };
        return this.#press(c, a, fx, o?.say ?? `${b ? 'Включи' : 'Выключи'} «${this.#label(ref)}»`);
      }
      case 'pick': {
        const [screen, nid] = ref.split('#');
        const set = { ...b?.set, [a]: { on: true } };
        for (const id of siblings(this.index(screen), nid)) set[id] = { on: false };
        return this.#press(c, a, { ...b, set }, b?.say ?? `Выбери «${this.#label(ref)}»`);
      }
      case 'focus':
        c.ring = ref;
        return [{ v: 'focus', ref, dur: TIME.focus, say: b?.say }];
      case 'ok': {
        const after = a?.go ? [this.#go(c, a.go, a.how ?? 'fade')] : [];
        return [{ v: 'key', key: 'ok', dur: TIME.key, fx: this.#fx(c, c.ring, a), say: a?.say ?? `OK — «${this.#label(c.ring)}»` }, ...after];
      }
      case 'key': {
        const fx = this.#fx(c, null, b);
        const after = b?.go ? [this.#go(c, b.go, b.how ?? 'fade')] : [];
        return [{ v: 'key', key: a, dur: TIME.key, fx, say: b?.say ?? KEY_SAY[a] }, ...after];
      }
      case 'type': return this.#type(c, a, ref, b, o ?? {});
      case 'paste': return [...this.#press(c, a, null, ''), { v: 'set', fx: [[ref, { value: b }]], dur: TIME.set, say: o?.say ?? 'Вставь' }];
      case 'scroll': return [{ v: 'scroll', ref, screen: c.screen, dur: TIME.scroll, say: b?.say ?? 'Пролистай вниз' }];
      case 'show':
      case 'hide':
      case 'gone': return [{ v: 'set', fx: this.#fx(c, null, { [verb]: a }), dur: TIME.set, say: b?.say }];
      case 'set': return [{ v: 'set', fx: [[ref, b]], dur: TIME.set, say: o?.say }];
      case 'mark': return [{ v: 'mark', ref, dur: TIME.mark, say: b }];
      case 'wait': return [{ v: 'wait', dur: a }];
      case 'done': return [{ v: 'done', text: a, dur: TIME.done, say: a }];
      case 'enter': return [this.#enter(c, b ?? [], ref)];
      case 'scan': return [{ v: 'progress', ref, dur: TIME.scan, wave: true, say: b?.say ?? 'Наведи камеру на QR' }];
      case 'play': return [{ v: 'progress', ref, dur: b ?? TIME.play }];
      default: throw new Error(`ролик: неизвестный глагол «${verb}»`);
    }
  }

  #type(c, id, ref, text, o) {
    const [screen, nid] = ref.split('#');
    const term = this.index(screen).get(nid)?.node.k === 'term';
    const tap = term || o.tap === false ? [] : this.#press(c, id, null, '');
    // В терминале печатают быстрее: команды длинные, а смысл — в том, что за ними.
    const pace = term ? 0.5 : 1;
    const marks = [];
    let at = 0;
    for (const ch of text) {
      at += (ch === '.' || ch === ' ' || ch === '\n' ? TIME.dot : TIME.char) * pace;
      marks.push(at);
    }
    const pad = c.device === 'phone' || c.device === 'tv' ? (/^[\d.]+$/.test(text) ? 'num' : 'abc') : null;
    const shown = text.split('\n')[0];
    return [...tap, { v: 'type', ref, text, marks, pad, padIn: pad ? TIME.pad : 0, padOut: pad ? TIME.pad : 0, say: o.say ?? `Впиши ${shown.length > 34 ? `${shown.slice(0, 32)}…` : shown}` }];
  }

  #enter(c, out, ref) {
    const [screen, id] = ref.split('#');
    const n = this.index(screen).get(id).node;
    return { v: 'enter', ref, prompt: n.prompt, base: n.lines, out, dur: TIME.line * (out.length + 1), say: '⏎ Enter' };
  }

  // Клавиатура не прячется между полями подряд: «вписать — нажать следующее — вписать».
  #padFlow(beats) {
    beats.forEach((b, i) => {
      if (b.v !== 'type') return;
      const next = beats.slice(i + 1).find((x) => x.v !== 'tap');
      const between = beats.slice(i + 1, beats.indexOf(next)).every((x) => x.v === 'tap');
      if (next?.v === 'type' && next.pad === b.pad && between) {
        b.padOut = 0;
        next.padIn = 0;
      }
    });
    for (const b of beats) if (b.v === 'type') b.dur = b.padIn + (b.marks.at(-1) ?? 0) + 220 + b.padOut;
  }

  // ——— Удары на кадре: e — сколько миллисекунд удар уже идёт (до своей длины).

  #apply(S, b, e) {
    if (b.say) S.say = { text: b.say, at: b.start };
    const fx = () => (b.fx ?? []).forEach(([ref, patch]) => { S.nodes[ref] = { ...S.nodes[ref], ...patch }; });
    const p = b.dur ? e / b.dur : 1;
    switch (b.v) {
      case 'screen':
        Object.assign(S, { screen: b.screen, device: b.device, from: null, swap: null });
        break;
      case 'go': {
        const [prev, dev] = [S.screen, S.device];
        S.screen = b.screen;
        S.device = b.device;
        if (dev && dev !== b.device) Object.assign(S, { ptr: blank().ptr, ring: null, pad: null, mark: null, cam: null });
        S.from = p < 1 && prev ? { screen: prev, how: b.how, p: this.ease(p) } : null;
        S.swap = p < 1 && dev && dev !== b.device ? { device: dev, p: this.ease(p) } : null;
        break;
      }
      case 'tap': {
        const pe = e - TIME.move;
        const press = pe < 0 ? 0 : pe < TIME.press ? pe / TIME.press : clamp(1 - (pe - TIME.press) / TIME.release);
        S.ptr = { from: S.ptr.to, to: b.ref, k: this.move(clamp(e / TIME.move)), press, shown: Math.max(S.ptr.shown, clamp(e / 240)) };
        this.#look(S, b.ref, S.ptr.k);
        S.ripple = pe >= 0 && p < 1 ? { at: b.ref, p: clamp(pe / (TIME.press + TIME.release)) } : null;
        if (pe >= TIME.press * 0.6) fx();
        if (p >= 1) S.ptr = { from: b.ref, to: b.ref, k: 1, press: 0, shown: 1 };
        // Клавиатура не уехала (поля подряд) — экран доезжает до следующего поля вместе с пальцем.
        if (S.pad) S.pad = { ...S.pad, from: S.pad.ref, ref: b.ref, lift: S.ptr.k };
        break;
      }
      case 'focus':
        S.ring = { from: S.ring?.to ?? null, to: b.ref, k: this.move(p), press: 0 };
        this.#look(S, b.ref, S.ring.k);
        S.lit = p < 0.7 ? 'arrow' : null;
        break;
      case 'key':
        S.lit = p < 0.75 ? b.key : null;
        if (b.key === 'ok' && S.ring) S.ring.press = Math.sin(Math.PI * clamp(p / 0.6));
        if (p >= 0.45) fx();
        break;
      case 'type': this.#typing(S, b, e); break;
      case 'enter': {
        const prev = S.nodes[b.ref] ?? {};
        const shown = Math.floor(e / TIME.line);
        const lines = [...(prev.lines ?? b.base), ['cmd', `${b.prompt} ${prev.value ?? ''}`], ...b.out.slice(0, Math.max(0, shown)).map((t) => ['out', t])];
        S.nodes[b.ref] = { ...prev, lines, value: '', typing: false };
        break;
      }
      case 'scroll': this.#scrolling(S, b, e); break;
      case 'progress': {
        const v = b.wave ? (1 - Math.cos(2 * Math.PI * p)) / 2 : p;
        S.nodes[b.ref] = { ...S.nodes[b.ref], progress: p >= 1 && b.wave ? 0 : v };
        break;
      }
      case 'set': fx(); break;
      case 'mark':
        S.mark = { at: b.ref, p };
        this.#look(S, b.ref, this.ease(clamp(p * 2.5)));
        break;
      case 'done': S.done = { text: b.text, p }; break;
      default: break;
    }
  }

  // Куда смотрит «камера» на узкой сцене: на то, что нажимают, вписывают, отмечают.
  #look(S, ref, k) {
    S.cam = { from: S.cam?.to ?? null, to: ref, k };
  }

  #typing(S, b, e) {
    const at = e - b.padIn;
    this.#look(S, b.ref, this.ease(clamp(e / 350)));
    const n = at < 0 ? 0 : b.marks.filter((m) => m <= at).length;
    const done = e >= b.dur;
    S.nodes[b.ref] = { ...S.nodes[b.ref], value: b.text.slice(0, n), typing: !done };
    S.lit = n > 0 && !done && at - b.marks[n - 1] < 120 ? `pad:${b.text[n - 1]}` : null;
    if (!b.pad) return;
    const out = b.padOut ? clamp((b.dur - e) / b.padOut) : 1;
    const shown = Math.min(b.padIn ? clamp(e / b.padIn) : 1, out);
    S.pad = done && b.padOut ? null : { kind: b.pad, shown: this.ease(shown), ref: b.ref, from: null, lift: 1 };
  }

  #scrolling(S, b, e) {
    const lead = 280;
    const tail = 180;
    const from = '@0.64,0.76';
    const to = '@0.6,0.34';
    const k = this.move(clamp((e - lead) / (b.dur - lead - tail)));
    S.scroll[b.screen] = { from: S.scroll[b.screen]?.to ?? null, to: b.ref, k };
    S.ptr = e < lead
      ? { from: S.ptr.to, to: from, k: this.move(e / lead), press: 0, shown: 1 }
      : { from, to, k, press: e < b.dur - tail ? 1 : clamp(1 - (e - b.dur + tail) / tail), shown: 1 };
    if (e >= b.dur) S.ptr = { from: to, to, k: 1, press: 0, shown: 1 };
  }
}
