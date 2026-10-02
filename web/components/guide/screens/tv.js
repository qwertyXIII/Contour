// Телевизор: меню, по которому ходят пультом. Не копия VIDAA — узнаваемая
// структура «список слева, подсказка справа», крупно, на тёмном.
import { ui } from '../mock.js';

const { row, field, group, split, stack, text, tiles, line, space, card, video, badge, toast, button } = ui;
const tv = (body) => ({ device: 'tv', look: 'tv', body });
const menu = (title, hint, ...rows) => tv([split(stack(text(title, { size: 'l' }), text(hint, { tone: 'muted' })), group(...rows))]);

export function tvScreens() {
  return {
    'tv.home': tv([
      line(text('Главная', { size: 'l' }), space(), text('21:40', { tone: 'muted' })),
      card('hero', text('Сегодня', { tone: 'muted' }), text('Фильм вечера', { size: 'l' })),
      tiles([['live', 'Эфир', 'tv'], ['video', 'Видео', 'play'], ['music', 'Музыка', 'music'], ['web', 'Браузер', 'globe'], ['apps', 'Ещё', 'grid']]),
    ]),
    'tv.settings': menu('Настройки', 'Изображение, звук, сеть и всё остальное',
      row('picture', 'Изображение', { icon: 'image', end: 'chevron' }),
      row('sound', 'Звук', { icon: 'volume', end: 'chevron' }),
      row('network', 'Сеть', { icon: 'wifi', end: 'chevron' }),
      row('system', 'Система', { icon: 'settings', end: 'chevron' }),
      row('support', 'Поддержка', { icon: 'question', end: 'chevron' })),
    'tv.network': menu('Сеть', 'Wi-Fi, кабель и адреса',
      row('netconf', 'Конфигурация сети', { end: 'chevron' }),
      row('netinfo', 'Информация о сети', { end: 'chevron' }),
      row('wol', 'Включение по сети', { end: 'switch', on: true })),
    'tv.netconf': menu('Конфигурация сети', 'Сеть → Конфигурация сети',
      row('type', 'Тип подключения', { value: 'Беспроводное' }),
      row('wifi', 'Wi-Fi', { value: 'Домашняя' }),
      row('ipset', 'IP-настройки', { value: 'Авто', end: 'chevron' })),
    'tv.ip': tv([split(
      stack(text('IP-настройки', { size: 'l' }), text('IP, маска и шлюз — как были; меняется только DNS', { tone: 'muted' })),
      group(
        row('mode', 'Настройка IP', { value: '‹ Авто ›' }),
        field('addr', 'IP-адрес', { value: '192.168.0.37' }),
        field('mask', 'Маска подсети', { value: '255.255.255.0' }),
        field('gw', 'Шлюз', { value: '192.168.0.1' }),
        field('dns1', 'DNS 1', { hint: '—' }),
        field('dns2', 'DNS 2', { hint: '—' })),
      line(space(), button('save', 'Сохранить', { tone: 'primary' }))),
    toast('saved', 'Сохранено')]),
    'tv.video': tv([
      video('clip', 'Видео'),
      line(badge('via', 'через Contour', 'ok'), space(), text('сайт открылся', { tone: 'muted' })),
    ]),
  };
}
