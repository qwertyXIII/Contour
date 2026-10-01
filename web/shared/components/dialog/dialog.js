// Диалог поверх экрана на нативном <dialog>: фокус, Esc и возврат фокуса —
// от браузера. Здесь только закрытие по подложке и по __close, и открытие
// кнопкой с data-dialog-open="<id диалога>" — кнопка ничего не знает о классе.
export class Dialog {
  #dialog;

  constructor(dialog) {
    this.#dialog = dialog;
  }

  init() {
    this.#dialog.addEventListener('click', (event) => {
      const onBackdrop = event.target === this.#dialog;
      if (onBackdrop || event.target.closest('.dialog__close')) this.close();
    });
    if (this.#dialog.id) {
      document.addEventListener('click', (event) => {
        if (event.target.closest(`[data-dialog-open="${this.#dialog.id}"]`)) this.open();
      });
    }
    return this;
  }

  open() {
    if (!this.#dialog.open) this.#dialog.showModal();
  }

  close(returnValue = '') {
    this.#dialog.close(returnValue);
  }
}
