// Константы панели Contour. Литералы со смыслом — только здесь.

export const API = {
  me: '/api/me',
  login: '/api/login',
  logout: '/api/logout',
  state: '/api/state',
  history: '/api/history',
  journal: '/api/journal',
  sites: '/api/sites',
  speedtest: '/api/speedtest',
  outlets: '/api/outlets',
  device: (mac) => `/api/devices/${encodeURIComponent(mac)}`,
  outlet: (name) => `/api/outlets/${encodeURIComponent(name)}`,
};

export const TIMING = {
  /** Как часто спрашивать состояние: скорость в панели — «сейчас». */
  stateMs: 2_000,
  historyMs: 60_000,
  slowMs: 10_000,
  requestMs: 15_000,
  /** Замер скорости идёт до 10 с на сервере. */
  speedtestMs: 30_000,
  /** Сколько ждать, пока Contour вернётся после перезапуска. */
  restartWaitMs: 40_000,
};

/** История — точка в минуту; на графике — корзины по столько минут. */
export const CHART_BUCKET_MIN = 15;

export const EVENTS = {
  state: 'contour:state',
  history: 'contour:history',
  authLost: 'contour:auth-lost',
  restart: 'contour:restart',
  toast: 'toast:show',
};

export const ICON_SPRITE = '/shared/assets/icons/sprite.svg';

export const SOURCE_HINTS = {
  conf: 'Конфиг AmneziaWG или WireGuard (.conf) или ссылка vpn:// из Amnezia. Поднимется в ядре — быстро.',
  link: 'Ссылка vless://, vmess://, trojan://, ss:// или hysteria2://. Работает через mihomo — скорость проверь замером.',
  subscription: 'Ссылка на подписку провайдера. Из её серверов mihomo сам выбирает самый быстрый.',
  ovpn: 'Файл .ovpn со встроенными ключами. Логин и пароль, скрипты и плагины не поддерживаются.',
};
