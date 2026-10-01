// Вопрос «точно?» диалогом dlg-confirm: необратимое — не одним нажатием.
export function confirmDialog(title, text, yes = 'Да') {
  const dlg = document.getElementById('dlg-confirm');
  dlg.querySelector('[data-confirm-title]').textContent = title;
  dlg.querySelector('[data-confirm-text]').textContent = text;
  dlg.querySelector('[data-confirm-yes]').textContent = yes;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true }));
}
