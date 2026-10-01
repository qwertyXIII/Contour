/*
 * Орб — кольцо капсул, которое дышит по состоянию агента.
 *
 * Чистая визуализация: движок не знает ни про микрофон, ни про распознавание, ни
 * про то, кто и почему сменил режим. Ему говорят режим, дают источники звука и
 * зоны — он рисует. Движок кольца сделан в лаборатории 2026-09-27 и перенесён
 * сюда целиком, разложенным по частям:
 * - [orb-ring.js](./orb-ring.js) — набор капсул: число на лету, защита, выбор;
 * - [orb-signals.js](./orb-signals.js) — зоны и источники: спектр, волна,
 *   прогресс, синтетика, занятость;
 * - [orb-paint.js](./orb-paint.js) — геометрия капсулы и запись в SVG;
 * - [orb-layout.js](./orb-layout.js), [orb-color.js](./orb-color.js) — углы,
 *   зазор, цвета; [orb-shapes.js](./orb-shapes.js) — фигуры из капсул.
 *
 * У капсулы две стороны: внутрь от базового радиуса и наружу, у каждой свой
 * сигнал и цвет. Зазор между капсулами гарантирован и во время движения: ширина
 * ограничена угловым сектором капсулы. Центр диаметром `2 × minInnerRadius` — под
 * знак Alter.
 *
 * Импорты — относительные, как во всей системе: в браузере они дают те же
 * адреса `/shared/components/orb/…` (ключи кэша сервис-воркера совпадают),
 * витрина берёт их по `/ui/src/…`, а тесты в node загружают модули кольца с диска.
 *
 * Один экземпляр = один SVG. Их бывает несколько одновременно (голосовой экран и
 * превью в настройках), поэтому id фильтров и градиентов нумеруются: одинаковые
 * id в двух SVG на странице склеиваются, и второй орб получает чужое свечение.
 */

import { clamp, safeWidths, turn } from './orb-layout.js';
import { readPalette, rgb, toHex } from './orb-color.js';
import { EASINGS, busyPalette, configOf, easeAmount, sanitizeLook } from './orb-config.js';
import { DEFAULT_REGIONS, normalizeRegions, regionTargets } from './orb-signals.js';
import { createRing } from './orb-ring.js';
import { MODE_FLOOR, capsuleVisual, writeCapsule } from './orb-paint.js';

const NS = 'http://www.w3.org/2000/svg';

/*
 * Палитра состояний: цвет в тишине → цвет на пике. Тихая капсула всегда белая, а
 * пик красится по смыслу: коралловый — обычная работа, зелёный — получилось,
 * красный — нет.
 */
const MODE_COLORS = {
  idle: '--ink',
  listening: '--coral',
  thinking: '--coral',
  speaking: '--coral',
  success: '--ok',
  error: '--danger',
};

/** Цвет занятости поверх голосов: думает — коралловым, вызов инструмента — своим. */
const BUSY_COLORS = { thinking: '--coral', tool: '--tool' };

let instances = 0;

function node(tag, attributes, parent) {
  const element = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  parent?.append(element);
  return element;
}

function glowFilter(defs, id, spread, blur) {
  const size = `${100 + 2 * spread}%`;
  const filter = node('filter', { id, x: `-${spread}%`, y: `-${spread}%`, width: size, height: size }, defs);
  node('feGaussianBlur', { stdDeviation: blur, result: 'blur' }, filter);
  const merge = node('feMerge', {}, filter);
  node('feMergeNode', { in: 'blur' }, merge);
  node('feMergeNode', { in: 'SourceGraphic' }, merge);
}

/** SVG: фильтры свечения, слой капсул и знак Alter в центре. */
function scaffold(container, uid) {
  const svg = node('svg', { viewBox: '0 0 512 512', 'aria-hidden': 'true', class: 'orb' });
  const defs = node('defs', {}, svg);
  glowFilter(defs, `orb-glow-${uid}`, 120, 4.2);
  glowFilter(defs, `orb-mark-${uid}`, 100, 2.8);
  const layer = node('g', { class: 'orb__capsules', filter: `url(#orb-glow-${uid})` }, svg);
  node('path', { class: 'orb__mark', filter: `url(#orb-mark-${uid})`, d: 'M204 302 L256 211 L308 302' }, svg);
  container.append(svg);
  return { svg, defs, layer };
}

/**
 * Создать орб внутри контейнера. Возвращает пульт: режим, источники, зоны, число
 * капсул, фигура, занятость, старт и стоп.
 */
export function createOrb(container, options = {}) {
  // Вид приходит снаружи (сервер, ползунок) — только проверенным (orb-config.js).
  const config = configOf(options);
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const uid = ++instances;
  const palette = readPalette(MODE_COLORS);
  const theme = readPalette(BUSY_COLORS);
  const colorsOf = () => Object.fromEntries(Object.entries(busyPalette(config, theme)).map(([kind, c]) => [kind, rgb(c)]));
  let busyColors = colorsOf();
  /*
   * Уважаем «уменьшить движение»: непрерывный цикл кадров здесь не украшение, а
   * причина укачивания у тех, кто это включил. Рисуем статичный кадр.
   */
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const { svg, defs, layer } = scaffold(container, uid);
  const ring = createRing({ defs, layer, uid, config, random, still });

  const s = {
    mode: 'idle', source: null, waveSource: null, regions: DEFAULT_REGIONS, progress: 0,
    shape: null, strength: config.shapeEffectStrength,
    transition: { durationMs: config.shapeTransitionMs, easing: config.shapeEasing },
    morph: null, snap: false,
    /** Занятость: заказанная, видимая сейчас (гаснущая ещё видна) и её доля 0…1. */
    busy: null, busyShown: null, busyFade: 0,
    phase: 0, previousTime: 0, frameId: 0, revertTimer: 0,
  };

  function frameState(now, immediate) {
    const elapsed = Math.min(0.05, Math.max(0, (now - s.previousTime) / 1000));
    s.previousTime = now;
    const speed = s.mode === 'thinking' ? 5.6 : s.mode === 'speaking' ? 4.2 : s.mode === 'listening' ? 2.3 : 1.6;
    s.phase += elapsed * speed;
    return {
      now, elapsed, immediate, mode: s.mode, palette, shape: s.shape, strength: s.strength,
      morph: s.morph, snap: immediate || s.snap,
      morphProgress: s.morph ? easeAmount((now - s.morph.started) / s.morph.durationMs, s.morph.easing) : 1,
      ...busyFrame(elapsed, immediate),
    };
  }

  /**
   * Свет занятости не вспыхивает и не пропадает, а нарастает и гаснет за
   * `busyFadeMs` (владелец): резкая комета и мелькание на быстром вызове. Сменился
   * вид («думает» → комета) — старый сначала гаснет, потом разгорается новый:
   * подмена голов кометой в один кадр и была «резко появляется».
   */
  function busyFrame(elapsed, immediate) {
    const step = immediate || config.busyFadeMs <= 0 ? 1 : (elapsed * 1000) / config.busyFadeMs;
    if (s.busyShown && s.busy !== s.busyShown) {
      s.busyFade = Math.max(0, s.busyFade - step);
      if (s.busyFade === 0) s.busyShown = s.busy;
    } else {
      s.busyShown = s.busy;
      s.busyFade = s.busy ? Math.min(1, s.busyFade + step) : Math.max(0, s.busyFade - step);
    }
    const fade = s.busyFade * s.busyFade * (3 - 2 * s.busyFade);
    return { busy: s.busyShown, busyFade: fade, busyColor: busyColors[s.busyShown] ?? null };
  }

  function paint(now, immediate = false) {
    ring.advance(now);
    const frame = frameState(now, immediate);
    const capsules = ring.capsules;
    const wanted = regionTargets(capsules, s.regions, {
      now, mode: s.mode, phase: s.phase, progress: s.progress, random,
      source: s.source, waveSource: s.waveSource, look: config,
    });
    const visuals = capsules.map((capsule, index) => capsuleVisual(
      capsule, wanted.get(capsule.id), index, capsules.length, config, frame,
    ));
    const limits = safeWidths(visuals, config.gap);
    capsules.forEach((capsule, index) => {
      const width = Math.max(0, Math.min(visuals[index].width, limits[index]));
      writeCapsule(capsule, visuals[index], width, config, MODE_FLOOR[s.mode]);
    });
    if (s.morph && (frame.snap || frame.morphProgress >= 1)) s.morph = null;
    s.snap = false;
    ring.sweep(now);
  }

  function frame(now) {
    s.frameId = 0;
    paint(now);
    s.frameId = requestAnimationFrame(frame);
  }

  /** Со «уменьшить движение» кадр рисуется по каждой перемене, а не циклом. */
  function invalidate() {
    if (still) paint(performance.now(), true);
  }

  function start() {
    if (still) {
      paint(performance.now(), true);
      return;
    }
    if (s.frameId) return;
    s.previousTime = performance.now();
    s.frameId = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(s.frameId);
    s.frameId = 0;
  }

  /**
   * `revertAfter` — для состояний-вспышек: «получилось» и «не получилось» обязаны
   * сами гаснуть, иначе орб замирает в них навсегда.
   */
  function setMode(next, { revertAfter = 0, revertTo = 'idle' } = {}) {
    if (!(next in MODE_COLORS)) return;
    clearTimeout(s.revertTimer);
    s.mode = next;
    invalidate();
    if (revertAfter > 0) s.revertTimer = setTimeout(() => setMode(revertTo), revertAfter);
  }

  /**
   * Фигура: функция угла → `radius`, `inner`, `outer`, `width`, цвета, `activity`
   * (готовые — в orb-shapes.js); `null` — кольцо. Переход — с видимого сейчас,
   * так что прерванная смена не прыгает. `mark: false` прячет знак Alter.
   */
  function setShape(next, { mark = typeof next !== 'function' } = {}) {
    const chosen = typeof next === 'function' ? next : null;
    svg.classList.toggle('orb--shape', !mark);
    if (s.shape === chosen) return;
    const { durationMs, easing } = s.transition;
    s.morph = durationMs > 0 && !still ? { started: performance.now(), durationMs, easing, from: snapshot() } : null;
    s.snap = !s.morph;
    s.shape = chosen;
    invalidate();
  }

  /** С чего начинается переход фигуры — с видимого сейчас. */
  function snapshot() {
    return new Map(ring.capsules.map((c) => [c.id, {
      radius: c.currentRadius, inner: c.currentInner, outer: c.currentOuter, width: c.currentWidth,
      innerColor: c.lastInnerColor, outerColor: c.lastOuterColor, activity: c.lastActivity,
    }]));
  }

  /**
   * Вид на ходу (экран «Кольцо и звук», ADR-0053): число капсул, растяжение,
   * отклик, свет занятости, переход фигур. Непонятое и мусор отбрасываются;
   * возвращается, что принято.
   */
  function configure(patch = {}) {
    const next = sanitizeLook(patch);
    Object.assign(config, next);
    if ('count' in next) ring.setCount(next.count, performance.now());
    if ('shapeEffectStrength' in next) s.strength = next.shapeEffectStrength;
    if ('shapeTransitionMs' in next || 'shapeEasing' in next) {
      setShapeTransition({ durationMs: config.shapeTransitionMs, easing: config.shapeEasing });
    }
    if ('thinkColor' in next || 'toolColor' in next) busyColors = colorsOf();
    invalidate();
    return next;
  }

  function setShapeTransition(next = {}) {
    if ('durationMs' in next) s.transition.durationMs = clamp(Number(next.durationMs), 0, 3000);
    if (EASINGS.includes(next.easing)) s.transition.easing = next.easing;
    svg.style?.setProperty('--shape-mark-duration', `${s.transition.durationMs}ms`);
    return { ...s.transition };
  }

  return {
    element: svg,
    start,
    stop,
    setMode,
    getMode: () => s.mode,
    /** Число капсул; защищённые не убираются — вернётся столько, сколько вышло. */
    setCount(value) {
      const count = ring.setCount(value, performance.now());
      invalidate();
      return count;
    },
    getCount: () => ring.count(),
    getCapsules: () => ring.capsules.map((c) => ({
      id: c.id, angle: turn(c.angle), protected: c.protected,
      retiring: c.retiringAt !== null, overrides: { ...c.overrides },
    })),
    /** Своя длина, ширина, цвета и защита капсулы; `null` в поле снимает правку. */
    updateCapsule(id, patch) {
      const done = ring.update(id, patch, performance.now());
      invalidate();
      return done;
    },
    onSelect: ring.onSelect,
    selectCapsule: ring.select,
    /** Зоны кольца — см. orb-signals.js. */
    setRegions(next) {
      if (!Array.isArray(next)) return;
      s.regions = normalizeRegions(next);
      invalidate();
    },
    setProgress(value) { s.progress = clamp(Number(value)); invalidate(); },
    setShape,
    setShapeTransition,
    getShapeTransition: () => ({ ...s.transition }),
    configure,
    /** Цвета темы, которыми светит занятость без своих, — для палитры на экране. */
    themeColors: () => ({ thinkColor: toHex(theme.thinking), toolColor: toHex(theme.tool) }),
    setShapeEffectStrength(value) { s.strength = clamp(Number(value), 0, 1.5); invalidate(); return s.strength; },
    /** Спектр: (count) → числа 0…1, или null — синтетика. */
    setSource(next) { s.source = typeof next === 'function' ? next : null; invalidate(); },
    /** Двусторонняя волна: (count) → {inner, outer}. */
    setWaveSource(next) { s.waveSource = typeof next === 'function' ? next : null; invalidate(); },
    /** Занятость поверх голосов: `thinking`, `tool` или null. */
    setBusy(kind) { s.busy = kind === 'thinking' || kind === 'tool' ? kind : null; invalidate(); },
    destroy() {
      stop();
      clearTimeout(s.revertTimer);
      svg.remove();
    },
  };
}

export const ORB_MODES = Object.keys(MODE_COLORS);
