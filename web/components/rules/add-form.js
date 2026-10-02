// Новый список правил: по ссылке, файлом или вручную, с назначением «куда».
// Назначение — один выбор из готовых вариантов (страны и выходы — из данных);
// несколько стран или выходов сразу и разные назначения в одном файле — свой
// формат с разделами, справка — под формой.
import { h, svgIcon } from '../../utils/dom.js';
import { selectField } from '../../utils/select-field.js';
import { setHidden } from '../../utils/view.js';
import { FORMAT } from './views.js';

const KINDS = [['url', 'По ссылке'], ['file', 'Файлом'], ['manual', 'Вручную']];
const HELP = `# своё: разделы задают «куда» для строк ниже
[через: DE]
chatgpt.com
openai.com

[не через: RU, самый быстрый]
claude.ai

[только: corp_ext]
172.16.42.0/24

[напрямую]
gosuslugi.ru

[запретить]
ads.example.com`;

/** Варианты «куда»: значение — JSON действия без `fastest`. */
function targets(countries, outlets) {
  const v = (target) => JSON.stringify(target);
  return [
    { value: v({ kind: 'tunnel' }), text: 'Через туннель — как заблокированное' },
    { value: v({ kind: 'direct' }), text: 'Напрямую' },
    ...countries.map((c) => ({ value: v({ kind: 'country', country: c.code }), text: `Через страну: ${c.title}` })),
    ...countries.map((c) => ({ value: v({ kind: 'avoid', countries: [c.code] }), text: `Не через: ${c.title}` })),
    ...outlets.map((o) => ({ value: v({ kind: 'only', outlets: [o.name] }), text: `Только через выход ${o.name}` })),
    { value: v({ kind: 'reject' }), text: 'Запретить' },
  ];
}

export function addForm(onSubmit) {
  const kind = h('div', { class: 'segmented segmented_wide', role: 'radiogroup', 'aria-label': 'Откуда список' },
    KINDS.map(([value, text], i) => h('label', { class: 'segmented__option' },
      h('input', { class: 'segmented__input visually-hidden', type: 'radio', name: 'rules-kind', value, checked: i === 0 }),
      h('span', { class: 'segmented__label', text }))));
  const field = (label, control) => h('div', { class: 'field' }, h('div', { class: 'field__text' }, h('span', { class: 'field__label', text: label })), control);
  const title = h('input', { class: 'input__control', name: 'title', placeholder: 'Например, «ИИ-сервисы»', maxlength: '60', autocomplete: 'off' });
  const url = h('input', { class: 'input__control', name: 'url', placeholder: 'https://…', autocomplete: 'off', spellcheck: 'false' });
  const file = h('input', { class: 'input__control', name: 'file', type: 'file', accept: '.txt,.list,.conf,.yaml,.yml,text/plain' });
  const text = h('textarea', { class: 'textarea textarea_mono', name: 'text', rows: '6', placeholder: 'по одному в строке: имя сайта или подсеть', spellcheck: 'false' });
  const where = selectField('Куда');
  const format = selectField('Формат');
  format.update({ rulesFormat: '' }, Object.entries(FORMAT).map(([value, t]) => ({ value, text: t })), 'auto');
  const fastest = h('label', { class: 'checkbox' },
    h('input', { class: 'checkbox__input visually-hidden', type: 'checkbox', name: 'fastest' }),
    h('span', { class: 'checkbox__box', 'aria-hidden': 'true' }, svgIcon('check', 'checkbox__mark checkbox__mark_kind_check')),
    h('span', { class: 'checkbox__body' }, h('span', { class: 'checkbox__text', text: 'Самый быстрый' }), h('span', { class: 'checkbox__hint', text: 'среди выходов той же страны — по времени ответа сайта; страну не меняет' })));
  const urlField = field('Ссылка', h('div', { class: 'input' }, url));
  const fileField = field('Файл', h('div', { class: 'input' }, file));
  const textField = field('Сайты и подсети', text);
  const submit = h('button', { class: 'button button_view_primary', type: 'submit' }, svgIcon('plus', 'button__icon'), h('span', { class: 'button__text', text: 'Добавить список' }));
  const form = h('form', { class: 'card stack stack_gap_l' },
    h('header', { class: 'bar bar_size_s' }, h('span', { class: 'glyph glyph_tone_accent' }, svgIcon('plus')), h('div', { class: 'bar__text' },
      h('h3', { class: 'bar__title', text: 'Новый список' }), h('p', { class: 'bar__subtitle', text: 'готовый или свой' }))),
    kind, field('Название', h('div', { class: 'input' }, title)), urlField, fileField, textField,
    where.el, format.el, fastest,
    h('div', { class: 'cluster cluster_justify_end' }, submit),
    h('details', { class: 'stack stack_gap_s' }, h('summary', { class: 'text text_style_small text_tone_muted', text: 'Свой формат — разделы «куда»' }), h('pre', { class: 'code code_block', text: HELP })));
  const show = () => {
    const k = form.querySelector('input[name="rules-kind"]:checked').value;
    setHidden(urlField, k !== 'url');
    setHidden(fileField, k !== 'file');
    setHidden(textField, k !== 'manual');
  };
  kind.addEventListener('change', show);
  show();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const k = form.querySelector('input[name="rules-kind"]:checked').value;
      const target = JSON.parse(form.querySelector('[data-rules-where]')?.value ?? '{"kind":"tunnel"}');
      const body = { title: title.value, kind: k, format: form.querySelector('[data-rules-format]')?.value ?? 'auto', action: { target, fastest: form.elements.fastest.checked || undefined } };
      if (k === 'url') body.url = url.value.trim();
      if (k === 'manual') body.text = text.value;
      if (k === 'file') body.text = file.files[0] ? await file.files[0].text() : '';
      if (await onSubmit(body)) {
        form.reset();
        show();
      }
    })();
  });
  return {
    el: form,
    /** Страны и выходы из данных — варианты «куда». */
    set(countries, outlets) {
      where.update({ rulesWhere: '' }, targets(countries, outlets), JSON.stringify({ kind: 'tunnel' }));
    },
  };
}
