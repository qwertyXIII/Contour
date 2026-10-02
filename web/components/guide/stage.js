// Сцена ролика: макет устройства (телефон, ноутбук, телевизор), экраны в нём,
// курсор, палец и рамка фокуса, круг касания, клавиатура, пульт, отметка важного,
// «готово» и субтитры. Кадр ролика (Reel.frameAt) она только рисует: на кадре
// пишутся transform и прозрачность, классы и текст — только переменой.
//
// Координаты — «виртуальные» пиксели макета: устройство нарисовано в своём
// размере и вписано в сцену масштабом. На узкой сцене (телефон владельца) мелкий
// ноутбук не уменьшается до нечитаемого — «камера» приближает его и ведёт за
// курсором, как в видеоуроке.
import { h, svgIcon } from '../../utils/dom.js';
import { reduced } from '/shared/utils/motion.js';
import { buildDevice, buildRemote, padEl } from './devices.js';
import { buildScreen } from './mock.js';

const PAD = 12;
// Камера догоняет точку интереса с этой постоянной времени (мс): переезд к каретке
// на новой строке — плавный, а не скачком.
const CAMERA_LAG = 90;
// Место под пульт рядом с телевизором: снизу (крестовина и кнопки в ряд) или справа — где телевизор выйдет крупнее.
const REMOTE_ROOM = { right: 104, bottom: 92 };

const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Сумма смещений до слоя экрана: transform на пути не считается — нужна раскладка покоя. */
function offsetIn(el, root) {
  let x = 0;
  let y = 0;
  for (let n = el; n && n !== root; n = n.offsetParent) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

export class Stage {
  el;
  #reel;
  #registry;
  #viewport;
  #devices = new Map();
  #screens = new Map();
  #remote = null;
  #done;
  #doneText;
  #caption;
  #size = { w: 0, h: 0 };
  #cache = new Map();
  #seen = new Map();
  #scrolled = new Map();
  #applied = new Set();
  #last = new Map();
  #lit = null;
  #say = '';
  #snapNext = true;
  #sized;

  constructor(reel, label, onResize) {
    this.#reel = reel;
    this.#registry = reel.registry;
    const { registry } = reel;
    const screens = reel.screens();
    this.#viewport = h('div', { class: 'scene__viewport' });
    this.#done = h('div', { class: 'scene__done' }, svgIcon('check', 'scene__done-icon'), (this.#doneText = h('span')));
    this.#caption = h('p', { class: 'scene__caption' });
    this.el = h('figure', { class: 'scene', role: 'img', 'aria-label': label }, this.#viewport, this.#caption);
    const kinds = [...new Set(screens.map((s) => registry[s].device))];
    for (const kind of kinds) this.#devices.set(kind, buildDevice(kind));
    for (const id of screens) this.#screen(id);
    if (kinds.includes('tv')) this.#remote = buildRemote();
    this.#viewport.append(...[...this.#devices.values()].map((d) => d.el), ...(this.#remote ? [this.#remote.el] : []), this.#done);
    this.#sized = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      this.#size = { w: width, h: height };
      onResize();
    });
    this.#sized.observe(this.#viewport);
    // Шрифт пришёл — строки стали другой ширины: старые замеры не годятся.
    document.fonts?.ready.then(() => { this.#cache.clear(); onResize(); });
  }

  #screen(id) {
    const def = this.#registry[id];
    const dev = this.#devices.get(def.device);
    const built = buildScreen(def, this.#reel.index(id));
    // Терминал и камера тёмные в любой теме: так они и выглядят.
    if (def.look === 'term' || def.look === 'cam') built.el.classList.add('theme', 'theme_scheme_dark');
    const layer = h('div', { class: `scene__layer scene__layer_idle${def.chrome ? ' scene__layer_window' : ''}` }, built.el);
    dev.layers.append(layer);
    this.#screens.set(id, { ...built, layer, dev, now: {} });
  }

  // ——— Замеры: место узла на экране в пикселях макета.

  #locate(ref, dev) {
    if (!ref || ref === 'rest') return this.#locate(dev.g.rest, dev);
    if (ref.startsWith('@')) {
      const [fx, fy] = ref.slice(1).split(',').map(Number);
      return { x: fx * dev.g.screen[2], y: fy * dev.g.screen[3], w: 0, h: 0 };
    }
    let r = this.#cache.get(ref);
    const [sid, nid] = ref.split('#');
    const s = this.#screens.get(sid);
    if (!r) {
      const node = s?.nodes.get(nid);
      if (!node) return this.#locate('rest', dev);
      // Узла нет в раскладке (строку убрали) — указатель остаётся там, где его видели последним.
      if (!node.el.offsetParent) return this.#seen.get(ref) ?? this.#locate('rest', dev);
      r = offsetIn(node.el, s.layer);
      this.#cache.set(ref, r);
      this.#seen.set(ref, r);
    }
    return { ...r, y: r.y - (this.#scrolled.get(sid) ?? 0) };
  }

  #scrollFor(sid, ref) {
    if (!ref) return 0;
    const s = this.#screens.get(sid);
    const key = `scroll:${ref}`;
    if (!this.#cache.has(key)) {
      const node = s.nodes.get(ref.split('#')[1]);
      const r = offsetIn(node.el, s.view);
      const max = Math.max(0, s.content.offsetHeight - s.view.clientHeight);
      this.#cache.set(key, clamp(r.y + r.h / 2 - s.view.clientHeight * 0.42, 0, max));
    }
    return this.#cache.get(key);
  }

  // ——— Кадр.

  paint({ S }, t) {
    if (!this.#size.w) return;
    this.#nodes(S);
    for (const dev of this.#devices.values()) this.#paintDevice(dev, S);
    this.#snapNext = false;
    this.#paintRemote(S);
    this.#write(this.#done, 'opacity', S.done ? String(Math.min(1, S.done.p * 5)) : '0');
    this.#write(this.#done, 'transform', `translateX(-50%) scale(${S.done ? 0.86 + 0.14 * Math.min(1, S.done.p * 4) : 0.86})`);
    if (S.done && this.#doneText.textContent !== S.done.text) this.#doneText.textContent = S.done.text;
    const say = S.say?.text ?? '';
    if (say !== this.#say) {
      this.#caption.textContent = say || ' ';
      this.#say = say;
    }
    this.#write(this.#caption, 'opacity', S.say ? String(clamp((t - S.say.at) / 220, 0, 1)) : '1');
  }

  #write(el, prop, value) {
    const key = this.#last.get(el) ?? {};
    if (key[prop] === value) return;
    key[prop] = value;
    this.#last.set(el, key);
    el.style[prop] = value;
  }

  #nodes(S) {
    const refs = new Set([...this.#applied, ...Object.keys(S.nodes)]);
    let moved = false;
    for (const ref of refs) {
      const [sid, nid] = ref.split('#');
      const node = this.#screens.get(sid)?.nodes.get(nid);
      if (node) moved = node.apply({ ...node.init, ...S.nodes[ref] }) || moved;
    }
    this.#applied = new Set(Object.keys(S.nodes));
    if (moved) this.#cache.clear();
  }

  #paintDevice(dev, S) {
    const active = S.device === dev.kind;
    const leaving = S.swap?.device === dev.kind;
    const shown = active || leaving;
    if (dev.now.shown !== shown) dev.el.classList.toggle('scene__device_idle', !shown);
    dev.now.shown = shown;
    if (!shown) return;
    const screen = active ? S.screen : S.from?.screen;
    const from = active && S.from && this.#registry[S.from.screen].device === dev.kind ? S.from : null;
    this.#layers(dev, screen, from, S);
    const g = dev.g;
    const room = dev.kind === 'tv' && this.#remote ? this.#remoteRoom(g) : { w: 0, h: 0 };
    const vw = this.#size.w - room.w;
    const vh = this.#size.h - room.h;
    const fit = Math.min((vw - PAD * 2) / g.w, (vh - PAD * 2) / g.h);
    const zoom = clamp(g.comfort / fit, 1, 1.7);
    const scale = fit * zoom;
    let x = (vw - g.w * scale) / 2;
    let y = (vh - g.h * scale) / 2;
    if (zoom > 1.01) {
      const fp = this.#focusPoint(dev, S, vw / scale, vh / scale);
      if (g.w * scale > vw - PAD * 2) x = clamp(vw / 2 - fp.x * scale, vw - g.w * scale - PAD, PAD);
      if (g.h * scale > vh - PAD * 2) y = clamp(vh / 2 - fp.y * scale, vh - g.h * scale - PAD, PAD);
      [x, y] = this.#follow(dev, x, y);
    }
    const p = S.swap?.p ?? 1;
    const k = active ? (S.swap ? 0.94 + 0.06 * p : 1) : 1 - 0.05 * p;
    this.#write(dev.el, 'transform', `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${(scale * k).toFixed(4)})`);
    this.#write(dev.el, 'opacity', S.swap ? (active ? p : 1 - p).toFixed(3) : '1');
    if (!active) return;
    this.#paintPointer(dev, S);
    this.#paintRing(dev, S);
    this.#paintPad(dev, S);
    this.#paintMark(dev, S);
  }

  /** Сцену убрали со страницы (сменили сценарий) — больше не следить за размером. */
  destroy() {
    this.#sized.disconnect();
  }

  /** Перемотали, сменили размер — камера встаёт на место сразу, без догоняния. */
  snap() {
    this.#snapNext = true;
  }

  #follow(dev, x, y) {
    const now = performance.now();
    const c = dev.cam;
    if (!c || this.#snapNext || reduced()) {
      dev.cam = { x, y, t: now };
      return [x, y];
    }
    const a = 1 - Math.exp(-(now - c.t) / CAMERA_LAG);
    Object.assign(c, { x: c.x + (x - c.x) * a, y: c.y + (y - c.y) * a, t: now });
    return [c.x, c.y];
  }

  // Пульт — туда, где телевизор останется крупнее; класс меняется только переменой.
  #remoteRoom(g) {
    const fit = (w, hh) => Math.min((w - PAD * 2) / g.w, (hh - PAD * 2) / g.h);
    const below = fit(this.#size.w, this.#size.h - REMOTE_ROOM.bottom) >= fit(this.#size.w - REMOTE_ROOM.right, this.#size.h);
    if (this.#remote.below !== below) {
      this.#remote.el.classList.toggle('scene__remote_place_bottom', below);
      this.#remote.below = below;
    }
    return below ? { w: 0, h: REMOTE_ROOM.bottom } : { w: REMOTE_ROOM.right, h: 0 };
  }

  // Точка, на которую смотрит камера: середина того, с чем работают, — но так, чтобы
  // начало широкого узла (команда в терминале, длинное поле) было в кадре.
  #focusPoint(dev, S, seenW, seenH) {
    const [sx, sy, sw, sh] = dev.g.screen;
    const at = (ref) => {
      const r = this.#locate(ref, dev);
      const c = center(r);
      return { x: Math.min(c.x, r.x + seenW / 2 - 24), y: Math.min(c.y, r.y + seenH / 2 - 24) };
    };
    if (!S.cam?.to) return { x: sx + sw / 2, y: sy + sh / 2 };
    const b = this.#caretKeep(dev, S, at(S.cam.to), seenW, seenH);
    const a = S.cam.from ? at(S.cam.from) : b;
    return { x: sx + lerp(a.x, b.x, S.cam.k), y: sy + lerp(a.y, b.y, S.cam.k) };
  }

  // Идёт ввод — каретка в кадре: длинная команда не уезжает за правый край.
  #caretKeep(dev, S, fp, seenW, seenH) {
    const ref = S.cam.to;
    if (!S.nodes[ref]?.typing) return fp;
    const [sid, nid] = ref.split('#');
    const s = this.#screens.get(sid);
    const node = s?.nodes.get(nid);
    node.caret ??= node.el.querySelector('.scene-ui__caret');
    if (!node.caret?.offsetParent) return fp;
    const c = offsetIn(node.caret, s.layer);
    c.y -= this.#scrolled.get(sid) ?? 0;
    return {
      x: c.x > fp.x + seenW / 2 - 48 ? c.x - seenW / 2 + 48 : fp.x,
      y: c.y > fp.y + seenH / 2 - 48 ? c.y - seenH / 2 + 48 : fp.y,
    };
  }

  #layers(dev, current, from, S) {
    const W = dev.g.screen[2];
    const H = dev.g.screen[3];
    for (const [id, s] of this.#screens) {
      if (s.dev !== dev) continue;
      const role = id === current ? 'current' : id === from?.screen ? 'from' : 'idle';
      if (s.now.role !== role) {
        // Строка состояния — в цвет экрана: над камерой она тёмная в любой теме.
        if (role === 'current') dev.status?.classList.toggle('theme_scheme_dark', this.#registry[id].look === 'cam');
        s.layer.classList.toggle('scene__layer_idle', role === 'idle');
        // Уходящий поверх — когда он и движется: «назад» уезжает вправо, лист опускается.
        const leavesOnTop = from?.how === 'back' || from?.how === 'sink';
        s.layer.classList.toggle('scene__layer_top', role === 'current' ? !leavesOnTop : leavesOnTop);
        s.now.role = role;
      }
      if (role === 'idle') continue;
      const p = from?.p ?? 1;
      const how = from?.how;
      let tf = 'none';
      let op = '1';
      if (role === 'current' && from) {
        if (how === 'push') tf = `translateX(${((1 - p) * W).toFixed(1)}px)`;
        else if (how === 'back') tf = `translateX(${(-0.3 * W * (1 - p)).toFixed(1)}px)`;
        else if (how === 'rise') tf = `translateY(${((1 - p) * H).toFixed(1)}px)`;
        else if (how === 'open') tf = `scale(${(0.94 + 0.06 * p).toFixed(4)})`;
        else if (how !== 'sink') tf = `translateY(${((1 - p) * 10).toFixed(1)}px)`;
        if (how === 'fade' || how === 'open') op = p.toFixed(3);
      } else if (role === 'from') {
        if (how === 'push') tf = `translateX(${(-0.3 * W * p).toFixed(1)}px)`;
        else if (how === 'back') tf = `translateX(${(p * W).toFixed(1)}px)`;
        else if (how === 'sink') tf = `translateY(${(p * H).toFixed(1)}px)`;
      }
      this.#write(s.layer, 'transform', tf);
      this.#write(s.layer, 'opacity', op);
      const scroll = S.scroll[id];
      let v = scroll ? lerp(this.#scrollFor(id, scroll.from), this.#scrollFor(id, scroll.to), scroll.k) : 0;
      if (role === 'current') v = Math.max(v, this.#avoidPad(dev, s, id, S.pad));
      this.#scrolled.set(id, v);
      this.#write(s.content, 'transform', v ? `translateY(${(-v).toFixed(1)}px)` : 'none');
    }
  }

  // Клавиатура выехала на поле — экран поднимается, как на телефоне: поле остаётся над ней.
  // Следующее поле под клавиатурой — экран доезжает до него, пока к нему тянется палец.
  #avoidPad(dev, s, id, pad) {
    if (dev.kind !== 'phone' || !pad?.ref?.startsWith(`${id}#`)) return 0;
    const lift = (ref) => {
      const node = ref?.startsWith(`${id}#`) ? s.nodes.get(ref.split('#')[1]) : null;
      if (!node?.el.offsetParent) return 0;
      const key = `avoid:${ref}`;
      if (!this.#cache.has(key)) {
        const keys = this.#pad(dev, pad.kind);
        keys.h ??= keys.el.offsetHeight;
        const r = offsetIn(node.el, s.view);
        this.#cache.set(key, Math.max(0, r.y + r.h - (s.view.clientHeight - keys.h - 10)));
      }
      return this.#cache.get(key);
    };
    const to = lift(pad.ref);
    return (pad.from ? lerp(lift(pad.from), to, pad.lift) : to) * pad.shown;
  }

  #pad(dev, kind) {
    if (!dev.pads[kind]) {
      dev.pads[kind] = padEl(kind, dev.kind);
      dev.screen.insertBefore(dev.pads[kind].el, dev.mark);
    }
    return dev.pads[kind];
  }

  #paintPointer(dev, S) {
    if (!dev.pointer) return;
    const { ptr } = S;
    const a = center(this.#locate(ptr.from, dev));
    const b = center(this.#locate(ptr.to, dev));
    // Путь — лёгкой дугой: прямая выглядит как у робота.
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const arc = Math.sin(Math.PI * ptr.k) * Math.min(40, dist * 0.12);
    const nx = dist ? -(b.y - a.y) / dist : 0;
    const ny = dist ? (b.x - a.x) / dist : 0;
    const x = lerp(a.x, b.x, ptr.k) + nx * arc;
    const y = lerp(a.y, b.y, ptr.k) + ny * arc;
    const finger = dev.kind === 'phone';
    // Палец подняли: нажатое осталось на прежнем экране — над новым его не видно.
    const lifted = finger && ptr.k >= 1 && ptr.to?.includes('#') && ptr.to.split('#')[0] !== S.screen;
    this.#write(dev.pointer, 'transform', `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${(1 - (finger ? 0.18 : 0.12) * ptr.press).toFixed(3)})`);
    this.#write(dev.pointer, 'opacity', (finger ? (lifted ? 0 : ptr.shown * (0.55 + 0.45 * ptr.press)) : 1).toFixed(3));
    const r = S.ripple;
    if (r) {
      const c = center(this.#locate(r.at, dev));
      this.#write(dev.ripple, 'transform', `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) scale(${(0.35 + 1.25 * r.p).toFixed(3)})`);
    }
    this.#write(dev.ripple, 'opacity', r ? ((1 - r.p) * 0.6).toFixed(3) : '0');
  }

  #paintRing(dev, S) {
    if (!dev.ring) return;
    const ring = S.ring;
    const on = ring && ring.to.split('#')[0] === S.screen && !S.from;
    this.#write(dev.ring, 'opacity', on ? '1' : '0');
    this.#lit = S.lit;
    if (!on) return;
    const b = this.#locate(ring.to, dev);
    const sameScreen = ring.from && ring.from.split('#')[0] === S.screen;
    const a = sameScreen ? this.#locate(ring.from, dev) : b;
    if (dev.now.ringTo !== ring.to) {
      dev.ring.style.width = `${b.w + 8}px`;
      dev.ring.style.height = `${b.h + 8}px`;
      dev.now.ringTo = ring.to;
    }
    const w = lerp(a.w, b.w, ring.k) + 8;
    const hh = lerp(a.h, b.h, ring.k) + 8;
    const c = { x: lerp(center(a).x, center(b).x, ring.k), y: lerp(center(a).y, center(b).y, ring.k) };
    const press = 1 - 0.04 * ring.press;
    this.#write(dev.ring, 'transform', `translate(${(c.x - (w * press) / 2).toFixed(1)}px, ${(c.y - (hh * press) / 2).toFixed(1)}px) scale(${((w / (b.w + 8)) * press).toFixed(4)}, ${((hh / (b.h + 8)) * press).toFixed(4)})`);
    if (S.lit === 'arrow') {
      const dx = center(b).x - center(a).x;
      const dy = center(b).y - center(a).y;
      this.#lit = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : dy < 0 ? 'up' : null;
    }
  }

  #paintPad(dev, S) {
    const want = S.pad?.kind ?? null;
    const [axis, away] = dev.kind === 'tv' ? ['translateX', -110] : ['translateY', 110];
    for (const [kind, pad] of Object.entries(dev.pads)) if (kind !== want) this.#write(pad.el, 'transform', `${axis}(${away}%)`);
    if (!want) return;
    const pad = this.#pad(dev, want);
    this.#write(pad.el, 'transform', `${axis}(${((1 - S.pad.shown) * away).toFixed(1)}%)`);
    const typed = S.nodes[S.pad.ref]?.value ?? '';
    if (pad.preview && pad.preview.textContent !== typed) pad.preview.textContent = typed;
    const ch = S.lit?.startsWith('pad:') ? S.lit.slice(4).toLowerCase() : null;
    const key = ch ? pad.keys.get(ch === '\n' ? ' ' : ch) : null;
    if (pad.lit !== key) {
      pad.lit?.classList.remove('scene__key_lit');
      key?.classList.add('scene__key_lit');
      pad.lit = key;
    }
  }

  #paintMark(dev, S) {
    const m = S.mark;
    this.#write(dev.mark, 'opacity', m ? Math.min(1, m.p * 6).toFixed(3) : '0');
    if (!m) return;
    const r = this.#locate(m.at, dev);
    if (dev.now.markAt !== m.at) {
      dev.mark.style.width = `${r.w + 12}px`;
      dev.mark.style.height = `${r.h + 12}px`;
      dev.now.markAt = m.at;
    }
    const pulse = m.p < 1 ? Math.sin(m.p * Math.PI * 3) ** 2 * (1 - m.p) : 0;
    const s = 1 + 0.05 * pulse;
    this.#write(dev.mark, 'transform', `translate(${(r.x - 6 - ((s - 1) * (r.w + 12)) / 2).toFixed(1)}px, ${(r.y - 6 - ((s - 1) * (r.h + 12)) / 2).toFixed(1)}px) scale(${s.toFixed(4)})`);
  }

  #paintRemote(S) {
    if (!this.#remote) return;
    const tv = S.device === 'tv' || S.swap?.device === 'tv';
    const p = S.swap ? (S.device === 'tv' ? S.swap.p : 1 - S.swap.p) : 1;
    this.#write(this.#remote.el, 'opacity', tv ? p.toFixed(3) : '0');
    const lit = tv && S.device === 'tv' ? (S.lit === 'arrow' ? this.#lit : S.lit) : null;
    for (const [k, el] of this.#remote.keys) {
      const on = k === lit;
      if (el.classList.contains('scene__remote-key_lit') !== on) el.classList.toggle('scene__remote-key_lit', on);
    }
  }
}
