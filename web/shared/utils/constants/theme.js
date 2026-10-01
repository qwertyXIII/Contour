// Тема: схема, плотность, акцент. Значения совпадают с модификаторами блока theme.
export const THEME = {
  block: 'theme',
  storageKey: 'alter-ui:theme',
  // 'auto' — модификатора нет, решает система / устройство
  schemes: ['auto', 'dark', 'light'],
  densities: ['auto', 'touch', 'compact'],
  defaults: { scheme: 'auto', density: 'auto', accent: '#fe6344' },
  // theme:set с live: true (тянут пикер) запоминается и объявляется theme:change,
  // когда изменения затихли на столько мс — если «отпустили» так и не пришло.
  settleMs: 300,
};

// Готовые акценты витрины. Любой другой цвет — через свой образец.
export const ACCENT_PRESETS = [
  { name: 'Коралл', value: '#fe6344' },
  { name: 'Янтарь', value: '#ff9f0a' },
  { name: 'Лимон', value: '#ffd60a' },
  { name: 'Мята', value: '#30d158' },
  { name: 'Бирюза', value: '#40c8e0' },
  { name: 'Синий', value: '#0a84ff' },
  { name: 'Индиго', value: '#5e5ce6' },
  { name: 'Сирень', value: '#bf5af2' },
  { name: 'Малина', value: '#ff375f' },
  { name: 'Графит', value: '#8e8e93' },
];
