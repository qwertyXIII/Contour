// Слайды просмотра: разметка из описания, которое прислал блок media. Крупный
// файл грузится, только когда слайд рядом с текущим.
//
// Вид слайда — от вида файла (item.kind): фото и видео во весь экран, звук —
// волна и «слушать» (sound.js), текст — прочитать, прочее (документ, ссылка) —
// значок, название и «Открыть». Файл своего сервера берёт хозяин просмотра
// (`fetch(item)` → Blob — с токеном, которого просмотр не знает); без хозяина —
// по адресу, как раньше. «Открыть» документ — адрес снаружи от хозяина
// (`outside(item)` → Promise<url>): у системного просмотра iOS нашего токена нет.
// Видео и звук — по ссылке потока от хозяина (`stream(item)` → Promise<url|null>),
// если она есть: браузер берёт файл кусками сам, и видео на сотни мегабайт не
// ложится целиком в память телефона; нет ссылки — blob, как раньше.
//
// Фото и видео встают сразу в пропорции снимка (item.ratio — её знает плитка,
// даже обрезанная квадратом): кадр не прыгает, когда приходит файл. Первым идёт
// превью в пропорции (item.middle — адрес; своего сервера — через хозяина:
// `fetch(item, адрес)`), следом файл; у видео превью — постер.
import { VIEWER } from '../../utils/constants.js';
import { h, svgIcon } from '../../utils/dom.js';
import { buildPicture, differs, loaded } from './picture.js';
import { soundSlide } from './sound.js';

// Разметка и подсветка — по требованию: большинство слайдов — фото.
const markdown = () => import('../markdown/markdown.js');
const highlight = () => import('../code/highlight.js');

/** Слайд без картинки: адрес ставится позже, в load(). */
export function buildSlide(item, index, total) {
  return h('div', {
    class: 'viewer__slide',
    role: 'group',
    'aria-roledescription': VIEWER.slideRole,
    'aria-label': VIEWER.say(index + 1, total, item.alt),
  });
}

/**
 * Кадр слайда в пропорции снимка — полёту (flight.js): { url, ready } — адрес
 * картинки, которая уже стоит в кадре (превью или файл; у видео — постер), и
 * обещание первой такой (null — не пришла). Слайд без фото и видео — сразу null.
 */
export function slideStill(slide) {
  return stills.get(slide) ?? NO_STILL;
}

const stills = new WeakMap();
const NO_STILL = Object.freeze({ url: null, ready: Promise.resolve(null) });

function newStill(slide) {
  const still = { url: null };
  still.ready = new Promise((resolve) => {
    still.settle = (url) => {
      if (url && !still.url) still.url = url;
      resolve(still.url);
    };
  });
  stills.set(slide, still);
  return still;
}

/**
 * Наполнить слайд, если он ещё пуст. `hooks` — { fetch?(item, адрес = item.full) → Promise<Blob>,
 * outside?(item) → Promise<url>, stream?(item) → Promise<url|null>, keep(url) → url }:
 * `keep` запоминает локальный адрес, чтобы отпустить его на закрытии.
 */
export function loadSlide(slide, item, hooks) {
  if (slide.firstChild) return;
  const own = (address) => hooks.fetch(item, address).then((blob) => hooks.keep(URL.createObjectURL(blob)));
  const blobUrl = () => own(item.full);
  // Превью в пропорции: своего сервера — через хозяина, без хозяина — адресом как есть.
  const middle = !item.middle ? null : hooks.fetch ? () => own(item.middle) : () => Promise.resolve(item.middle);
  // Ссылка потока не вышла (нет её у плитки, сервер отказал) — файл целиком, как раньше.
  const stream = hooks.stream ? () => hooks.stream(item).catch(() => null) : null;
  const playable = () => (stream ? stream() : Promise.resolve(null)).then((url) => url || blobUrl());
  const kind = item.kind ?? 'image';
  if (kind === 'audio' && hooks.fetch && item.full) soundSlide(slide, item, { blob: () => hooks.fetch(item), stream }, hooks.keep);
  else if (kind === 'video') videoSlide(slide, item, { full: hooks.fetch && item.full ? playable : null, middle });
  else if (kind === 'image') imageSlide(slide, item, { full: hooks.fetch && item.full ? blobUrl : null, middle });
  else if (item.text && hooks.fetch && item.full) textSlide(slide, item, () => hooks.fetch(item));
  else fileSlide(slide, item, hooks.outside && item.outside ? () => hooks.outside(item) : null);
}

/** Что крупнее: превью в пропорции подменяет плитку, файл — превью. */
const RANK = { tile: 0, middle: 1, full: 2 };

// Фото: кадр в пропорции снимка; в нём — то, что уже было на плитке, на своём
// месте, поверх — превью в пропорции, потом крупное. Ничего не пришло и брать
// нечего (просмотр без хозяина) — картинка плитки и есть фото, как раньше.
function imageSlide(slide, item, { full, middle }) {
  const still = newStill(slide);
  const spinner = h('span', { class: 'spinner spinner_size_l viewer__spinner', 'aria-hidden': 'true' });
  const image = h('img', { class: 'viewer__image', alt: item.alt, decoding: 'async', draggable: 'false' });
  const tile = item.preview || item.src;
  const picture = buildPicture(item.ratio, tile ? { src: tile, ratio: item.previewRatio } : null, image);
  slide.append(picture.root);
  const shown = (url) => (ok) => {
    if (ok) still.settle(url);
  };
  const loads = [
    middle?.().then((url) => picture.show(url, RANK.middle).then(shown(url))),
    full?.().then((url) => picture.show(url, RANK.full).then(shown(url))),
  ].filter(Boolean);
  if (loads.length === 0 && tile) loads.push(picture.show(tile, RANK.tile).then(shown(tile)));
  if (loads.length === 0) {
    still.settle(null);
    return;
  }
  // Крутилка — пока идёт то, чего на плитке не было.
  if (middle || full) slide.append(spinner);
  // Не пришло ничего — кадр остаётся с плиткой, полёт не ждёт.
  Promise.allSettled(loads).then(() => {
    spinner.remove();
    still.settle(null);
  });
}

// Разметка блока video: нативный элемент с controls — компонент Video оживит
// его, как только слайд окажется в документе (utils/upgrade.js). Кадр — сразу в
// пропорции снимка; постер — превью в пропорции, когда пришло (до него — тёмный
// кадр нужной формы, а не квадрат плитки, растянутый поперёк).
function videoSlide(slide, item, { full, middle }) {
  const still = newStill(slide);
  const ratio = item.ratio || item.previewRatio || 0;
  const video = h('video', {
    class: 'video__native',
    src: full ? null : item.src,
    poster: middle ? null : item.preview || null,
    preload: 'metadata',
    playsinline: true,
    controls: true,
    'aria-label': item.alt,
  });
  const box = h('div', {
    class: 'video viewer__video',
    style: ratio ? { '--ratio': String(ratio) } : null,
  }, video);
  slide.append(box);
  // Пропорции не знали (или знали неверно) — по самому видео.
  video.addEventListener('loadedmetadata', () => {
    const natural = video.videoWidth / video.videoHeight;
    if (natural > 0 && differs(natural, ratio)) box.style.setProperty('--ratio', String(natural));
  }, { once: true });
  if (middle) {
    middle()
      .then((url) => loaded(url).then(() => {
        video.poster = url;
        still.settle(url);
      }))
      .catch(() => {
        video.poster = item.preview || '';
        still.settle(null);
      });
  } else {
    still.settle(item.preview || null);
  }
  full?.().then((url) => { video.src = url; }).catch(() => slide.classList.add(VIEWER.broken));
}

// Текст — прочитать прямо здесь: своя прокрутка, смахивание её не перехватывает.
// Markdown — разметкой (блок prose), код — с подсветкой, прочее — как есть.
function textSlide(slide, item, fetchBlob) {
  const body = h('div', { class: 'viewer__text-body' }, h('span', { class: 'spinner spinner_size_l', 'aria-hidden': 'true' }));
  slide.append(h('article', { class: `viewer__text viewer__text_as_${item.text}`, 'data-viewer-scroll': '' },
    h('h2', { class: 'viewer__name' }, item.title || ''),
    body));
  fetchBlob()
    .then((blob) => blob.text())
    .then(async (text) => {
      if (item.text === 'markdown') {
        const { renderMarkdown } = await markdown();
        body.replaceChildren();
        await renderMarkdown(body, text);
        return;
      }
      if (item.text === 'code') {
        const code = h('code', { class: 'code code_block' }, text);
        body.replaceChildren(h('pre', { class: 'viewer__code' }, code));
        const { highlightElement } = await highlight();
        await highlightElement(code, item.lang);
        return;
      }
      body.replaceChildren(text);
    })
    .catch(() => body.replaceChildren(VIEWER.labels.failed));
}

// Документ, ссылка, прочее: значок, название, что это — и «Открыть» снаружи.
function fileSlide(slide, item, outside) {
  const open = h('button', { class: 'button button_view_primary viewer__open', type: 'button' },
    svgIcon(item.href ? 'external' : 'file', 'button__icon'), item.href ? VIEWER.labels.openLink : VIEWER.labels.open);
  open.hidden = !item.href && !outside;
  open.addEventListener('click', () => {
    if (item.href) {
      window.open(item.href, '_blank', 'noopener');
      return;
    }
    // Окно — в том же касании: иначе iOS сочтёт его непрошеным и не откроет.
    const win = window.open('', '_blank');
    outside().then((url) => {
      if (win) win.location.href = url;
      else window.location.href = url;
    }).catch(() => win?.close());
  });
  slide.append(h('div', { class: 'viewer__file' },
    h('span', { class: 'viewer__glyph viewer__glyph_size_l' }, svgIcon(item.icon || 'file')),
    h('p', { class: 'viewer__name' }, item.title || ''),
    item.meta ? h('p', { class: 'viewer__meta' }, item.meta) : null,
    open));
}

/** Уходим со слайда — видео и звук на нём замолкают. */
export function quietSlide(slide) {
  slide?.querySelectorAll('video, audio').forEach((media) => media.pause());
}
