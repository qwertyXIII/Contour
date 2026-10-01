// Фото, видео и просмотр во весь экран: модификаторы, пределы раскладки, подписи.

export const MEDIA = {
  enhanced: 'media_enhanced',
  album: 'media_view_album',
  carousel: 'media_view_carousel',
  // Сетка для выбора: нажатие выбирает, а не открывает просмотр.
  pick: 'media_pick',
  // Область, где блоки media листаются в просмотре одним рядом (лента разговора).
  group: '[data-media-group]',
  loading: 'media__item_loading',
  broken: 'media__item_broken',
  dotCurrent: 'media__dot_current',
  // Альбом: плиток в строке не больше maxPerRow; желаемая высота строки — доля
  // ширины; пропорции плиток зажаты, чтобы панорама не стала полоской, а
  // портрет — столбом (одиночной строке портрет нужен ещё шире).
  layout: { maxPerRow: 4, targetShare: 0.46, minRatio: 0.62, maxRatio: 2.4, singleMin: 0.8 },
  // Сколько плиток показывает альбом, если в разметке не сказано data-max.
  albumMax: 10,
  // Точек у ленты не больше — дальше остаётся только счётчик.
  dotsMax: 12,
  brokenIcon: 'image',
  labels: {
    prev: 'Назад',
    next: 'Дальше',
    more: (count) => `+${count}`,
    moreSay: (count) => `, и ещё ${count}`,
    broken: ' — не загрузилось',
  },
  counter: (index, total) => `${index} / ${total}`,
};

// Вложения реплики — в ленте разговора (message__media) и в переписке (bubble__media).
export const MESSAGE_MEDIA = {
  // Фото и видео — мозаикой (media_view_mosaic): шаблон на каждое число плиток от 1
  // до max (media_tiles_N), полный прямоугольник без пустых клеток. Больше max в одной
  // реплике бывает (Alter показал много за ход) — тогда мозаики по chunk, остаток —
  // своей: он всегда от 2, одиночки в конце не бывает.
  mosaic: {
    view: 'media_view_mosaic',
    tiles: (count) => `media_tiles_${count}`,
    max: 10,
    chunk: 9,
    // Шаблоны, где первая плитка крупная (вровень с media_view_mosaic.css): ей —
    // превью в пропорции, мелким — квадрат. Одна — тоже крупная.
    lead: new Set([1, 3, 5, 7, 8, 10]),
  },
  // Своё видео до ответа сервера — кадром из файла: сторона не больше (px, хватает
  // плитке 340 css px на DPR 2), качество JPEG и сколько ждать кадр (iPhone без жеста
  // его может не дать вовсе — тогда значок).
  frameSide: 720,
  frameQuality: 0.82,
  frameWaitMs: 4000,
};

export const VIEWER = {
  // Смахнуть вниз дальше этого (px) — закрыть; меньше — вернуть на место.
  closeAt: 96,
  // Сколько пути смахивания гасит подложку целиком.
  fadeAt: 320,
  // Меньше этого сдвига (px) — касание, а не жест: показать или спрятать рамку.
  tapSlop: 8,
  bare: 'viewer_bare',
  pulling: 'viewer_pulling',
  // Фото летит между плиткой и просмотром: лента и рамка спрятаны.
  flying: 'viewer_flying',
  // Открыт не полётом — проявляется сам (у открытого полётом своего появления нет).
  appearing: 'viewer_appearing',
  // Потянули вверх дальше этого (px) — открыть «О файле»; меньше — на место.
  infoAt: 64,
  // Вверх лента идёт туже, чем вниз: это приглашение, а не бросок.
  upResistance: .5,
  // На какую долю высоты приподнимается просмотр, пока открыт «О файле».
  liftShare: .22,
  lifted: 'viewer_lifted',
  broken: 'viewer__slide_broken',
  // Кадр снимка: картинка в пропорции снимка пришла и нарисована (под ней — плитка).
  ready: 'viewer__picture_ready',
  // Пропорции отличаются меньше этой доли — тот же кадр (размеры округлены сервером).
  ratioSlack: 0.02,
  // Сколько рамка полёта ждёт постер видео, прежде чем отдать место кадру слайда (мс).
  stillWaitMs: 1500,
  label: 'Просмотр',
  slideRole: 'слайд',
  labels: {
    close: 'Закрыть', prev: 'Предыдущее', next: 'Следующее', info: 'О файле',
    play: 'Слушать', pause: 'Пауза', seek: 'Перемотка', open: 'Открыть', openLink: 'Открыть ссылку',
    failed: 'Не загрузилось',
  },
  counter: (index, total) => `${index} / ${total}`,
  say: (index, total, alt) => `${index} из ${total}${alt ? `: ${alt}` : ''}`,
};

export const VIDEO = {
  // Через сколько без движения прячутся элементы управления во время показа.
  idleMs: 2500,
  // Шаг перемотки стрелками и сколько секунд — «конец»: дальше повтор с начала.
  skipSec: 5,
  enhanced: 'video_enhanced',
  started: 'video_started',
  playing: 'video_playing',
  waiting: 'video_waiting',
  ended: 'video_ended',
  error: 'video_error',
  idle: 'video_idle',
  muted: 'video_muted',
  fullscreen: 'video_fullscreen',
  icons: { play: 'play', pause: 'pause', replay: 'repeat', sound: 'volume', mute: 'volume-off', enter: 'expand', exit: 'collapse' },
  labels: {
    play: 'Играть',
    pause: 'Пауза',
    replay: 'Сначала',
    mute: 'Выключить звук',
    unmute: 'Включить звук',
    enter: 'Во весь экран',
    exit: 'Свернуть',
    seek: 'Перемотка',
    error: 'Видео не загрузилось',
  },
};

// Музыка: сеанс (кто играет) и его виды (кто показывает) говорят событиями
// player:state и player:command; сеанс узнают по data-session.
export const PLAYER = {
  // «Назад» в первые секунды трека — предыдущий; позже — к началу текущего.
  restartAfterSec: 3,
  repeat: ['off', 'all', 'one'],
  playing: 'player_playing',
  idle: 'player_idle',
  nowPaused: 'player__now_paused',
  icons: { play: 'play', pause: 'pause', sound: 'volume', mute: 'volume-off', now: 'equalizer' },
  // Разбор звука сеанса для кольца (components/player/tap.js): полосы от низких
  // к высоким по логарифму; высокие тише — подтягиваются наклоном.
  tap: { fftSize: 2048, smoothing: 0.62, lowHz: 40, highHz: 14000, curve: 1.4, tilt: 0.9 },
  labels: {
    play: 'Играть',
    pause: 'Пауза',
    seek: 'Перемотка',
    volume: 'Громкость',
    mute: 'Выключить звук',
    unmute: 'Включить звук',
    shuffle: 'Перемешать',
    repeat: { off: 'Повтор выключен', all: 'Повторять очередь', one: 'Повторять трек' },
    upNext: (title) => `Дальше: ${title}`,
    nothing: 'Ничего не играет',
    track: (title, artist) => (artist ? `${title} — ${artist}` : title),
  },
};

// Голосовое в ленте (блок voice-note, ADR-0072 Alter'а): ▶, волна, время.
export const VOICE_NOTE = {
  // Полосок в волне: столько помещается рядом с кнопкой и временем в узкой колонке.
  bars: 32,
  labels: { play: 'Слушать голосовое', pause: 'Пауза', seek: 'Перемотка', failed: 'Не загрузилось' },
};
