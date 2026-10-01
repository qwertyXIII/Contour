// Общие числа и адреса компонентов.

// Спрайт значков. Адрес считается от этого файла, а не от страницы: значки,
// созданные из JS, работают на любой странице, куда подключена система.
export const ICON_SPRITE = new URL('../../assets/icons/sprite.svg', import.meta.url).href;

// Значки с движением: режимы блока icon и кто запускает значок.
export const ICON_MOTION = {
  hover: 'icon_motion_hover',
  hold: 'icon_motion_hold',
  loop: 'icon_motion_loop',
  once: 'icon_motion_once',
  playing: 'icon_playing',
  // Какие значки оживляет компонент при запуске страницы.
  selector: '.icon_motion_hover, .icon_motion_hold, .icon_motion_loop, .icon_motion_once',
  // Наводят и нажимают на хозяина, оживает значок внутри него.
  host: 'a, button, label, summary, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [data-motion-host]',
  // Какая доля значка должна показаться, чтобы once сыграл.
  seenThreshold: 0.6,
};

export const TOAST = {
  durationMs: 4200,
  leaveMs: 180,
  max: 3,
};

// Всплывающая панель (блок popup): отступы от якоря и края окна, пределы размера.
export const POPUP = {
  gap: 6,
  margin: 8,
  minWidth: 180,
  minHeight: 160,
  maxHeight: 360,
  // Меньше этого места снизу — открываемся вверх, если сверху его больше.
  flipBelow: 240,
};

// Медиазапросы, которые читает JS. Должны совпадать с CSS.
export const QUERIES = {
  coarse: '(pointer: coarse)',
  hover: '(hover: hover)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
};

// Список select: подписи и поиск по первым буквам.
export const SELECT = {
  searchPlaceholder: 'Найти',
  emptyText: 'Ничего не нашлось',
  placeholder: 'Выбери',
  typeaheadResetMs: 700,
};

// Строка ввода: composer_hold — не очищать поле по отправке, хозяин очистит сам
// (composer:clear), когда реплика ушла: не ушла — текст остаётся в поле.
// Лента на пружинках (messages_springy) — модель «Сообщений» iPhone: каждая реплика
// на своей пружине, привязанной к её месту (UIAttachmentBehavior: длина 0, частота
// 1 Гц, затухание 0.8); листают — реплика сдвигается вслед за прокруткой на долю,
// равную её расстоянию от пальца, делённому на resistance (px), — ровно, без
// насыщения: лента тянется, как резина, а не едет куском. max — предохранитель (px);
// rest — ближе этого (px) реплика стоит; activeMs — сколько после касания считать прокрутку живой (инерция), а не
// программной (лента довела себя до конца — не пружинить).
// Первая попытка (насыщение на 380 px, пружина 2 Гц) была «не как на айфоне» (владелец);
// 1500 px — «раза в 1.5 легче» (владелец, 2026-10-01): 2250.
export const MESSAGES = {
  springy: { resistance: 2250, frequency: 1, dampingRatio: 0.8, max: 240, rest: 0.2, activeMs: 2600 },
};

export const COMPOSER = {
  hold: 'composer_hold',
  // Пишет голосовое (ADR-0072 Alter'а): поле — полоса записи, «Отправить» шлёт звук.
  recording: 'composer_recording',
  // Смахнуть полосу записи влево дальше этого (px) — бросить запись.
  cancelSwipe: 72,
};

// Файлы к реплике: скрепка в поле строки ввода, превью полосой над ним. Не больше
// maxFiles за раз и не больше maxBytes каждый — столько же принимает сервер
// (POST /api/chat/upload отвечает 413 на большее); сверх — отказ словами сразу, без
// закачки. Закачивает хозяин (components/composer/uploads.js), строка рисует ход.
// waiting — «Отправить» нажали, пока закачка идёт: реплика уйдёт, как только всё закачается.
export const ATTACH = {
  maxFiles: 10,
  maxBytes: 500 * 1024 * 1024,
  waiting: 'composer_waiting',
  uploading: 'composer__attachment_uploading',
  failed: 'composer__attachment_failed',
  kind: (name) => `composer__attachment_kind_${name}`,
  // Кадр видео ещё не пришёл — видно значок; не придёт (iPhone без жеста) — так и останется.
  imageLoading: 'composer__image_loading',
  // Кадр видео — чуть от начала: самый первый часто чёрный.
  frameAt: 0.1,
  icons: { photo: 'image', video: 'video', audio: 'music', text: 'file-text', file: 'file', retry: 'refresh', remove: 'close' },
  text: {
    list: 'Приложено',
    remove: (name) => `Убрать «${name}»`,
    retry: (name) => `Повторить «${name}»`,
    progress: (name) => `Закачка «${name}»`,
    failed: 'Не ушло',
    video: (name, time) => (time ? `Видео «${name}», ${time}` : `Видео «${name}»`),
    tooMany: (max, left) => `Не больше ${max} файлов за раз — лишние не приложены: ${left}`,
    tooBig: (limit, names) => `Больше ${limit} — не приложить: ${names.join(', ')}`,
  },
};

// Сегменты: модификаторы, которые ставит компонент.
export const SEGMENTED = {
  enhanced: 'segmented_enhanced',
  ready: 'segmented_ready',
};

// Круговой регулятор: дуга в 270° с разрывом снизу, риски в координатах viewBox 200.
export const DIAL = {
  start: -135,
  sweep: 270,
  ticks: 55,
  outer: 96,
  inner: 80,
  dragging: 'dial_dragging',
  activeTick: 'dial__tick_active',
};

// Лента дат: вид «словами» и модификаторы плашки.
export const DATESTRIP = {
  textView: 'datestrip_view_text',
  enhanced: 'datestrip_enhanced',
  ready: 'datestrip_ready',
};

// Вертикальный ползунок: с какой доли заливка накрывает значок таблетки.
export const FADER = {
  coverAt: 0.2,
  dragging: 'fader_dragging',
  covered: 'fader_covered',
};

// Подтверждение жестом: с какой доли пути отпускание считается согласием,
// с какой — согласие сразу, сколько держать клавишу, что считать касанием без жеста.
export const SLIDE_CONFIRM = {
  releaseAt: 0.88,
  commitAt: 0.98,
  holdMs: 650,
  tapSlop: 4,
  failedMs: 520,
  vibrateMs: 12,
  both: 'slide-confirm_both',
  dragging: 'slide-confirm_dragging',
  busy: 'slide-confirm_busy',
  done: 'slide-confirm_done',
  decline: 'slide-confirm_side_decline',
  hint: 'slide-confirm_hint',
  failed: 'slide-confirm_failed',
  error: 'slide-confirm_error',
};

// Сетка виджетов: сколько держать палец, чтобы взять виджет; сколько можно
// сдвинуться, пока держишь (дальше — это прокрутка); плавность вытеснения.
export const WIDGETS = {
  longPressMs: 450,
  pressSlop: 8,
  dragSlop: 4,
  flipMs: 320,
  flipEase: 'cubic-bezier(.22, 1, .36, 1)',
  edge: 56,
  scrollSpeed: 14,
  vibrateMs: 10,
  placed: 'widgets_placed',
  editing: 'widgets_editing',
  lifted: 'widgets__item_lifted',
  picked: 'widgets__item_picked',
  labels: { edit: 'Изменить', done: 'Готово' },
  say: {
    editOn: 'Правка виджетов. Пробел — взять виджет, стрелки — двигать, пробел — положить.',
    editOff: 'Правка виджетов закончена',
    picked: (title, x, y) => `${title}: взят, колонка ${x + 1}, строка ${y + 1}`,
    moved: (title, x, y) => `${title}: колонка ${x + 1}, строка ${y + 1}`,
    dropped: (title, x, y) => `${title}: положен в колонку ${x + 1}, строку ${y + 1}`,
    cancelled: (title) => `${title}: остался на месте`,
  },
};

// Графики: формы, подписи у концов линий (не больше четырёх рядов, если
// поле шире labelsFrom), модификаторы, которые ставит компонент.
export const CHART = {
  forms: ['line', 'area', 'stacked', 'grouped', 'layered'],
  maxLabels: 4,
  labelsFrom: 220,
  introMs: 1400,
  enhanced: 'chart_enhanced',
  intro: 'chart_intro',
  tableView: 'chart_view_table',
  tipShown: 'chart__tip_shown',
  hint: 'Стрелки влево и вправо — значения по точкам; данные — в таблице',
  labels: { table: 'Таблица', chart: 'График' },
};

// Календарь активности: подписи и форматы дат.
export const HEATMAP = {
  weekdays: ['Пн', '', 'Ср', '', 'Пт', '', ''],
  less: 'меньше',
  more: 'больше',
  hint: 'Стрелки: влево и вправо — неделя, вверх и вниз — день',
  number: new Intl.NumberFormat('ru-RU'),
  month: new Intl.DateTimeFormat('ru-RU', { month: 'short' }),
  monthLong: new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }),
  date: new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' }),
};

// Классы-модификаторы, которые ставят компоненты
export const STATE_CLASSES = {
  inputFilled: 'input_filled',
  toastLeaving: 'toast_leaving',
  selectEnhanced: 'select_enhanced',
  optionActive: 'select__option_active',
  valuePlaceholder: 'select__value_placeholder',
};

// Пикер цвета: шаги клавиш (доля насыщенности и яркости, градусы оттенка) и подписи.
export const COLOR_PICKER = {
  step: 0.01,
  bigStep: 0.1,
  hueStep: 1,
  bigHueStep: 10,
  enhanced: 'color-picker_enhanced',
  wheel: 'color-picker_view_wheel',
  labels: {
    area: 'Насыщенность и яркость',
    wheel: 'Оттенок и насыщенность',
    hue: 'Оттенок',
    value: 'Яркость',
    hex: 'Код цвета',
    drop: 'Взять цвет с экрана',
    preset: (hex) => `Цвет ${hex}`,
  },
  say: ({ h, s, v }) => `оттенок ${Math.round(h)}°, насыщенность ${Math.round(s * 100)}%, яркость ${Math.round(v * 100)}%`,
};

// Свой скроллбар: самая короткая ручка (px), сколько живёт полоса без прокрутки,
// с какой скорости (экранов в секунду) показывать подпись «где мы» и без жеста,
// за какое окно мерить скорость (события прокрутки на телефоне приходят пачками)
// и сколько подпись держится после быстрого листания или отпущенной ручки.
export const SCROLLER = {
  minThumb: 32,
  idleMs: 1000,
  fastScreensPerSec: 2.5,
  speedWindowMs: 120,
  tellMs: 700,
  // Метка считается текущей, когда вошла в верхнюю долю окна прокрутки.
  readAt: 0.25,
  enhanced: 'scroller_enhanced',
  active: 'scroller_active',
  dragging: 'scroller_dragging',
  telling: 'scroller_telling',
  still: 'scroller_still',
  page: 'scroller_page',
};

// Заготовки загрузки: через сколько после aria-busy="true" показать (быстрая
// загрузка не мигает заготовкой) и какие блоки становятся формой целиком.
export const SKELETON = {
  delayMs: 300,
  base: 'skeleton',
  text: 'skeleton_text',
  media: 'skeleton_media',
  shape: 'skeleton_shape',
  shapes: '.avatar, .thumb, .glyph, .swatch, .channel-mark, .badge, .button, .switch__track, .map, .player__art, .color-picker__area, .color-picker__wheel',
  mediaTags: 'img, video, canvas, svg',
  skip: '.visually-hidden, script, style, template, input, textarea, select, option',
};

// Шапка «как на iPhone» (masthead): модификатор ожившей, запасные размеры полосы
// (если CSS не отдал своих), промежуток фото — текст и имя — пояснение в полосе,
// с какой перемены доли писать её заново.
export const MASTHEAD = {
  live: 'masthead_live',
  // Постер (masthead_view_poster): сжимается в круг из своего квадрата в две фазы —
  // запасные «колено» (доля прокрутки, где круг готов), крупный круг и имя в колене
  // долей крупного, промежуток круг — имя там; в конце круг и имя встают к низу
  // полосы на posterPad от него.
  poster: 'masthead_view_poster',
  knee: 0.55,
  posterPhoto: 120,
  titleMid: 0.6,
  posterGap: 8,
  posterPad: 8,
  strip: 64,
  photo: 44,
  titleScale: 0.7,
  gap: 12,
  lineGap: 2,
  epsilon: 0.001,
};

/** Застенчивая полка (блок sticky, компонент Sticky). */
export const STICKY = {
  shy: 'sticky_shy',
  hidden: 'sticky_hidden',
  // Меньше этого сдвига (px) за кадр — дрожь пальца, а не прокрутка: полку не дёргать.
  slop: 6,
  // Ближе к началу (px) — полка видна всегда.
  nearTop: 24,
};
