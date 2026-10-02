// Телефон: настройки iPhone (Wi-Fi, сеть, DNS, IP, iCloud) и Shadowrocket.
// Узнаваемая структура — группы строк, «‹ Назад», переключатели, — без логотипов.
import { ui } from '../mock.js';

const { bar, head, group, choose, row, field, text, line, space, button, cam, dock } = ui;
const ios = (body) => ({ device: 'phone', look: 'ios', body });

const ROCKET_TABS = [['t-home', 'Главная', 'home'], ['t-conf', 'Конфиг', 'file-text'], ['t-data', 'Данные', 'chart-bar'], ['t-set', 'Настройки', 'settings']];

export function phoneScreens() {
  return {
    'ios.settings': ios([
      bar('Настройки', { large: true }),
      group(row('account', 'Учётная запись', { icon: 'user', value: 'iCloud', end: 'chevron' })),
      group(
        row('air', 'Авиарежим', { icon: 'plane', end: 'switch' }),
        row('wifi', 'Wi-Fi', { icon: 'wifi', value: 'Домашняя', end: 'chevron' }),
        row('bt', 'Bluetooth', { icon: 'bluetooth', value: 'Вкл.', end: 'chevron' }),
        row('cell', 'Сотовая связь', { icon: 'signal', end: 'chevron' })),
      group(
        row('notif', 'Уведомления', { icon: 'bell', end: 'chevron' }),
        row('sounds', 'Звуки', { icon: 'volume', end: 'chevron' }),
        row('focus', 'Фокусирование', { icon: 'moon', end: 'chevron' })),
    ]),
    'ios.wifi': ios([
      bar('Wi-Fi', { back: 'Настройки', large: true }),
      group(
        row('wifi-on', 'Wi-Fi', { end: 'switch', on: true }),
        row('home', 'Домашняя', { tick: true, end: 'info' })),
      head('Другие сети', 'nets-head'),
      group('nets',
        row('n2', 'Сосед_5G', { end: 'info' }),
        row('n3', 'Гостевая', { end: 'info' })),
    ]),
    'ios.net': ios([
      bar('Домашняя', { back: 'Wi-Fi' }),
      group(row('forget', 'Забыть эту сеть', { tone: 'accent' })),
      group(row('autojoin', 'Автоподключение', { end: 'switch', on: true })),
      group(row('limit', 'Ограничить отслеживание IP', { end: 'switch', on: true })),
      head('IPv4-адрес'),
      group(
        row('ipmode', 'Настройка IP', { value: 'Автоматически', end: 'chevron' }),
        row('ip', 'IP-адрес', { value: '192.168.0.37' }),
        row('mask', 'Маска подсети', { value: '255.255.255.0' }),
        row('router', 'Маршрутизатор', { value: '192.168.0.1' })),
      head('DNS'),
      group(row('dnsmode', 'Настройка DNS', { value: 'Автоматически', end: 'chevron' })),
      head('HTTP-прокси'),
      group(row('proxy', 'Настройка прокси', { value: 'Выкл.', end: 'chevron' })),
    ]),
    'ios.dns': ios([
      bar('DNS', { back: 'Домашняя', act: ['save', 'Сохранить'] }),
      choose(row('auto', 'Автоматически', { end: 'check', on: true }), row('manual', 'Вручную', { end: 'check' })),
      head('DNS-серверы'),
      group(
        row('old', '192.168.0.1', { lead: 'minus', del: true }),
        field('new', '', { hint: 'Адрес сервера', gone: true }),
        row('add', 'Добавить сервер', { tone: 'accent', gone: true })),
    ]),
    'ios.ip': ios([
      bar('IPv4', { back: 'Домашняя', act: ['save', 'Сохранить'] }),
      choose(row('auto', 'Автоматически', { end: 'check', on: true }), row('manual', 'Вручную', { end: 'check' }), row('bootp', 'BootP', { end: 'check' })),
      head('Вручную', 'mhead', { gone: true }),
      { ...group('mgroup',
        field('ip', 'IP-адрес', { hint: 'из панели' }),
        field('mask', 'Маска подсети', { hint: '255.255.255.0' }),
        field('router', 'Маршрутизатор', { hint: 'адрес' })), gone: true },
    ]),
    'ios.icloud': ios([
      bar('iCloud', { back: 'Учётная запись', large: true }),
      group(
        row('photos', 'Фото', { icon: 'image', value: 'Вкл.', end: 'chevron' }),
        row('keys', 'Пароли и ключи', { icon: 'key', value: 'Вкл.', end: 'chevron' }),
        row('relay', 'Частный узел', { icon: 'globe', value: 'Вкл.', end: 'chevron' })),
    ]),
    'ios.relay': ios([
      bar('Частный узел', { back: 'iCloud' }),
      group(row('relay-on', 'Частный узел', { end: 'switch', on: true })),
      text('Пока включён, Safari спрашивает адреса сайтов мимо домашнего сервера.', { tone: 'muted' }),
    ]),
    'rocket.home': ios([
      line(button('scan', '', { icon: 'scan' }), space(), text('Shadowrocket', { size: 'm' }), space(), button('plus', '', { icon: 'plus' })),
      group(row('power', 'Статус', { value: 'Не подключено', end: 'switch' })),
      group(row('route', 'Глобальная маршрутизация', { value: 'Конфиг', end: 'chevron' })),
      head('Серверы'),
      choose('servers',
        row('none', 'Пока нет серверов', { tone: 'muted' }),
        row('contour', 'Contour', { end: 'check', gone: true }),
        row('de', 'DE · Contour', { end: 'check', gone: true }),
        row('tr', 'TR · Contour', { end: 'check', gone: true })),
      dock(ROCKET_TABS, 't-home'),
    ]),
    'rocket.scan': { device: 'phone', look: 'cam', body: [
      line(button('close', '', { icon: 'close' }), space()),
      cam('cam'),
      text('Наведи камеру на QR в панели', { tone: 'muted' }),
    ] },
    'rocket.conf': ios([
      line(space(), text('Конфиг', { size: 'm' }), space(), button('cplus', '', { icon: 'plus' })),
      head('Локальные файлы'),
      choose(row('default', 'default.conf', { icon: 'file-text', end: 'check', on: true }), row('contour', 'contour.conf', { icon: 'file-text', end: 'check', gone: true })),
      text('Галочка — конфиг, по которому сейчас решаются правила.', { tone: 'muted' }),
      ui.sheet('add', text('Добавить конфиг', { size: 'm' }), field('url', '', { hint: 'Ссылка на конфиг', stacked: true }), line(space(), button('load', 'Загрузить', { tone: 'primary' }))),
      dock(ROCKET_TABS, 't-conf'),
    ]),
  };
}
