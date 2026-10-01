// Полёт снимка между плиткой и просмотром: открыли — снимок вырастает из своей
// плитки во весь экран; закрыли — возвращается в плитку, на которой
// остановились. Как в «Фото» iPhone: летит рамка (viewer__flyer — обрезает), а в
// ней снимок целиком (viewer__picture), и обрезка плитки плавно раскрывается в
// весь кадр — и обратно. Плитка показывает обрезку снимка по центру (квадрат
// сетки), поэтому в начале полёта снимок стоит так, что в рамке видно ровно то,
// что было на плитке, а в конце рамка и снимок — один кадр слайда.
//
// В рамке — то же, что в слайде (picture.js): картинка плитки на своём месте,
// поверх — превью в пропорции или файл, когда пришли (`slideStill`). Лента и
// рамка просмотра на время полёта спрятаны (viewer_flying), плитка — тоже: двух
// одинаковых снимков на экране не бывает.
//
// Плитки не видно (ушла за край, лента на другом экране) или движение
// гасится — не летим: просмотр открывается и закрывается как раньше.
import { VIEWER } from '../../utils/constants.js';
import { h } from '../../utils/dom.js';
import { move, reduced, stop } from '../../utils/motion.js';
import { buildPicture, tileLayout } from './picture.js';
import { slideStill } from './slides.js';

/** Кадр слайда, в который летит снимок: фото — рамка снимка, видео — блок video. */
const FRAME = '.viewer__picture, .viewer__video';

export class Flight {
  #dialog;
  #shade;
  #flyer = null;
  #picture = null;
  #origin = null;

  constructor(dialog, shade) {
    this.#dialog = dialog;
    this.#shade = shade;
  }

  /** Вырасти из плитки в слайд. false — лететь неоткуда. */
  open(origin, item, slide) {
    const tile = tileImage(origin);
    const frame = slide?.querySelector(FRAME);
    if (reduced() || !shown(origin) || !tile || !frame) return false;
    const from = tileBox(origin);
    const ratio = item?.ratio || tile.ratio;
    const to = frameBox(frame, slide, ratio);
    const still = slideStill(slide);
    const picture = this.#take(origin, { tile, ratio, src: still.url, ready: still.ready }, from, tileLayout(from, tile.ratio, ratio));
    this.#dialog.classList.add(VIEWER.flying);
    // Плитка прячется, когда рамка полёта нарисовала её картинку: до того плитка видна сквозь неё.
    void painted(picture.thumb).then(() => {
      if (this.#picture === picture && this.#dialog.classList.contains(VIEWER.flying)) origin.style.visibility = 'hidden';
    });
    Promise.all([
      move(this.#flyer, path(from, to), { spring: 'soft' }),
      move(this.#picture.root, path(tileLayout(from, tile.ratio, ratio), whole(to)), { spring: 'soft' }),
      move(this.#shade, { opacity: [0, 1] }, { spring: 'soft' }),
    ]).then(([done]) => {
      if (done) this.#landed(slide, still);
    });
    return true;
  }

  /** Вернуться в плитку. Обещание выполняется, когда можно закрывать. */
  async close(origin, slide, item) {
    const tile = tileImage(origin);
    const frame = slide?.querySelector(FRAME);
    if (reduced() || !shown(origin) || !tile || !frame) return;
    const own = boxOf(frame);
    const ratio = own.width > 0 && own.height > 0 ? own.width / own.height : item?.ratio || tile.ratio;
    // Закрыли посреди полёта — продолжаем оттуда, где рамка и снимок сейчас.
    const from = this.#flyer ? boxOf(this.#flyer) : own;
    const inner = this.#picture ? relative(boxOf(this.#picture.root), from) : whole(from);
    const to = tileBox(origin);
    const fade = getComputedStyle(this.#shade).opacity;
    // Слайд прячется, только когда рамка полёта нарисовала то же, что в нём: до
    // того она лежит поверх него, и подмены не видно. Закрыли посреди полёта —
    // слайд и так спрятан, ждать нечего.
    const src = stillNow(slide, frame);
    const midway = Boolean(this.#flyer);
    const picture = this.#take(origin, { tile, ratio, src }, from, inner);
    if (!midway) await painted(src ? picture.image : picture.thumb);
    if (this.#picture !== picture) return;
    origin.style.visibility = 'hidden';
    this.#dialog.classList.add(VIEWER.flying);
    // Ждём, пока пружина успокоится совсем: в «кажется законченной» снимок ещё
    // в десятке пикселей от плитки, и закрытие дёрнуло бы его на место.
    await Promise.all([
      move(this.#flyer, path(from, to), { spring: 'soft' }),
      move(this.#picture.root, path(inner, tileLayout(to, tile.ratio, ratio)), { spring: 'soft' }),
      move(this.#shade, { opacity: [fade, 0] }, { spring: 'soft' }),
    ]);
  }

  /**
   * Убрать рамку полёта: снимок уже на месте или слайд сменили. Сменили посреди
   * полёта — долёта не будет (пружину остановили), поэтому лента и рамка
   * возвращаются здесь же: иначе просмотр остался бы с пустой лентой.
   */
  drop() {
    if (!this.#flyer) return;
    stop(this.#flyer);
    stop(this.#picture.root);
    this.#flyer.remove();
    this.#flyer = null;
    this.#picture = null;
    if (!this.#dialog.classList.contains(VIEWER.flying)) return;
    this.#release();
    stop(this.#shade);
    this.#shade.style.removeProperty('opacity');
    this.#dialog.classList.remove(VIEWER.flying);
  }

  /** Просмотр закрылся — всё вернуть, как было до полёта. */
  reset() {
    this.drop();
    this.#release();
    stop(this.#shade);
    this.#shade.style.removeProperty('opacity');
    this.#dialog.classList.remove(VIEWER.flying);
  }

  // Начать полёт: рамка встаёт на место отправления, снимок в ней — как inner.
  // Картинка поверх плитки — сразу (src: она уже нарисована в слайде, без
  // проявления) или когда слайд её получит (ready). Прятать плитку и ленту —
  // вызывающему: когда рамка нарисовала своё. Ответ — рамка снимка.
  #take(origin, { tile, ratio, src, ready }, box, inner) {
    this.drop();
    this.#release();
    this.#origin = origin;
    const image = h('img', { class: 'viewer__image', alt: '', decoding: 'async', draggable: 'false' });
    const picture = buildPicture(ratio, tile, image);
    this.#picture = picture;
    Object.assign(picture.root.style, px(inner));
    if (src) {
      image.src = src;
      picture.root.classList.add(VIEWER.ready);
    } else {
      ready?.then((url) => {
        if (url && this.#picture === picture) void picture.show(url);
      });
    }
    this.#flyer = h('div', {
      class: 'viewer__flyer', 'aria-hidden': 'true',
      style: { ...px(box), 'border-radius': box.radius },
    }, picture.root);
    this.#dialog.append(this.#flyer);
    return picture;
  }

  // Долетели: лента видна, плитка на месте. В слайде фото — та же рамка с тем
  // же, что в полёте, и рамка полёта уходит сразу. У видео постер встаёт
  // нативным элементом: рамка ждёт его (не дольше stillWaitMs) и ещё два кадра,
  // пока он нарисуется, — иначе на месте снимка мигнула бы чернота.
  #landed(slide, still) {
    this.#release();
    stop(this.#shade);
    this.#shade.style.removeProperty('opacity');
    this.#dialog.classList.remove(VIEWER.flying);
    if (!slide.querySelector('.viewer__video')) {
      this.drop();
      return;
    }
    const flyer = this.#flyer;
    const done = () => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (this.#flyer === flyer) this.drop();
    }));
    Promise.race([still.ready, new Promise((resolve) => { setTimeout(resolve, VIEWER.stillWaitMs); })]).then(done);
  }

  #release() {
    this.#origin?.style.removeProperty('visibility');
    this.#origin = null;
  }
}

// Картинка раскодирована и встанет с ближайшим кадром (нет её — сразу).
function painted(image) {
  if (!image?.decode) return Promise.resolve();
  return image.decode().catch(() => undefined);
}

// Плитку видно хоть краем — есть откуда лететь.
function shown(el) {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

// Что показывает плитка: адрес её картинки и пропорция той (квадрат сетки — 1).
function tileImage(tile) {
  const image = tile?.querySelector('img');
  if (!image?.naturalWidth) return null;
  return { src: image.currentSrc || image.src, ratio: image.naturalWidth / image.naturalHeight };
}

// Что стоит в кадре слайда сейчас: фото — пришедшая картинка, видео — постер.
function stillNow(slide, frame) {
  const image = frame.querySelector('.viewer__image');
  if (image?.complete && image.naturalWidth) return image.currentSrc || image.src;
  return slideStill(slide).url;
}

function boxOf(el, radius = '0px') {
  const { left, top, width, height } = el.getBoundingClientRect();
  return { left, top, width, height, radius };
}

function tileBox(tile) {
  return boxOf(tile, getComputedStyle(tile).borderTopLeftRadius);
}

// Кадр слайда — как он стоит (рамку снимка ставит CSS по пропорции); не
// разложен — по полю слайда, как object-fit: contain.
function frameBox(frame, slide, ratio) {
  const box = boxOf(frame);
  return box.width > 0 && box.height > 0 ? box : fit(innerBox(slide), ratio);
}

// Поле слайда без отступов под вырез и полоску «домой».
function innerBox(slide) {
  const r = slide.getBoundingClientRect();
  const s = getComputedStyle(slide);
  const [top, right, bottom, left] = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(parseFloat);
  return { left: r.left + left, top: r.top + top, width: r.width - left - right, height: r.height - top - bottom };
}

function fit(box, ratio) {
  const wide = box.width / box.height > ratio;
  const width = wide ? box.height * ratio : box.width;
  const height = wide ? box.height : box.width / ratio;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height, radius: '0px' };
}

// Снимок во всю рамку (в конце полёта туда и обратно).
function whole(box) {
  return { left: 0, top: 0, width: box.width, height: box.height };
}

// Рамка el относительно рамки box.
function relative(el, box) {
  return { left: el.left - box.left, top: el.top - box.top, width: el.width, height: el.height };
}

function px(box) {
  return { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` };
}

function path(from, to) {
  const value = (v) => `${v}px`;
  const out = {
    left: [value(from.left), value(to.left)],
    top: [value(from.top), value(to.top)],
    width: [value(from.width), value(to.width)],
    height: [value(from.height), value(to.height)],
  };
  if (from.radius !== undefined && to.radius !== undefined) out.borderRadius = [from.radius, to.radius];
  return out;
}
