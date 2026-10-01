// Витрина: устройства, ключи, тайминги демонстраций.
export const SHOWCASE = {
  storageKey: 'alter-ui:showcase',
  version: 'v0.1 · 29.09.2026',
  // Устройство витрины → плотность темы. «Телефон» ещё и сужает стенды.
  devices: [
    { value: 'auto', label: 'Авто', density: 'auto' },
    { value: 'phone', label: 'Телефон', density: 'touch' },
    { value: 'desktop', label: 'Десктоп', density: 'compact' },
  ],
  schemes: [
    { value: 'auto', label: 'Авто' },
    { value: 'dark', label: 'Тёмная' },
    { value: 'light', label: 'Светлая' },
  ],
  modifiers: {
    navOpen: 'showcase_nav_open',
    phone: 'showcase_device_phone',
    currentItem: 'showcase__nav-item_current',
  },
};

// Задержки демонстраций: ответ «Alter'а» в образце разговора и т. п.
export const DEMO = {
  replyDelayMs: 900,
  typingMs: 1400,
  loadingMs: 1600,
  // Через сколько образец подтверждения жестом возвращается в начало.
  resetMs: 2400,
  // Ключ раскладок виджетов витрины в localStorage (дальше — :ключ блока).
  widgetsKey: 'alter-ui:widgets',
  // Какую плитку «нажимает» кнопка образца просмотра.
  viewerFrom: '#media .media_view_carousel .media__item',
  // Подписи кнопки образца заготовок.
  busy: { on: 'Загрузка', off: 'Загрузилось' },
  // Что ответить на «+» и долгое нажатие у пилюль экранов: набор экранов меняет хозяин.
  screens: {
    add: 'Новый экран создаёт владелец или Alter: «Альтер, сделай экран про дачу»',
    edit: 'Правка экранов: порядок, имя, значок, убрать',
  },
  // Сеанс музыки витрины: все виды плеера на странице смотрят на него.
  // Треки синтезированы scripts/demo-music.mjs (архив ~/dev/Alter-UI), обложки — src/assets/demo/CREDITS.md.
  player: {
    session: 'demo',
    source: 'Мои файлы',
    queue: [
      { title: 'Утро', artist: 'Витрина Alter UI', cover: 'src/assets/demo/covers/falls.jpg', src: 'src/assets/demo/music/utro.wav', duration: 22 },
      { title: 'Дорога', artist: 'Витрина Alter UI', cover: 'src/assets/demo/covers/walrus.jpg', src: 'src/assets/demo/music/doroga.wav', duration: 21.2 },
      { title: 'Вечер', artist: 'Витрина Alter UI', cover: 'src/assets/demo/covers/waves.jpg', src: 'src/assets/demo/music/vecher.wav', duration: 23.2 },
    ],
  },
};

// Витрина значков: режимы движения и подписи. Сами значки читаются из спрайта.
export const ICONSET = {
  // Как значок задуман (data-motion у символа) → подпись на карточке.
  modeNotes: {
    hover: 'один раз',
    hold: 'пока держишь',
    loop: 'всегда',
    once: 'при появлении',
  },
  // Разметка, которую копирует щелчок по значку.
  snippetHref: 'src/assets/icons/sprite.svg',
  countLabel: (shown, total) => (shown === total ? `${total} значков` : `Нашлось ${shown} из ${total}`),
  copied: (name) => `Скопирована разметка значка ${name}`,
  copyFailed: 'Браузер не дал доступа к буферу обмена — разметка в консоли',
};

// Стенд движения: где помнить подстроенные пружины, через сколько «ушедшие»
// плитки возвращаются, как назвать пружину в строке значений.
export const MOTION_LAB = {
  storageKey: 'alter-ui:motion',
  returnMs: 500,
  say: (kind, bounce, duration) => `${kind === 'soft' ? 'мягкая' : 'упругая'}: отскок ${bounce}, ${duration} мс`,
};

// Живой макет панели разговора — голос (ADR-0072 Alter'а): запись и сценарий разговора
// вместо сервера. Шаги: через ms — режим кольца, подпись, реплика человека или Alter'а.
export const VOICE_PULL = {
  tickMs: 90,
  sent: (time) => `Ушло бы голосовое, ${time}`,
  noStrip: 'Нажми микрофон в живом макете панели — там запись голосового',
  status: { listening: 'Слушаю' },
  who: { you: 'Ты', alter: 'Alter' },
  script: [
    { ms: 1400, you: 'Какая завтра погода?', mode: 'thinking', busy: 'tool', status: 'Погода…' },
    { ms: 1600, mode: 'speaking', status: 'Говорю', alter: 'Завтра солнечно, до плюс восемнадцати.' },
    { ms: 2200, alter: 'Вечером может пойти дождь — зонт лучше взять с собой.' },
    { ms: 2600, mode: 'listening', status: 'Слушаю' },
  ],
};

// Сценарий образца «Голосовой режим»: реплики человека, что Alter отвечает по
// фразам и сколько частей вида видно к каждой (data-reveal-count).
export const VOICE_DEMO = {
  session: 'demo',
  listenMs: 1400,
  thinkMs: 1100,
  status: { listening: 'Слушаю', thinking: 'Думаю', speaking: 'Говорю', idle: '' },
  who: { you: 'Ты', alter: 'Alter' },
  scenes: {
    route: {
      ask: 'Сколько ехать до стоматолога?',
      tool: 'Смотрю дорогу',
      view: 'tpl-voice-route',
      layout: 'top',
      phrases: [
        { text: 'До стоматолога двадцать восемь минут.', show: 1, ms: 2400 },
        { text: 'На Димитровском пробка — это на двенадцать минут дольше обычного.', show: 2, ms: 3000 },
        { text: 'Выезжай в 15:55 — успеешь к половине пятого.', show: 3, ms: 2800 },
      ],
    },
    music: { ask: 'Включи что-нибудь спокойное', say: 'Включаю «Утро».', view: 'tpl-voice-player', sayMs: 1800 },
    next: { ask: 'Дальше', say: '', sayMs: 400 },
    stop: { ask: 'Хватит музыки', say: 'Выключил.', sayMs: 1400 },
  },
};

// Файлы строки ввода на витрине — подделка вместо POST /api/chat/upload: ход — по
// выдуманной скорости в пределах minMs…maxMs, каждая failEvery-я закачка с первого раза
// не уходит («повторить» — уйдёт). Номер закачки выдуманный.
export const DEMO_UPLOAD = {
  tickMs: 80,
  bytesPerSec: 8 * 1024 * 1024,
  minMs: 1400,
  maxMs: 4200,
  failEvery: 3,
  // Где оборвать неудачную — на этой доле пути.
  failAt: 0.55,
  // У превью из разметки файла нет — столько «весит» его повтор.
  unknownBytes: 2 * 1024 * 1024,
  failText: 'связь оборвалась (так на витрине выглядит отказ)',
  id: (n) => `demo-${n}`,
  attached: (count) => `Приложено файлов: ${count}`,
};
