// Высота подвала панели разговора (sheet_layered): над строкой ввода бывает полоса
// файлов, и подвал растёт вверх. CSS берёт высоту из --sheet-foot-h — на столько же
// поднимается низ ленты (последняя реплика не уходит под полосу) и дальше уходит
// спрятанный подвал (свёрнутая панель, голос). Пишется на корень только при
// перемене: это наследуемая переменная, пересчёт ленты — раз на перемену, не на кадр.
// Лента едет вместе с верхом подвала, как в «Сообщениях»: что было у поля, у поля и
// остаётся.
const FOOT_VAR = '--sheet-foot-h';

/** Подвал, за которым уже следят: части панели ставят позже, замер зовёт это не раз. */
const watched = new WeakSet();

export function watchFoot(root) {
  const foot = root.querySelector(':scope > .sheet__foot');
  if (!foot || watched.has(foot) || typeof ResizeObserver !== 'function') return;
  watched.add(foot);
  let last = 0;
  new ResizeObserver(() => {
    const height = Math.round(foot.offsetHeight);
    // Спрятанная панель (до привязки) — нулевая: прежняя высота остаётся.
    if (!height || height === last) return;
    const grew = last ? height - last : 0;
    last = height;
    root.style.setProperty(FOOT_VAR, `${height}px`);
    const body = root.querySelector(':scope > .sheet__body');
    if (grew && body) body.scrollTop += grew;
  }).observe(foot);
}
