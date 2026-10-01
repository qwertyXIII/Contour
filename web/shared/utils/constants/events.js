// Имена событий: компоненты не зовут друг друга напрямую, а говорят событиями
// с неймспейсом «блок:событие». Все всплывают (bubbles: true).
export const EVENTS = {
  // Попросить тему измениться: detail — { scheme?, density?, accent? }
  // + live: true — значение ещё меняется (тянут пикер): на экран раз за кадр,
  //   theme:change — по такому же событию без live или когда затихнет
  themeSet: 'theme:set',
  // Тема изменилась: detail — полное состояние
  themeChange: 'theme:change',
  // Показать уведомление: detail — { text, tone?, action?: { label, event } }
  toastShow: 'toast:show',
  // Отправлена реплика: detail — { text, files, attachments }: files — номера закачек
  // (пусто, если не прикладывали), attachments — [{ id, kind, name, size, file }] для ленты
  composerSend: 'composer:send',
  // Очистить поле строки ввода composer_hold (реплика ушла); шлют на блок
  composerClear: 'composer:clear',
  // Нажат микрофон в поле
  composerVoice: 'composer:voice',
  // Строка ввода пишет голосовое (ADR-0072 Alter'а): шлют на блок, detail — { on }
  composerRecord: 'composer:record',
  // Записанное — отправить («Отправить» во время записи) или бросить (✕, смахнуть влево)
  composerRecordSend: 'composer:record-send',
  composerRecordCancel: 'composer:record-cancel',
  // Файлы к реплике (скрепка в поле). Строка просит хозяина закачать: detail — { key, file }
  // (выбрали или нажали «повторить»; file — null у превью из разметки) — и бросить:
  // { key, id? } (убрали ✕ или очистили строку; id — если уже закачан)
  composerUpload: 'composer:upload',
  composerUploadAbort: 'composer:upload-abort',
  // Хозяин сообщает строке ход закачки; шлют на блок: { key, progress } (0…1),
  // { key, id } — закачан (номер для composer:send), { key, error } — не ушло, словами
  composerUploadProgress: 'composer:upload-progress',
  composerUploadDone: 'composer:upload-done',
  composerUploadFail: 'composer:upload-fail',
  // Убран чип: detail — { value }
  chipRemove: 'chip:remove',
  // Выбран пункт списка: detail — { value, label } (плюс обычный change у нативного select)
  selectChange: 'select:change',
  // Выбран пункт меню: detail — { value }
  menuSelect: 'menu:select',
  // Вариант сегментов отмечен из кода (checked = true событий не даёт) — пусть плашка переедет
  segmentedSync: 'segmented:sync',
  // Сыграть значок один раз (новое уведомление — колокольчик качнулся); шлют на сам <svg>
  iconPlay: 'icon:play',
  // Подтверждено жестом: detail — { side: 'accept' | 'decline' }
  slideConfirm: 'slide-confirm:confirm',
  // Ответ на подтверждение с ожиданием (data-wait): шлют на блок, detail — { ok, text? }
  slideFinish: 'slide-confirm:finish',
  // Вернуть ручку в начало; шлют на блок
  slideReset: 'slide-confirm:reset',
  // Раскладка виджетов изменилась: detail — { cols, layout, layouts: { [cols]: [{ id, x, y, w, h }] } }
  widgetsChange: 'widgets:change',
  // Включена или выключена правка: detail — { editing }
  widgetsEdit: 'widgets:edit',
  // Положить сохранённые раскладки: шлют на блок, detail — { layouts }
  widgetsLoad: 'widgets:load',
  // Вернуть раскладку по порядку разметки; шлют на блок
  widgetsReset: 'widgets:reset',
  // Открыть просмотр: detail — { items: [{ kind, src, preview?, alt, caption?, credit?, ratio }], index,
  // origin? } — origin(номер) отдаёт плитку этого номера: из неё фото вырастает и в неё возвращается
  mediaOpen: 'media:open',
  // Выбрали плитку сетки для выбора (media_pick): просмотра нет; detail — { value } —
  // data-value плитки; шлёт блок
  mediaPick: 'media:pick',
  // Просмотр закрыт: шлют на блок, который его открыл; detail — { index } (на чём закрыли)
  viewerClose: 'viewer:close',
  // Сеанс музыки сообщает своё состояние видам: detail — { session, playing, position, at,
  // duration, buffered, volume, muted, title, artist, cover, colors (главные цвета обложки или null), source,
  // index, queue, repeat, shuffle }
  playerState: 'player:state',
  // Вид просит сеанс: detail — { session, action, value? }; action — toggle | next | prev |
  // seek (с) | volume (0…1) | mute | shuffle | repeat | select (номер) | load ({ queue, index, source }) | sync
  playerCommand: 'player:command',
  // Карта нарисована: detail — { provider }
  mapReady: 'map:ready',
  // Карта не нарисовалась: detail — { provider, reason }
  mapError: 'map:error',
  // Показать на карте другое: шлют на блок, detail — { view?, markers?, route? } (см. utils/map-providers.js)
  mapSet: 'map:set',
  // Показать экран: шлют на пейджер (блок screens), detail — { index }
  screensShow: 'screens:show',
  // Пейджер листают: detail — { progress } (дробный номер экрана, 1.4 — между вторым и третьим)
  screensScroll: 'screens:scroll',
  // Текущий экран сменился: detail — { index }
  screensChange: 'screens:change',
  // Нажали «+» у пилюль — новый экран (решает хозяин)
  screenTabsAdd: 'screen-tabs:add',
  // Долгое нажатие на пилюлю — правка набора экранов: detail — { index }
  screenTabsEdit: 'screen-tabs:edit',
  // Цвет выбран (палец отпущен, код введён): detail — { value } (#rrggbb). Во время жеста — обычный input у нативного поля
  colorPickerChange: 'color-picker:change',
  // Сцена кольца: шлют на блок, detail — { mode?, layout?, busy?, look?, brightness?, regions?, shape? } (режим кольца,
  // раскладка, свет занятости, вид кольца из настроек — ключи движка, яркость цветов обложки — множитель, зоны
  // движка — [{ start, end, band, source }], source может быть функцией (count) → уровни; null — спектр на обе
  // стороны; фигура — функция из components/orb/orb-shapes.js или null — кольцо). Вид при создании — атрибут data-look
  orbStageSet: 'orb-stage:set',
  // Сцена ожила — кольцо создано и слушает orb-stage:set. Шлёт сам блок: хозяину, который строит сцену
  // и сразу хочет ей что-то сказать (событие сразу после вставки теряется — ADR-0009 системы)
  orbStageReady: 'orb-stage:ready',
  // Лист (блок sheet): встать на упор — шлют на блок, detail — { to: 'low' | 'top' | номер, animate? }
  // (animate: false — сразу, без движения: первый кадр, выход из привязки)
  sheetSet: 'sheet:set',
  // Пересчитать упоры: сменились окно, клавиатура или содержимое — шлют на блок
  sheetMeasure: 'sheet:measure',
  // Закрыть вопрос-лист (sheet_modal) с ответом: шлют на блок, detail — { value } — уйдёт в
  // returnValue нативного <dialog>; без него — отмена. Закрывается движением, потом close
  sheetDismiss: 'sheet:dismiss',
  // Лист выбрал упор (палец отпустили или попросили): detail — { index, open } — open: верхний
  sheetChange: 'sheet:change',
  // Ход перешёл половину (поле внизу выезжает или прячется): detail — { up }
  sheetField: 'sheet:field',
  // Голосовой режим в панели разговора (ADR-0072 Alter'а): микрофон потянули вверх —
  // { open: true }, кольцо вниз — { open: false }. Зовётся ИЗ отпускания пальца,
  // синхронно: iOS заводит звук только из жеста. Открыть или закрыть из кода —
  // sheet:voice-set { open, animate? } на блок.
  sheetVoice: 'sheet:voice',
  sheetVoiceSet: 'sheet:voice-set',
  // Голос закрыт и движение кончилось: реплики на местах, слой спрятан
  sheetVoiceRest: 'sheet:voice-rest',
};
