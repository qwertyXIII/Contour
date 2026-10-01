// Превью файла в полосе над строкой ввода: фото — картинкой из самого файла (адрес
// объекта, без закачки), видео — кадром и длительностью (кадр не пришёл — значок),
// остальное — плашкой: значок, имя, размер. Здесь же — размер словами.
//
// Разметка одна для всех видов — меняется только содержимое __preview:
//   li.composer__attachment.composer__attachment_kind_{photo|video|file}
//     span.thumb.composer__preview › svg.composer__type · img|video.composer__image ·
//                                   span.composer__duration · button.composer__retry
//     span.composer__about › __name + __meta (› __state «Не ушло · »)   ← только файлу
//     div.progress.composer__progress › progress__bar
//     button.composer__remove
import { ATTACH } from '../../utils/constants.js';
import { h, svgIcon } from '../../utils/dom.js';
import { formatTime } from '../../utils/time.js';

// Картинка не открылась — блок thumb прячет её, остаётся значок.
const BROKEN = 'thumb_broken';
const SIZE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ'];
const SIZE_STEP = 1024;
// Меньше десяти — с одним знаком после запятой: «2,4 МБ», дальше — целыми: «340 КБ».
const SIZE_FRACTION_BELOW = 10;

/** Размер файла для глаз: 12 Б · 340 КБ · 2,4 МБ. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= SIZE_STEP && unit < SIZE_UNITS.length - 1) {
    value /= SIZE_STEP;
    unit += 1;
  }
  const digits = unit > 0 && value < SIZE_FRACTION_BELOW ? 1 : 0;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value)} ${SIZE_UNITS[unit]}`;
}

/** Вид превью по типу файла: photo | video | file. */
export function kindOf(file) {
  const type = file?.type ?? '';
  if (type.startsWith('image/')) return 'photo';
  if (type.startsWith('video/')) return 'video';
  return 'file';
}

function fileIcon(type = '') {
  if (type.startsWith('audio/')) return ATTACH.icons.audio;
  if (type.startsWith('text/') || type === 'application/pdf') return ATTACH.icons.text;
  return ATTACH.icons.file;
}

function button(className, label, icon) {
  return h('button', { class: className, type: 'button', 'aria-label': label }, svgIcon(icon));
}

function progress(name) {
  // div, не span: progress__bar берёт ширину долей, а строчному элементу ширина не задаётся.
  return h('div', {
    class: 'progress progress_size_s composer__progress', role: 'progressbar', 'aria-label': ATTACH.text.progress(name),
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', style: { '--progress': '0' },
  }, h('div', { class: 'progress__bar' }));
}

function about(name, size) {
  return h('span', { class: 'composer__about' },
    h('span', { class: 'composer__name', text: name }),
    h('span', { class: 'composer__meta' },
      h('span', { class: 'composer__state', text: `${ATTACH.text.failed} · ` }), formatSize(size)));
}

// Картинка не открылась (HEIC в Chrome, битый файл) — остаётся значок под ней.
function photo(url, name, preview) {
  return h('img', {
    class: 'thumb__image composer__image', src: url, alt: name, decoding: 'async',
    on: { error: () => preview.classList.add(BROKEN) },
  });
}

// Кадр — после перемотки чуть от начала; длительность — по метаданным. На iPhone
// без жеста кадр может не прийти вовсе: тогда остаются значок и длительность.
function video(url, name) {
  const time = h('span', { class: 'composer__duration', 'aria-hidden': 'true' });
  const say = h('span', { class: 'visually-hidden', text: ATTACH.text.video(name) });
  const el = h('video', {
    class: `thumb__image composer__image ${ATTACH.imageLoading}`, muted: true, playsinline: true,
    preload: 'metadata', disablepictureinpicture: true, tabindex: '-1', 'aria-hidden': 'true',
  });
  el.muted = true;
  el.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(el.duration)) {
      time.textContent = formatTime(el.duration);
      say.textContent = ATTACH.text.video(name, time.textContent);
    }
    try { el.currentTime = Math.min(ATTACH.frameAt, (el.duration || 0) / 2); } catch {}
  }, { once: true });
  const shown = () => el.classList.remove(ATTACH.imageLoading);
  el.addEventListener('seeked', shown, { once: true });
  el.addEventListener('loadeddata', shown, { once: true });
  el.src = url;
  return [el, time, say];
}

/**
 * Превью выбранного файла — закачивается (ATTACH.uploading). Адрес объекта (`url`,
 * у фото и видео) отпускает тот, кто превью убирает.
 * @returns {{ el: HTMLLIElement, url: string | null, kind: string, name: string }}
 */
export function buildPreview(key, file) {
  const kind = kindOf(file);
  const name = file.name;
  const url = kind === 'file' ? null : URL.createObjectURL(file);
  const preview = h('span', { class: 'thumb composer__preview' },
    svgIcon(kind === 'file' ? fileIcon(file.type) : ATTACH.icons[kind], 'composer__type'));
  if (kind === 'photo') preview.append(photo(url, name, preview));
  if (kind === 'video') preview.append(...video(url, name));
  preview.append(button('composer__retry', ATTACH.text.retry(name), ATTACH.icons.retry));
  const el = h('li', { class: `composer__attachment ${ATTACH.kind(kind)} ${ATTACH.uploading}`, dataset: { key, name } },
    preview,
    kind === 'file' && about(name, file.size),
    progress(name),
    button('composer__remove', ATTACH.text.remove(name), ATTACH.icons.remove));
  return { el, url, kind, name };
}
