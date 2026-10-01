// Что витрина показывает в разделе «Основа». Имя токена = имя CSS-переменной.
// Значение не записано здесь, а читается из браузера: меняется с темой и плотностью.
export const TOKEN_GROUPS = {
  surfaces: {
    kind: 'color',
    names: ['--color-bg', '--color-bg-elevated', '--color-surface', '--color-surface-hover',
      '--color-surface-pressed', '--color-raised', '--color-well', '--color-overlay'],
  },
  lines: {
    kind: 'color',
    names: ['--color-fill-1', '--color-fill-2', '--color-fill-3', '--color-border',
      '--color-border-strong'],
  },
  text: {
    kind: 'color',
    names: ['--color-text', '--color-text-muted', '--color-text-faint', '--color-contrast',
      '--color-on-contrast'],
  },
  accent: {
    kind: 'color',
    names: ['--color-accent', '--color-accent-hover', '--color-accent-pressed', '--color-accent-soft',
      '--color-accent-line', '--color-accent-text', '--color-on-accent'],
  },
  status: {
    kind: 'color',
    names: ['--color-ok', '--color-ok-soft', '--color-danger', '--color-danger-soft', '--color-warn',
      '--color-warn-soft', '--color-info', '--color-info-soft'],
  },
  space: {
    kind: 'space',
    names: ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8',
      '--space-10', '--space-12', '--space-16'],
  },
  radius: {
    kind: 'radius',
    names: ['--radius-xs', '--radius-s', '--radius-m', '--radius-l', '--radius-xl', '--radius-2xl',
      '--radius-full'],
  },
  sizes: {
    kind: 'size',
    names: ['--control-h-s', '--control-h-m', '--control-h-l', '--hit-min', '--card-pad',
      '--row-pad-y', '--knob-size', '--switch-h'],
  },
  shadows: {
    kind: 'shadow',
    names: ['--shadow-s', '--shadow-m', '--shadow-l'],
  },
};

// Роли текста: класс блока text и переменная кегля.
export const TYPE_STYLES = [
  { style: 'figure', token: '--text-figure', sample: '77.9' },
  { style: 'hero', token: '--text-hero', sample: 'Твой день почти собран' },
  { style: 'display', token: '--text-display', sample: 'Alter' },
  { style: 'title', token: '--text-title', sample: 'Разговоры от моего имени' },
  { style: 'heading', token: '--text-heading', sample: 'Кто ведёт разговор' },
  { style: 'message', token: '--text-message', sample: 'В 19:00 ужин с мамой, выехать стоит в 18:20.' },
  { style: 'lead', token: '--text-lead', sample: 'Заголовок строки и подпись поля' },
  { style: 'body', token: '--text-body', sample: 'Основной текст: пояснения, переписка, портрет человека.' },
  { style: 'small', token: '--text-small', sample: 'Подсказка под полем и мета строки' },
  { style: 'caption', token: '--text-caption', sample: 'МЕТКИ · БЕЙДЖИ · ПОДПИСИ' },
  { style: 'mono', token: '--text-small', sample: 'calendar_create_event · 1.8 с' },
];
