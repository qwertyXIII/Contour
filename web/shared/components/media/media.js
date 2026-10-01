// Фото и видео вместе: проявление по загрузке, раскладка альбома, лента и
// открытие просмотра. Сам просмотр — другой компонент: блок только сообщает
// media:open со списком того, что показать, и слушает viewer:close — на чём
// закрыли, туда и встать. В media:open идёт и origin(номер) — плитка этого
// номера: из неё просмотр вырастает и в неё возвращается. Сетка для выбора
// (media_pick) просмотра не открывает: сообщает media:pick, решает хозяин.
//
// Плитка бывает не только фото и видео: data-kind (audio, document, link, other)
// и data-title, data-icon, data-duration, data-meta, data-href, data-outside, data-text, data-lang — просмотр покажет
// её своим слайдом. Файл своего сервера просмотр берёт через хозяина сетки
// (`setMediaHooks(корень, { fetch, outside, info, stream? })`): у просмотра нет
// токена; `fetch(item, адрес = item.full)` → Blob; `stream(item)` → ссылка потока
// для видео и звука (иначе — blob).
//
// У фото и видео ещё data-ratio — пропорция снимка как показывается (её знает
// сервер; сама плитка бывает обрезана квадратом) и data-middle — адрес картинки в
// пропорции снимка, крупнее плитки и мельче файла: просмотр встаёт сразу в
// пропорцию и показывает её первой, а файл подменяет её без смены кадра.
//
// Несколько блоков media внутри одной области (data-media-group — лента
// разговора, где у каждой реплики свои вложения) листаются в просмотре одним
// рядом, в порядке страницы; умения просмотра тогда — у области
// (`setMediaHooks(область, …)`), если у самого блока их нет.
import { EVENTS, MEDIA } from '../../utils/constants.js';
import { emit, h, svgIcon } from '../../utils/dom.js';
import { layoutAlbum } from './album.js';
import { Carousel } from './carousel.js';

const VIDEO_ITEM = 'media__item_kind_video';

/** Умения хозяина сетки для просмотра: взять файл, адрес снаружи, «О файле». */
const hooksOf = new WeakMap();

/** Хозяин сетки говорит, как брать его файлы и что показать «о файле». */
export function setMediaHooks(root, hooks) {
  hooksOf.set(root, hooks);
}

export class Media {
  #root;
  #track;
  #items = [];
  #shown = [];
  #carousel = null;

  constructor(root) {
    this.#root = root;
    this.#track = root.querySelector('.media__track');
  }

  init() {
    if (!this.#track) return this;
    this.#items = [...this.#track.querySelectorAll('.media__item')];
    this.#items.forEach((item) => this.#watchLoad(item));
    this.#track.addEventListener('click', (event) => {
      const item = event.target.closest('.media__item');
      if (!item || item.disabled) return;
      // Плитки меняет хозяин (поиск, отбор, «показать ещё») — берём те, что сейчас.
      this.#items = [...this.#track.querySelectorAll('.media__item')];
      // Сетка для выбора («какое фото поставить»): решает хозяин, просмотра нет.
      if (this.#root.classList.contains(MEDIA.pick)) emit(this.#root, EVENTS.mediaPick, { value: item.dataset.value });
      else this.#open(item);
    });
    this.#root.addEventListener(EVENTS.viewerClose, (event) => this.#returned(event.detail.index));
    if (this.#root.classList.contains(MEDIA.album)) this.#album();
    if (this.#root.classList.contains(MEDIA.carousel)) {
      this.#carousel = new Carousel(this.#root, this.#track, this.#items).mount();
    }
    this.#root.classList.add(MEDIA.enhanced);
    return this;
  }

  #watchLoad(item) {
    const image = item.querySelector('.media__image');
    if (!image || (image.complete && image.naturalWidth)) return;
    if (image.complete) {
      this.#broken(item);
      return;
    }
    item.classList.add(MEDIA.loading);
    image.addEventListener('load', () => item.classList.remove(MEDIA.loading), { once: true });
    image.addEventListener('error', () => this.#broken(item), { once: true });
  }

  // Не пришло — плитка остаётся на месте со значком и не открывается.
  #broken(item) {
    item.classList.remove(MEDIA.loading);
    item.classList.add(MEDIA.broken);
    item.disabled = true;
    item.append(svgIcon(MEDIA.brokenIcon));
    item.dataset.alt ??= item.getAttribute('aria-label') ?? '';
    item.setAttribute('aria-label', `${item.getAttribute('aria-label') ?? ''}${MEDIA.labels.broken}`);
  }

  // Альбом показывает не больше data-max плиток; на последней — «+N».
  #album() {
    const max = Number(this.#root.dataset.max) || MEDIA.albumMax;
    const visible = this.#items.slice(0, max);
    const rest = this.#items.length - visible.length;
    if (rest > 0) {
      this.#items.slice(max).forEach((item) => { item.hidden = true; });
      const last = visible.at(-1);
      last.append(h('span', { class: 'media__more', 'aria-hidden': 'true', text: MEDIA.labels.more(rest) }));
      last.dataset.alt ??= last.getAttribute('aria-label') ?? '';
      last.setAttribute('aria-label', `${last.getAttribute('aria-label') ?? ''}${MEDIA.labels.moreSay(rest)}`);
    }
    const relayout = () => this.#layout(visible);
    visible.forEach((item) => {
      if (!ratioOf(item)) item.querySelector('.media__image')?.addEventListener('load', relayout, { once: true });
    });
    new ResizeObserver(relayout).observe(this.#track);
  }

  #layout(items) {
    const width = this.#track.clientWidth;
    if (!width) return;
    const gap = parseFloat(getComputedStyle(this.#track).columnGap) || 0;
    const ratios = items.map((item) => ratioOf(item) || 1);
    layoutAlbum(ratios, { width, gap, ...MEDIA.layout }).forEach(({ share, rowGaps, fit }, i) => {
      items[i].style.setProperty('--share', share.toFixed(5));
      items[i].style.setProperty('--row-gaps', String(rowGaps));
      items[i].style.setProperty('--fit', fit.toFixed(4));
    });
  }

  #open(item) {
    const group = this.#root.closest(MEDIA.group);
    const pool = group ? [...group.querySelectorAll('.media__item')] : this.#items;
    this.#shown = pool.filter((el) => !el.disabled);
    const index = this.#shown.indexOf(item);
    const hooks = hooksOf.get(this.#root) ?? (group && hooksOf.get(group)) ?? {};
    const items = this.#shown.map(describe);
    emit(this.#root, EVENTS.mediaOpen, {
      items, index, origin: (i) => this.#originOf(i),
      fetch: hooks.fetch ?? null,
      outside: hooks.outside ?? null,
      stream: hooks.stream ?? null,
      info: hooks.info ? (i) => hooks.info(items[i]) : null,
    });
  }

  // Плитка номера index: лента сразу встаёт на неё; спрятанная в альбоме — это «+N».
  // В области (data-media-group) плитка бывает и чужого блока — тогда без ленты.
  #originOf(index) {
    const item = this.#shown[index];
    if (!item) return null;
    const own = this.#items.indexOf(item);
    if (own >= 0) this.#carousel?.go(own, { instant: true });
    if (!item.hidden) return item;
    return [...item.parentElement.children].filter((el) => el.matches('.media__item') && !el.hidden).at(-1) ?? null;
  }

  // Закрыли просмотр на другой плитке — фокус переходит к ней.
  #returned(index) {
    this.#originOf(index)?.focus({ preventScroll: Boolean(this.#carousel) });
  }
}

// Пропорция снимка: data-ratio (её знает сервер, плитка может быть обрезана), иначе
// --ratio (раскладка плитки), иначе — из пришедшей картинки.
function ratioOf(item) {
  const told = Number(item.dataset.ratio);
  if (told > 0) return told;
  const declared = parseFloat(getComputedStyle(item).getPropertyValue('--ratio'));
  if (declared > 0) return declared;
  const image = item.querySelector('.media__image');
  return image?.naturalWidth ? image.naturalWidth / image.naturalHeight : 0;
}

// Что показать в просмотре: крупный файл, а пока он идёт — то, что уже есть на плитке.
function describe(item) {
  const image = item.querySelector('.media__image');
  const preview = image?.currentSrc || image?.src || '';
  const video = item.classList.contains(VIDEO_ITEM);
  const { dataset } = item;
  return {
    id: dataset.value ?? '',
    kind: dataset.kind || (video ? 'video' : 'image'),
    // Адрес файла своего сервера — его берёт хозяин (fetch); без хозяина — как раньше.
    full: dataset.fullSrc || '',
    title: dataset.title ?? '',
    icon: dataset.icon ?? '',
    duration: Number(dataset.duration) || 0,
    meta: dataset.meta ?? '',
    href: dataset.href || '',
    outside: dataset.outside || '',
    // Прочитать в просмотре: plain · markdown · code (+ язык).
    text: dataset.text || '',
    lang: dataset.lang || '',
    src: video ? dataset.src : dataset.full || preview,
    preview,
    // Пропорция того, что на плитке (квадрат сетки — 1): просмотр кладёт её на своё место в кадре снимка.
    previewRatio: image?.naturalWidth ? image.naturalWidth / image.naturalHeight : 0,
    // Картинка в пропорции снимка — первой в просмотре (адрес; своего сервера берёт хозяин).
    middle: dataset.middle || '',
    // Подпись плитки могла получить хвост («, и ещё 7») — в просмотр идёт исходная.
    alt: image?.alt || item.dataset.alt || item.getAttribute('aria-label') || '',
    caption: item.dataset.caption ?? '',
    credit: item.dataset.credit ?? '',
    ratio: ratioOf(item) || 0,
  };
}
