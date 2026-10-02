// Ноутбук: окна Mac и Windows, настройки браузера, веб-страница роутера,
// терминалы, страница из рабочей сети. Окно — облик (look) и рамка (chrome);
// внутри — тот же словарь, что у телефона.
import { ui } from '../mock.js';

const { row, field, group, split, frame, side, stack, text, line, space, button, select, sheet, toast, card, term, tabs, badge } = ui;
const win = (look, chrome, body) => ({ device: 'laptop', look, chrome, body });
const mac = (body) => win('mac', { kind: 'mac', title: 'Системные настройки' }, body);
const windows = (body) => win('win', { kind: 'win', title: 'Параметры' }, body);
const browser = (url, body) => win('web', { kind: 'browser', url }, body);

const MAC_SIDE = [['wifi', 'Wi-Fi', 'wifi'], ['bt', 'Bluetooth', 'bluetooth'], ['net', 'Сеть', 'globe'], ['notif', 'Уведомления', 'bell'], ['sound', 'Звук', 'volume'], ['general', 'Основные', 'settings']];
const WIN_SIDE = [['sys', 'Система', 'monitor'], ['bt', 'Bluetooth и устройства', 'bluetooth'], ['net', 'Сеть и Интернет', 'wifi'], ['pers', 'Персонализация', 'palette'], ['apps', 'Приложения', 'grid']];
const ROUTER_SIDE = [['status', 'Состояние', 'activity'], ['net', 'Сеть', 'globe'], ['inet', 'Интернет', null, { sub: true }], ['lan', 'LAN', null, { sub: true }], ['dhcp', 'DHCP-сервер', null, { sub: true }], ['wl', 'Беспроводной режим', 'wifi'], ['sec', 'Защита', 'shield-check'], ['tools', 'Системные инструменты', 'settings']];

// Подпункты «Сети» роутера спрятаны, пока раздел не раскрыли.
const routerSide = (picked, open) => side(ROUTER_SIDE.map(([id, t, icon, o]) => [id, t, icon, o?.sub ? { ...o, gone: !open } : o]), picked);
const routerTop = (picked) => [
  tabs([['quick', 'Быстрая настройка'], ['basic', 'Базовая'], ['adv', 'Дополнительные настройки']], picked),
];

export function deskScreens() {
  return {
    'mac.general': mac([frame(side(MAC_SIDE, 'general'),
      text('Основные', { size: 'l' }),
      group(row('about', 'Об этом Mac', { end: 'chevron' }), row('update', 'Обновление ПО', { end: 'chevron' }), row('storage', 'Хранилище', { end: 'chevron' })))]),
    'mac.net': mac([frame(side(MAC_SIDE, 'net'),
      text('Сеть', { size: 'l' }),
      group(
        row('wifi', 'Wi-Fi', { icon: 'wifi', value: 'Подключено', end: 'chevron' }),
        row('eth', 'Ethernet', { icon: 'plug', value: 'Не подключено', end: 'chevron' }),
        row('vpn', 'VPN', { icon: 'lock', end: 'chevron' }),
        row('fw', 'Брандмауэр', { icon: 'shield-check', value: 'Выкл.', end: 'chevron' })))]),
    'mac.wifi': mac([
      frame(side(MAC_SIDE, 'net'),
        text('‹ Wi-Fi', { size: 'l' }),
        group(row('wifi-on', 'Wi-Fi', { end: 'switch', on: true }), row('home', 'Домашняя', { tick: true, btn: ['more', 'Подробнее…'] })),
        group(row('n2', 'Сосед_5G', { icon: 'lock' }), row('n3', 'Гостевая'))),
      sheet('details',
        split(side([['tcp', 'TCP/IP'], ['dns', 'DNS'], ['wins', 'WINS'], ['proxy', 'Прокси']], 'tcp'),
          { ...stack(text('Настроить IPv4: автоматически', { tone: 'muted' }), group(row('ip4', 'IP-адрес', { value: '192.168.0.41' }), row('gw4', 'Маршрутизатор', { value: '192.168.0.1' }))), id: 'p-tcp' },
          { ...stack(text('DNS-серверы', { tone: 'muted' }),
            group(row('srv-old', '192.168.0.1', { hl: true }), field('srv-new', '', { hint: 'адрес', gone: true })),
            line(button('plus', '', { icon: 'plus' }), button('minus', '', { icon: 'minus' }))), id: 'p-dns', gone: true }),
        line(space(), button('cancel', 'Отменить'), button('ok', 'ОК', { tone: 'primary' })))]),
    'win.home': windows([frame(side(WIN_SIDE, 'sys'),
      text('Система', { size: 'l' }),
      group(row('display', 'Дисплей', { icon: 'monitor', end: 'chevron' }), row('sound', 'Звук', { icon: 'volume', end: 'chevron' }), row('notif', 'Уведомления', { icon: 'bell', end: 'chevron' })))]),
    'win.net': windows([frame(side(WIN_SIDE, 'net'),
      text('Сеть и Интернет', { size: 'l' }),
      group(
        row('wifi', 'Wi-Fi', { icon: 'wifi', value: 'Домашняя', end: 'chevron' }),
        row('eth', 'Ethernet', { icon: 'plug', end: 'chevron' }),
        row('vpn', 'VPN', { icon: 'lock', end: 'chevron' }),
        row('proxy', 'Прокси-сервер', { icon: 'globe', end: 'chevron' })))]),
    'win.wifi': windows([frame(side(WIN_SIDE, 'net'),
      text('Сеть и Интернет › Wi-Fi', { size: 'l' }),
      group(row('wifi-on', 'Wi-Fi', { end: 'switch', on: true }), row('props', 'Свойства «Домашняя»', { icon: 'info', end: 'chevron' }), row('known', 'Известные сети', { end: 'chevron' })))]),
    'win.props': windows([
      frame(side(WIN_SIDE, 'net'),
        text('Wi-Fi › Домашняя', { size: 'l' }),
        group(
          row('profile', 'Тип сетевого профиля', { value: 'Частная' }),
          row('ipa', 'Назначение IP', { value: 'Автоматически', btn: ['ip-edit', 'Изменить'] }),
          row('dnsa', 'Назначение DNS', { value: 'Автоматически', btn: ['dns-edit', 'Изменить'] }))),
      sheet('dlg',
        text('Изменение параметров DNS', { size: 'm' }),
        select('mode', '', 'Автоматически (DHCP)', [['m-auto', 'Автоматически (DHCP)'], ['m-manual', 'Вручную']]),
        { ...group(row('v4on', 'IPv4', { end: 'switch' }), field('pref', 'Предпочтительный DNS', { stacked: true, gone: true })), id: 'v4', gone: true },
        line(space(), button('save', 'Сохранить', { tone: 'primary' }), button('cancel', 'Отмена')))]),
    'web.secure': browser('настройки › конфиденциальность', [
      text('Безопасность', { size: 'l' }),
      group(
        row('sb', 'Безопасный просмотр', { value: 'Стандартный', end: 'chevron' }),
        row('secure', 'Использовать безопасный DNS', { end: 'switch', on: true }),
        row('cookies', 'Файлы cookie', { end: 'chevron' })),
      text('Безопасный DNS — браузер спрашивает адреса сайтов у своего сервера, мимо домашнего.', { tone: 'muted' }),
    ]),
    'router.home': browser('http://192.168.0.1', [
      ...routerTop('basic'),
      card(null, text('Карта сети', { size: 'm' }), group(row('inet', 'Интернет', { icon: 'globe', value: 'Подключено' }), row('clients', 'Клиенты', { icon: 'users', value: '8' }), row('wl', 'Wi-Fi', { icon: 'wifi', value: '2,4 и 5 ГГц' }))),
    ]),
    'router.adv': browser('http://192.168.0.1', [
      ...routerTop('adv'),
      split(routerSide('status', false), text('Состояние', { size: 'l' }), group(row('wan', 'Интернет', { value: 'Подключено' }), row('lan-ip', 'LAN', { value: '192.168.0.1' }), row('up', 'Работает', { value: '12 дн.' }))),
    ]),
    'router.dhcp': browser('http://192.168.0.1', [
      ...routerTop('adv'),
      split(routerSide('dhcp', true),
        text('DHCP-сервер', { size: 'l' }),
        group(
          row('dhcp-on', 'DHCP-сервер', { end: 'switch', on: true }),
          field('pool', 'Адреса', { value: '192.168.0.100 – 249' }),
          field('gw', 'Основной шлюз', { value: '192.168.0.1' }),
          field('dns1', 'Первичный DNS', { hint: '0.0.0.0' }),
          field('dns2', 'Вторичный DNS', { hint: '0.0.0.0' })),
        line(space(), button('save', 'Сохранить', { tone: 'primary' }))),
      toast('saved', 'Сохранено'),
    ]),
    'term.mac': win('term', { kind: 'term', title: 'Терминал' }, [term('sh', 'mac:~ $')]),
    'term.win': win('term', { kind: 'win', title: 'Командная строка (администратор)' }, [term('cmd', 'C:\\>')]),
    'term.srv': win('term', { kind: 'term', title: 'ssh server' }, [term('sh', 'server:~$')]),
    'corp.site': browser('', [
      { ...card('page',
        text('Внутренний портал', { size: 'l' }),
        text('Подсеть 172.16.42.0/24 — только через свой туннель', { tone: 'muted' }),
        group(row('wiki', 'База знаний', { icon: 'book', end: 'chevron' }), row('git', 'Репозитории', { icon: 'code', end: 'chevron' }), row('tasks', 'Задачи', { icon: 'clipboard-check', end: 'chevron' })),
        line(badge('via', 'через corp_mixed', 'ok'))), gone: true },
    ]),
  };
}
