// Запуск дизайн-системы — один на все страницы: витрину, приложение, потом ТВ.
// Список COMPONENTS — единственный: компоненты создаются только отсюда, через
// upgrade(), и оживает даже разметка, которая появится позже (ADR-0009 системы).
// Порядок запуска значим — он записан в startSystem.
import { Theme } from './components/theme/theme.js';
import { MotionIcon } from './components/icon/icon.js';
import { Range } from './components/range/range.js';
import { Stepper } from './components/stepper/stepper.js';
import { Input } from './components/input/input.js';
import { Dialog } from './components/dialog/dialog.js';
import { Sheet } from './components/sheet/sheet.js';
import { SheetVoice } from './components/sheet/voice.js';
import { Tabs } from './components/tabs/tabs.js';
import { Toaster } from './components/toaster/toaster.js';
import { Chip } from './components/chip/chip.js';
import { Composer } from './components/composer/composer.js';
import { SpringyMessages } from './components/messages/springy.js';
import { Select } from './components/select/select.js';
import { Menu } from './components/menu/menu.js';
import { CheckboxGroup } from './components/checkbox-group/checkbox-group.js';
import { Fader } from './components/fader/fader.js';
import { Segmented } from './components/segmented/segmented.js';
import { Datestrip } from './components/datestrip/datestrip.js';
import { Bars } from './components/bars/bars.js';
import { Dial } from './components/dial/dial.js';
import { SlideConfirm } from './components/slide-confirm/slide-confirm.js';
import { Widgets } from './components/widgets/widgets.js';
import { Chart } from './components/chart/chart.js';
import { Heatmap } from './components/heatmap/heatmap.js';
import { Media } from './components/media/media.js';
import { Video } from './components/video/video.js';
import { Viewer } from './components/viewer/viewer.js';
import { AudioSession } from './components/player/session.js';
import { Player } from './components/player/player.js';
import { MapView } from './components/map/map.js';
import { Screens } from './components/screens/screens.js';
import { ScreenTabs } from './components/screen-tabs/screen-tabs.js';
import { ColorPicker } from './components/color-picker/color-picker.js';
import { Scroller } from './components/scroller/scroller.js';
import { Masthead } from './components/masthead/masthead.js';
import { Skeletons } from './components/skeleton/skeleton.js';
import { UnseenMotion } from './components/unseen-motion/unseen-motion.js';
import { Reveal } from './components/reveal/reveal.js';
import { Sticky } from './components/sticky/sticky.js';
import { OrbStage } from './components/orb-stage/orb-stage.js';
import { createSchematicMap } from './components/map/schematic.js';
import { ICON_MOTION } from './utils/constants.js';
import { upgrade } from './utils/upgrade.js';
import { registerMapProvider } from './utils/map-providers.js';

// Блоки дизайн-системы: селектор → компонент. Оживают и те, что появятся
// позже (слайды просмотра, ответ сервера) — см. utils/upgrade.js.
export const COMPONENTS = [
  [ICON_MOTION.selector, MotionIcon],
  ['.range', Range],
  ['.stepper', Stepper],
  ['.input', Input],
  ['.dialog', Dialog],
  ['.sheet_live', Sheet],
  // Голос в панели разговора — после листа: ход панели уже живой (ADR-0072 Alter'а).
  ['.sheet__voice', SheetVoice],
  ['.tabs', Tabs],
  ['.chip_removable', Chip],
  ['.composer', Composer],
  ['.messages_springy', SpringyMessages],
  ['.select', Select],
  ['.menu', Menu],
  ['.checkbox-group', CheckboxGroup],
  ['.fader', Fader],
  ['.segmented', Segmented],
  ['.datestrip', Datestrip],
  ['.bars', Bars],
  ['.dial', Dial],
  ['.slide-confirm', SlideConfirm],
  ['.widgets', Widgets],
  ['.chart', Chart],
  ['.heatmap', Heatmap],
  ['.media', Media],
  ['.video', Video],
  // Сеанс — раньше видов: вид при появлении просит у него состояние.
  ['audio[data-session]', AudioSession],
  ['.player', Player],
  ['.map', MapView],
  // Пейджер — раньше пилюль: пилюли при запуске встают на его экран.
  ['.screens', Screens],
  ['.screen-tabs', ScreenTabs],
  ['.color-picker', ColorPicker],
  ['.scroller', Scroller],
  ['.masthead', Masthead],
  ['.sticky_shy', Sticky],
  ['[data-reveal]', Reveal],
  ['.orb-stage', OrbStage],
];

/**
 * Поднять систему на странице.
 *
 * - тема — первой: до неё страница нарисована в системной схеме;
 * - `beforeComponents` — то, что должно случиться раньше компонентов
 *   (витрина копирует шаблоны: иначе копии остались бы без поведения);
 * - слои — по одному на страницу; нет разметки — строят её сами;
 * - заготовки — по `aria-busy="true"` где угодно;
 * - бесконечное движение вне экрана стоит — тоже на всей странице.
 */
export function startSystem(root = document.body, { beforeComponents } = {}) {
  // Провайдеры карты — по имени; блок map знает только имя из data-provider.
  // Остальные объявляют пакеты: движок не знает сервисов по имени.
  registerMapProvider('schematic', createSchematicMap);
  new Theme(document.documentElement).init();
  beforeComponents?.();
  new Toaster(document.querySelector('.toaster') ?? Toaster.mount()).init();
  new Viewer(document.querySelector('.viewer') ?? Viewer.mount()).init();
  new Skeletons(root).init();
  new UnseenMotion(document).init();
  upgrade(root, COMPONENTS);
}
