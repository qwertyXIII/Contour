// Кто рисует карту. Провайдер — функция create(контейнер, { theme, center, zoom })
// → { setView, setMarkers, setRoute, setTheme, destroy, attribution?, drawRoute? };
// его регистрирует index.js (в приложении — объявление пакета). Блок map знает
// только имя из data-provider: сменить провайдера — сменить имя, блоки и
// метки остаются те же.
//
// drawRoute(доля 0…1) — необязательно: показать линию маршрута до этой доли
// пути. Есть — маршрут появляется, проводясь от начала к концу (время ведёт
// блок map); нет — линия просто стоит, метки всё равно падают по очереди.
const providers = new Map();

export function registerMapProvider(name, create) {
  providers.set(name, create);
}

export function mapProvider(name) {
  return providers.get(name) ?? null;
}
