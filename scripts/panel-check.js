// Выражение для tests/showcase/cdp.mjs (Alter'а): войти в панель, обойти вкладки,
// вернуть, что видно, и снять кадры. Пароль — из scripts/panel-smoke.ts.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  await sleep(800);
  out.loginVisible = !document.querySelector('[data-view=login]').hidden;
  document.querySelector('#login-password').value = 'smoke-password';
  document.querySelector('[data-login]').requestSubmit();
  await sleep(2500);
  out.appVisible = !document.querySelector('[data-view=app]').hidden;
  out.headline = document.querySelector('[data-headline]').textContent;
  out.metrics = [...document.querySelectorAll('.metric__number')].map((e) => e.textContent);
  out.chart = !!document.querySelector('.chart_enhanced, .chart svg');
  await window.__cdp('shot', { path: '/tmp/panel-overview.png' });
  for (const tab of ['devices', 'sites', 'outlets', 'journal']) {
    document.querySelector(`#tab-${tab}`).click();
    await sleep(2500);
    const panel = document.querySelector(`#panel-${tab}`);
    out[tab] = { visible: !panel.hidden, rows: panel.querySelectorAll('.row, .card').length, text: panel.textContent.replace(/\s+/g, ' ').slice(0, 220) };
    await window.__cdp('shot', { path: `/tmp/panel-${tab}.png` });
  }
  document.querySelector('[data-act=add]')?.click();
  await sleep(600);
  out.addDialogOpen = document.querySelector('#dlg-outlet').open;
  await window.__cdp('shot', { path: '/tmp/panel-add.png' });
  return JSON.stringify(out, null, 1);
})()
