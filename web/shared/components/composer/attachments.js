// Файлы строки ввода: скрепка в поле открывает нативный выбор (<input type="file"
// multiple> без ограничения вида — iPhone сам предложит «Фото», «Снять», «Файлы»),
// выбранное встаёт превью в полосу над полем и сразу просится в закачку
// (composer:upload). Ход, «закачан» и «не ушло» сообщает хозяин событиями — строка
// только рисует и помнит номера. Сервера она не знает, как и запись голосового
// (ADR-0072 Alter'а): закачивает хозяин, помощник — components/composer/uploads.js.
//
// Пределы — ATTACH.maxFiles за раз и ATTACH.maxBytes на файл: сверх — отказ словами
// сразу (toast:show), без закачки. Превью из разметки (витрина, черновик) строка
// принимает как есть: состояние — по модификаторам, номер — data-id, имя — data-name.
import { ATTACH, EVENTS, QUERIES } from '../../utils/constants.js';
import { emit, h, uid } from '../../utils/dom.js';
import { buildPreview, formatSize } from './preview.js';

const STATUS = { uploading: 'uploading', done: 'done', failed: 'failed' };

export class Attachments {
  #root;
  #button;
  #onChange;
  #picker;
  #strip;
  /** key → { el, key, file, kind, name, url, id, status } — в порядке полосы. */
  #items = new Map();

  /** onChange() — что-то сменилось: число файлов, закачка, отказ. */
  constructor(root, onChange) {
    this.#root = root;
    this.#button = root.querySelector('.composer__attach');
    this.#onChange = onChange;
  }

  init() {
    // Выбор — вне поля: щелчок по нему, всплыв до input, поставил бы фокус в текст
    // (компонент Input) — и на iPhone поднял бы клавиатуру поверх выбора файлов.
    this.#picker = this.#root.querySelector('.composer__picker') ?? this.#mount(h('input', {
      class: 'visually-hidden composer__picker', type: 'file', multiple: true, tabindex: '-1', 'aria-hidden': 'true',
    }), 'append');
    this.#strip = this.#root.querySelector('.composer__attachments')
      ?? this.#mount(h('ul', { class: 'composer__attachments', 'aria-label': ATTACH.text.list }), 'prepend');
    this.#strip.querySelectorAll('.composer__attachment').forEach((el) => this.#adopt(el));
    this.#button.addEventListener('click', () => this.#picker.click());
    this.#picker.addEventListener('change', () => {
      const files = [...(this.#picker.files ?? [])];
      // Тот же файл можно выбрать снова — убрали и передумали.
      this.#picker.value = '';
      this.add(files);
    });
    this.#strip.addEventListener('click', (event) => this.#onClick(event));
    const on = (name, handle) => this.#root.addEventListener(name, (event) => {
      const item = this.#items.get(event.detail?.key);
      if (item) handle(item, event.detail);
    });
    on(EVENTS.composerUploadProgress, (item, { progress }) => this.#progress(item, progress));
    on(EVENTS.composerUploadDone, (item, { id }) => this.#done(item, id));
    on(EVENTS.composerUploadFail, (item, { error }) => this.#fail(item, error));
    return this;
  }

  get count() { return this.#items.size; }

  get uploading() { return this.#some(STATUS.uploading); }

  get failed() { return this.#some(STATUS.failed); }

  /** Что уходит с репликой — закачанное, по порядку полосы. */
  get sent() {
    return [...this.#items.values()].filter((item) => item.status === STATUS.done && item.id)
      .map(({ id, kind, name, file }) => ({ id, kind, name, size: file?.size ?? null, file }));
  }

  /** Приложить файлы: что сверх пределов — отказ словами, остальное — в закачку. */
  add(files) {
    const fits = files.filter((file) => file.size <= ATTACH.maxBytes);
    const big = files.filter((file) => file.size > ATTACH.maxBytes);
    const taken = fits.slice(0, Math.max(0, ATTACH.maxFiles - this.#items.size));
    const refusals = [];
    if (big.length) refusals.push(ATTACH.text.tooBig(formatSize(ATTACH.maxBytes), big.map((file) => `«${file.name}»`)));
    if (fits.length > taken.length) refusals.push(ATTACH.text.tooMany(ATTACH.maxFiles, fits.length - taken.length));
    if (refusals.length) emit(this.#root, EVENTS.toastShow, { text: refusals.join('. '), tone: 'warn' });
    if (!taken.length) return;
    for (const file of taken) {
      const key = uid('attach');
      const { el, url, kind, name } = buildPreview(key, file);
      const item = { el, key, file, kind, name, url, id: null, status: STATUS.uploading };
      this.#items.set(key, item);
      this.#strip.append(el);
      emit(this.#root, EVENTS.composerUpload, { key, file });
    }
    this.#strip.scrollTo({ left: this.#strip.scrollWidth, behavior: matchMedia(QUERIES.reducedMotion).matches ? 'auto' : 'smooth' });
    this.#onChange();
  }

  /** Убрать всё (реплика ушла, строку очистили): незакачанное — бросить. */
  clear() {
    if (!this.#items.size) return;
    for (const item of [...this.#items.values()]) this.#drop(item, false);
    this.#onChange();
  }

  #mount(el, where) {
    this.#root[where](el);
    return el;
  }

  #some(status) {
    for (const item of this.#items.values()) if (item.status === status) return true;
    return false;
  }

  #adopt(el) {
    const key = el.dataset.key || uid('attach');
    el.dataset.key = key;
    let status = STATUS.done;
    if (el.classList.contains(ATTACH.uploading)) status = STATUS.uploading;
    if (el.classList.contains(ATTACH.failed)) status = STATUS.failed;
    const kind = ['photo', 'video', 'file'].find((name) => el.classList.contains(ATTACH.kind(name))) ?? 'file';
    this.#items.set(key, { el, key, file: null, kind, name: el.dataset.name ?? '', url: null, id: el.dataset.id || null, status });
  }

  #onClick(event) {
    const el = event.target.closest('.composer__attachment');
    const item = el && this.#items.get(el.dataset.key);
    if (!item) return;
    if (event.target.closest('.composer__remove')) this.#remove(item);
    else if (event.target.closest('.composer__retry') && item.status === STATUS.failed) this.#retry(item);
  }

  // Убрали своей рукой: фокус — соседу (или скрепке), иначе он пропал бы вместе с превью.
  #remove(item) {
    const focused = item.el.contains(document.activeElement);
    const next = item.el.nextElementSibling ?? item.el.previousElementSibling;
    this.#drop(item, true);
    if (focused) (next?.querySelector('.composer__remove') ?? this.#button).focus();
    this.#onChange();
  }

  // Закачанный, убранный своей рукой, — тоже хозяину (с номером: может сказать серверу);
  // после отправки (clear) закачанное ушло с репликой — его не бросают.
  #drop(item, byHand) {
    if (item.status !== STATUS.done || byHand) emit(this.#root, EVENTS.composerUploadAbort, { key: item.key, id: item.id ?? undefined });
    item.el.remove();
    if (item.url) URL.revokeObjectURL(item.url);
    this.#items.delete(item.key);
  }

  #retry(item) {
    this.#set(item, STATUS.uploading);
    this.#progress(item, 0);
    emit(this.#root, EVENTS.composerUpload, { key: item.key, file: item.file });
    this.#onChange();
  }

  #progress(item, value) {
    if (item.status !== STATUS.uploading) return;
    const share = Math.min(1, Math.max(0, Number(value) || 0));
    const bar = item.el.querySelector('.composer__progress');
    bar?.style.setProperty('--progress', share.toFixed(3));
    bar?.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  }

  #done(item, id) {
    if (item.status !== STATUS.uploading) return;
    item.id = id ? String(id) : null;
    // Сервер не дал номера — отправлять нечего: это тоже «не ушло».
    if (!item.id) { this.#fail(item, ''); return; }
    this.#set(item, STATUS.done);
    this.#onChange();
  }

  #fail(item, error) {
    if (item.status !== STATUS.uploading) return;
    this.#set(item, STATUS.failed);
    const reason = error ? `${ATTACH.text.failed}: ${error}` : ATTACH.text.failed;
    const retry = item.el.querySelector('.composer__retry');
    retry?.setAttribute('title', reason);
    retry?.setAttribute('aria-label', `${ATTACH.text.retry(item.name)}. ${reason}`);
    emit(this.#root, EVENTS.toastShow, { text: `${ATTACH.text.failed} «${item.name}»${error ? `: ${error}` : ''}`, tone: 'danger' });
    this.#onChange();
  }

  #set(item, status) {
    item.status = status;
    item.el.classList.toggle(ATTACH.uploading, status === STATUS.uploading);
    item.el.classList.toggle(ATTACH.failed, status === STATUS.failed);
  }
}
