// Вопрос-лист (sheet_modal): нативный <dialog> в верхнем слое — ловушка фокуса,
// Esc и возврат фокуса от браузера. Здесь — только то, чего браузер не знает:
//   - закрыть — значит уехать вниз и только потом close(): Esc (cancel) и нажатие
//     мимо листа (подложка) уводят его движением, как смахивание пальцем;
//   - клавиатура: окно iOS под неё не ужимается (ужимается только видимая область),
//     и приклеенный к низу лист оказался бы под ней — поднимаем на её высоту.
//
// Крестика нет (владелец): отмена — смахнуть вниз, Esc с клавиатуры, нажатие по
// подложке; ответ ставит хозяин событием sheet:dismiss { value }.

/** Сколько видимой области закрыто снизу (клавиатурой): 0 — ничего. */
function keyboardLift() {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {{ dismiss(value: string): void, lift(px: number): void }} sheet
 */
export function attachModal(dialog, sheet) {
  const onViewport = () => sheet.lift(keyboardLift());
  const vv = window.visualViewport;

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    sheet.dismiss('');
  });
  // Щелчок по самому <dialog> — это подложка или место над свёрнутым листом:
  // вне выреза clip-path касания до содержимого не доходят.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) sheet.dismiss('');
  });
  dialog.addEventListener('close', () => {
    vv?.removeEventListener('resize', onViewport);
    vv?.removeEventListener('scroll', onViewport);
  });

  return {
    open() {
      if (!dialog.open) dialog.showModal();
      vv?.addEventListener('resize', onViewport);
      vv?.addEventListener('scroll', onViewport);
      onViewport();
    },
    close(value) {
      if (dialog.open) dialog.close(value);
    },
  };
}
