// Эта же панель — уменьшенной копией в окне браузера: «Устройства», «Правила»,
// «Раздача». Адрес в строке браузера — имя панели из состояния.
import { ui } from '../mock.js';

const { row, field, group, stack, text, line, space, button, select, sheet, card, tabs, badge, chips, seg, route, qr } = ui;

const TABS = [['ov', 'Обзор'], ['dev', 'Устройства'], ['rules', 'Правила'], ['share', 'Раздача']];
const GATEWAY = (id) => [[`${id}-off`, 'выкл'], [`${id}-blocked`, 'только заблокированное'], [`${id}-all`, 'всё через VPN']];

export function panelScreens(s) {
  const page = (picked, ...body) => ({
    device: 'laptop', look: 'web', chrome: { kind: 'browser', url: `http://${s.panel}` },
    body: [line(text('Contour', { size: 'm' }), space(), badge(null, 'работает', 'ok')), tabs(TABS, picked), ...body],
  });
  const devices = (tvNew) => page('dev',
    group(row('tv', 'Телевизор', { icon: 'tv', value: tvNew ? '12 Мбит/с ↓' : '192.168.0.105', gone: tvNew })),
    card('phonecard',
      row('phone', 'iPhone', { icon: 'phone', value: '192.168.0.37' }),
      select('gw', 'Шлюз', 'выкл', GATEWAY('gw')),
      badge('wait', 'шлюз ждёт: IP 192.168.0.200 вручную', 'warn', { gone: true }),
      badge('gwok', 'через сервер · 3 Мбит/с', 'ok', { gone: true })),
    card('maccard',
      row('mac', 'MacBook', { icon: 'laptop', value: '192.168.0.41' }),
      select('mgw', 'Шлюз', 'выкл', GATEWAY('mgw'))));
  const rules = (stops, verdict, fresh) => page('rules',
    card('checker',
      text('Куда пойдёт сайт', { size: 'm' }),
      line(field('host', '', { hint: 'сайт или адрес' }), button('check', 'Проверить', { tone: 'primary' })),
      { ...stack(route('route', stops), badge('verdict', verdict, 'warn')), id: 'result', gone: true }),
    line(text('Свои списки', { size: 'm' }), space(), button('new', 'Новый список', { icon: 'plus' })),
    { ...card('mylist', row('list', 'Свой список', { icon: 'edit', value: 'только через: corp_mixed' }), text('1 правило · вручную', { tone: 'muted' })), gone: fresh },
    sheet('dlg',
      text('Новый список', { size: 'm' }),
      seg([['src-url', 'По ссылке'], ['src-file', 'Файлом'], ['src-manual', 'Вручную']], 'src-url'),
      field('text', 'Правила — свой формат', { stacked: true, multi: true, hint: '[раздел] и под ним адреса' }),
      line(space(), button('add', 'Добавить', { tone: 'primary' }))));
  return {
    'panel.devices': devices(false),
    'panel.tvnew': devices(true),
    'panel.rules': rules([['172.16.42.10', 'подсеть: 172.16.42.0/24'], ['Свой список', 'слой «ручное»'], ['corp_mixed', 'туннель · жив']], 'только через: corp_mixed', true),
    'panel.site': rules([['youtube.com', 'с поддоменами: youtube.com'], ['Заблокированное', 'слой «загруженное»'], ['corp_ext', 'туннель · DE · жив']], 'через туннель'),
    'panel.share': page('share',
      text('Телефоны', { size: 'm' }),
      group('phones',
        row('ipad', 'iPad', { icon: 'phone', btn: ['ipad.open', 'Подключить'] }),
        row('iphone', 'iPhone', { icon: 'phone', btn: ['connect', 'Подключить'], gone: true })),
      { ...chips([['c-tr', 'TR'], ['c-de', 'DE'], ['c-ge', 'GE']]), id: 'countries', gone: true },
      line(field('name', '', { hint: 'Имя телефона' }), button('add', 'Добавить', { tone: 'primary', icon: 'plus' })),
      sheet('qrsheet',
        text('Подключить «iPhone»', { size: 'm' }),
        seg([['sub', 'Подписка'], ['one', 'По одному']], 'sub'),
        line(space(), qr('code'), space()),
        text('Сканер слева вверху в Shadowrocket', { tone: 'muted' }),
        line(button('copylink', 'Скопировать ссылку', { icon: 'copy' }), space(), button('rules-link', 'Правила', { icon: 'link' })))),
  };
}
