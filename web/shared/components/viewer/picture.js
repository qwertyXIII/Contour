// Кадр снимка в просмотре и в полёте (viewer__picture): рамка в пропорции
// снимка, в ней — то, что уже было на плитке, на своём месте (viewer__thumb), а
// поверх — картинка в пропорции снимка, когда пришла (viewer__image).
//
// Плитка показывает обрезку снимка по центру: квадрат сетки, клетка мозаики.
// Растянуть её на весь кадр — значит показать не то; поэтому она лежит там, где
// эта часть снимка и есть, а края дорисовывает пришедшая картинка — без сдвига.
// Так же устроен полёт из плитки (flight.js): та же рамка, только её размер и
// место ведёт пружина.
import { VIEWER } from '../../utils/constants.js';
import { h } from '../../utils/dom.js';

const percent = (share) => `${(share * 100).toFixed(3)}%`;

/**
 * Какую долю снимка (ratio — ширина / высота) занимает его обрезка по центру
 * пропорции crop: [доля ширины, доля высоты]. Шире снимка — во всю ширину,
 * уже — во всю высоту.
 */
export function cropShare(crop, ratio) {
  return crop >= ratio ? [1, ratio / crop] : [crop / ratio, 1];
}

/**
 * Где снимок, если показать плитку box так, как её показывает блок media:
 * картинка пропорции crop (обрезка снимка по центру) — object-fit: cover по
 * центру. Ответ — рамка снимка относительно плитки: { left, top, width, height }.
 */
export function tileLayout(box, crop, ratio) {
  const width = Math.max(box.width, box.height * crop);
  const height = width / crop;
  const [shareX, shareY] = cropShare(crop, ratio);
  const whole = { width: width / shareX, height: height / shareY };
  return { left: (box.width - whole.width) / 2, top: (box.height - whole.height) / 2, ...whole };
}

/** Картинка целиком в памяти — встанет на место без мигания: обещание её самой. */
export function loaded(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

/** Пропорции заметно разные — кадр надо переставить (размеры, округлённые сервером, — не повод). */
export function differs(a, b) {
  return !(a > 0 && b > 0) || Math.abs(a / b - 1) > VIEWER.ratioSlack;
}

/**
 * Рамка снимка: { root, image, thumb, fit(ratio), show(url, rank) → Promise<boolean> }.
 * `tile` — { src, ratio } того, что на плитке (или null); `image` — <img>
 * картинки поверх (у неё и подпись для чтения с экрана). `fit` — переставить
 * рамку под другую пропорцию (её не знали), `show` — поставить картинку, когда
 * она пришла; рамка отмечается готовой (__picture_ready), когда та нарисована.
 */
export function buildPicture(ratio, tile, image) {
  const root = h('div', { class: 'viewer__picture' });
  const thumb = tile?.src
    ? h('img', { class: 'viewer__thumb', src: tile.src, alt: '', 'aria-hidden': 'true', decoding: 'async', draggable: 'false' })
    : null;
  root.append(...[thumb, image].filter(Boolean));
  let current = 0;
  const fit = (next) => {
    current = next;
    root.style.setProperty('--ratio', String(next));
    if (!thumb) return;
    const [width, height] = cropShare(tile.ratio || next, next);
    thumb.style.width = percent(width);
    thumb.style.height = percent(height);
  };
  fit(ratio || tile?.ratio || 1);
  // Сначала целиком в памяти, потом на место: прежняя картинка не мигает пустотой.
  // `rank` — что крупнее (превью 1, файл 2): пришедшее позже мельче не подменит.
  let best = -1;
  const show = async (url, rank = 0) => {
    const next = await loaded(url).catch(() => null);
    if (!next || rank < best) return false;
    best = rank;
    // Пропорции не знали (или знали неверно) — по самой картинке.
    const natural = next.naturalWidth / next.naturalHeight;
    if (differs(natural, current)) fit(natural);
    image.src = url;
    await image.decode?.().catch(() => undefined);
    root.classList.add(VIEWER.ready);
    return true;
  };
  return { root, image, thumb, fit, show, ratio: () => current };
}
