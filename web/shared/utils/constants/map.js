// Карты: какой провайдер по умолчанию, как вписывать маршрут, подписи.
// Провайдеров блок не знает — их регистрирует index.js (utils/map-providers.js).

export const MAP = {
  defaultProvider: 'schematic',
  ready: 'map_ready',
  error: 'map_error',
  // Web Mercator: на зуме 0 весь мир — квадрат в 256 точек, каждый шаг зума — вдвое больше.
  tileSize: 256,
  // Вписать маршрут: отступ от краёв под метки (px) и пределы зума.
  fitPadding: 36,
  minZoom: 2,
  maxZoom: 17,
  // Какая доля карты должна оказаться на экране, чтобы маршрут начал проводиться.
  revealAt: 0.5,
  labels: {
    error: 'Карта не загрузилась',
    noProvider: (name) => `Нет карты «${name}»`,
    schematic: 'схема',
  },
};
