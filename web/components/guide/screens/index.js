// Все макеты экранов по id: «ios.wifi», «mac.net», «tv.ip», «panel.devices»…
// Адрес сервера и имя панели — из состояния (`s`), как в тексте шагов.
import { deskScreens } from './desk.js';
import { panelScreens } from './panel.js';
import { phoneScreens } from './phone.js';
import { tvScreens } from './tv.js';

export function screens(s) {
  return { ...tvScreens(s), ...phoneScreens(s), ...deskScreens(s), ...panelScreens(s) };
}
