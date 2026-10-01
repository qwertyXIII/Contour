// Диалог «Новый выход»: имя, что добавить, ключ текстом или файлом, приоритет.
// Ключ уходит помощнику от root, тот проверяет сам; ошибка — его словами в диалоге.
import { api } from '../../utils/api.js';
import { API, EVENTS, SOURCE_HINTS } from '../../utils/constants.js';

export class AddOutlet {
  #dialog;
  #form;
  #error;

  constructor(dialog) {
    this.#dialog = dialog;
    this.#form = dialog.querySelector('[data-outlet-form]');
    this.#error = dialog.querySelector('[data-outlet-error]');
  }

  init() {
    this.#form.addEventListener('change', (e) => {
      if (e.target.name === 'source') this.#hint();
      if (e.target.name === 'file') void this.#readFile(e.target.files?.[0]);
    });
    this.#form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.#submit();
    });
    this.#dialog.addEventListener('close', () => { this.#error.hidden = true; });
    this.#hint();
    return this;
  }

  open() {
    this.#form.reset();
    this.#hint();
    this.#dialog.showModal();
  }

  #hint() {
    this.#dialog.querySelector('[data-source-hint]').textContent = SOURCE_HINTS[this.#form.elements.source.value] ?? '';
  }

  async #readFile(file) {
    if (!file) return;
    if (file.size > 200_000) { this.#fail('файл больше 200 КБ — это не ключ'); return; }
    this.#form.elements.text.value = await file.text();
    if (/\.ovpn$/i.test(file.name)) this.#form.querySelector('[name=source][value=ovpn]').click();
    if (!this.#form.elements.name.value) this.#form.elements.name.value = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
  }

  #fail(text) {
    this.#error.textContent = text;
    this.#error.hidden = false;
  }

  async #submit() {
    const f = this.#form.elements;
    const submit = this.#form.querySelector('[data-outlet-submit]');
    submit.classList.add('button_loading');
    submit.disabled = true;
    try {
      const data = await api(API.outlets, {
        method: 'POST',
        timeout: 120_000,
        body: { name: f.name.value.trim(), source: f.source.value, text: f.text.value, priority: Number(f.priority.value) || 50 },
      });
      this.#dialog.close();
      document.dispatchEvent(new CustomEvent(EVENTS.restart, { detail: { text: `Выход «${f.name.value}» добавлен: ${data.about}. Contour перезапускается…` } }));
    } catch (error) {
      this.#fail(error.message);
    } finally {
      submit.classList.remove('button_loading');
      submit.disabled = false;
    }
  }
}
