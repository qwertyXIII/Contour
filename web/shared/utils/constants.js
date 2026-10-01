// ВСЕ константы фронтенда здесь: адреса, брейкпоинты, имена событий, ключи storage.
// Тематические файлы лежат в constants/, а импорты в коде идут только отсюда.
export const IS_DEV = ['localhost', '127.0.0.1'].includes(location.hostname);

// Своего клиента API у системы нет: шаблонный utils/api.js (куки, {ok,data}, порт 3000)
// с API Alter'а не совпадал и удалён при переносе (ADR-0057). Дверь к серверу —
// client/api.js (токен устройства в Bearer, ADR-0069).

// Должны совпадать с медиазапросами в CSS
export const BREAKPOINTS = { md: 768, lg: 1024, xl: 1280 };

export * from './constants/events.js';
export * from './constants/theme.js';
export * from './constants/ui.js';
export * from './constants/media.js';
export * from './constants/motion.js';
export * from './constants/map.js';
export * from './constants/screens.js';
export * from './constants/sheet.js';
export * from './constants/voice.js';
export * from './constants/showcase.js';
export * from './constants/tokens.js';
