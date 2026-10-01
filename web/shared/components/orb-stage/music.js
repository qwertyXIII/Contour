// Музыка на кольце (голосовой режим, ADR-0014). Когда на сцене лежит вид
// плеера player_view_voice, в центре кольца — обложка трека, а кольцо:
//   - растёт только наружу: внутренняя сторона пустая, центр — под обложку;
//   - слушает трек, если звук играет здесь (utils/audio-taps.js), иначе
//     спокойно дышит — не изображает звук, которого не слышит;
//   - красится главными цветами обложки переливом по кругу (utils/palette.js
//     или цвета из состояния сеанса); сменился трек — цвета перетекают.
//
// Всё — через пульт движка: у каждой капсулы своя зона со своим цветом и своей
// долей спектра. Зона — на обе стороны, но внутрь — ноль: иначе градиент
// капсулы шёл бы от белого (цвет незанятой внутренней стороны) к цвету.
import { EVENTS, ORB_STAGE } from '../../utils/constants.js';
import { tapOf } from '../../utils/audio-taps.js';
import { hexToHsv, hexToRgb, hsvToHex, rgbToHex } from '../../utils/color.js';
import { emit } from '../../utils/dom.js';
import { run } from '../../utils/motion.js';
import { imageColors } from '../../utils/palette.js';

export class MusicRing {
  #orb;
  #root;
  #changed;
  // Зоны хозяина сцены — к ним кольцо возвращается, когда музыка уходит.
  #base;
  #session = null;
  #playing = false;
  #cover = null;
  #palette = [];
  #tint = { share: 1 };
  #shown = [];
  #brightness = 1;
  #frame = { at: -1, values: [] };

  constructor(orb, root, changed, base) {
    this.#orb = orb;
    this.#root = root;
    this.#changed = changed;
    this.#base = base;
    document.addEventListener(EVENTS.playerState, (event) => this.#onState(event.detail));
  }

  get active() {
    return Boolean(this.#session);
  }

  /** Яркость цветов обложки — множитель из настроек (1 — как разобрано). */
  setBrightness(value) {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) return;
    this.#brightness = Math.min(ORB_STAGE.brightness.max, Math.max(ORB_STAGE.brightness.min, next));
    this.refresh();
  }

  /** Перекрасить заново: сменилось число капсул или яркость. */
  refresh() {
    if (this.#shown.length) this.#paint(this.#shown);
  }

  /** Сцена сменила детей: легла или ушла музыка. */
  sync() {
    const view = [...this.#root.children].find((el) => el.classList.contains('player_view_voice'));
    const session = view?.dataset.session ?? null;
    if (session === this.#session) return;
    this.#session = session;
    this.#cover = null;
    this.#root.classList.toggle(ORB_STAGE.music, Boolean(session));
    if (session) {
      this.#paint(this.#palette.length ? this.#palette : [accent()]);
      emit(view, EVENTS.playerCommand, { session, action: 'sync' });
    } else {
      this.#orb.setRegions(this.#base());
    }
    this.#changed();
  }

  #onState(state) {
    if (!this.#session || state.session !== this.#session) return;
    this.#playing = state.playing;
    if (state.cover === this.#cover) return;
    this.#cover = state.cover;
    const cover = state.cover;
    const known = state.colors?.length ? Promise.resolve(state.colors) : imageColors(cover);
    known.then((colors) => {
      if (this.#cover === cover) this.#retint(colors.length ? colors : [accent()]);
    });
  }

  // Новые цвета — перетеканием от тех, что на кольце сейчас.
  #retint(next) {
    const from = this.#palette.length ? this.#palette : next;
    run(this.#tint, (share) => this.#paint(mixPalettes(from, next, share)), { duration: ORB_STAGE.tintDuration, ease: 'in-out' })
      .then((done) => {
        if (done) this.#palette = next;
      });
    if (!this.#palette.length) this.#palette = next;
  }

  #paint(palette) {
    this.#shown = palette;
    if (!this.#session) return;
    const bright = this.#brightness === 1 ? palette : palette.map((hex) => brighten(hex, this.#brightness));
    // Круг — сплошь из равных дуг, по дуге на капсулу: пока капсулы
    // расползаются (сменилось их число), каждая всё равно в какой-то дуге.
    const total = Math.max(1, this.#orb.getCount());
    const half = 0.5 / total;
    this.#orb.setRegions(Array.from({ length: total }, (_, index) => ({
      start: index / total - half,
      end: index / total + half,
      band: 'both',
      color: colorAt(bright, index / total),
      source: (count, ctx) => new Array(count).fill({ inner: 0, outer: this.#level(index, total, ctx.now) }),
    })));
  }

  // Уровень капсулы — из общего на кадр спектра: считается один раз, зон много.
  #level(index, count, now) {
    if (this.#frame.at !== now) this.#frame = { at: now, values: this.#levels(count, now) };
    return this.#frame.values[index] ?? 0;
  }

  #levels(count, now) {
    if (!this.#playing) return new Array(count).fill(0);
    const read = tapOf(this.#session);
    if (read) return mirror(read(Math.ceil(count / 2)), count);
    const { base, depth, periodMs, spread } = ORB_STAGE.breath;
    const phase = (now / periodMs) * Math.PI * 2;
    return Array.from({ length: count }, (_, i) => base + depth * (Math.sin(phase + i * spread) + 1) / 2);
  }
}

// Спектр по кругу зеркалом: низкие наверху, высокие внизу, половины одинаковые.
function mirror(half, count) {
  return Array.from({ length: count }, (_, i) => half[Math.min(i, count - 1 - i)] ?? 0);
}

// Цвет в доле оборота t: цвета палитры стоят по кругу через равные доли, между
// соседями — перелив.
function colorAt(palette, t) {
  if (palette.length === 1) return palette[0];
  const at = (((t % 1) + 1) % 1) * palette.length;
  const i = Math.floor(at);
  return mixHex(palette[i], palette[(i + 1) % palette.length], at - i);
}

function mixHex(a, b, share) {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  return rgbToHex(from.map((c, k) => c + (to[k] - c) * share));
}

// Перетекание палитр разной длины: обе раскладываются по кругу одинаково.
function mixPalettes(from, to, share) {
  const size = Math.max(from.length, to.length) * 2;
  return Array.from({ length: size }, (_, i) => mixHex(colorAt(from, i / size), colorAt(to, i / size), share));
}

function brighten(hex, factor) {
  const { h, s, v } = hexToHsv(hex);
  return hsvToHex({ h, s, v: Math.min(1, v * factor) });
}

function accent() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#fe6344';
}
