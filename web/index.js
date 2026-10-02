// Запуск панели Contour: сначала дизайн-система Alter'а (тема, диалоги, вкладки,
// тосты, графики — она же оживит разметку, которую разделы соберут позже),
// потом разделы панели. Связь между разделами — только событиями (utils/constants.js).
import { startSystem } from '/shared/system.js';
import { App } from './components/app/app.js';
import { Devices } from './components/devices/devices.js';
import { Guide } from './components/guide/guide.js';
import { Journal } from './components/journal/journal.js';
import { Outlets } from './components/outlets/outlets.js';
import { Overview } from './components/overview/overview.js';
import { Rules } from './components/rules/rules.js';
import { Share } from './components/share/share.js';
import { Sites } from './components/sites/sites.js';

startSystem(document.body);

const SECTIONS = [
  ['[data-overview]', Overview],
  ['[data-devices]', Devices],
  ['[data-guide]', Guide],
  ['[data-sites]', Sites],
  ['[data-rules]', Rules],
  ['[data-outlets]', Outlets],
  ['[data-share]', Share],
  ['[data-journal]', Journal],
];
for (const [selector, Section] of SECTIONS) new Section(document.querySelector(selector)).init();
new App(document.body).init();
