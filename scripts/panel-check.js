// Выражение для tests/showcase/cdp.mjs (Alter'а): войти в панель, обойти вкладки,
// проверить, что тик ОБНОВЛЯЕТ узлы, а не пересоздаёт их, что график
// перерисовывается от правки своей таблицы, и снять кадры.
// Пароль — из scripts/panel-smoke.ts.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  await sleep(800);
  document.querySelector('#login-password').value = 'smoke-password';
  document.querySelector('[data-login]').requestSubmit();
  await sleep(3000);
  out.appVisible = !document.querySelector('[data-view=app]').hidden;

  // Тот же ли узел через несколько тиков, и поменялось ли значение.
  const metric = document.querySelector('.metric__number');
  const row = document.querySelector('#panel-overview .list__item');
  const before = { metric: metric.textContent, row: row?.textContent };
  let rebuilt = 0;
  const watch = new MutationObserver((records) => { for (const r of records) rebuilt += [...r.removedNodes].filter((n) => n.nodeType === 1).length; });
  watch.observe(document.querySelector('#panel-overview'), { childList: true, subtree: true });
  await sleep(6500);
  watch.disconnect();
  out.sameMetricNode = metric.isConnected && metric === document.querySelector('.metric__number');
  out.sameRowNode = row?.isConnected ?? null;
  out.metricChanged = before.metric !== metric.textContent;
  out.removedElementsInOverview = rebuilt;

  // График — данными: правка ячейки → новый рисунок без нового узла.
  const fig = document.querySelector('.chart');
  const svg = fig?.querySelector('.chart__svg');
  const shape = () => [...(svg?.querySelectorAll('path') ?? [])].map((p) => p.getAttribute('d')).join('|');
  const was = shape();
  const cell = fig?.querySelector('tbody tr:last-child td');
  if (cell) cell.textContent = '9999';
  await sleep(400);
  out.chartEnhanced = fig?.classList.contains('chart_enhanced') ?? false;
  out.chartSameNode = fig === document.querySelector('.chart');
  out.chartRedrawn = was !== shape();

  for (const tab of ['devices', 'sites', 'outlets', 'journal']) {
    document.querySelector(`#tab-${tab}`).click();
    await sleep(2500);
    const panel = document.querySelector(`#panel-${tab}`);
    const first = panel.querySelector('.card');
    await sleep(4500);
    out[tab] = { visible: !panel.hidden, cards: panel.querySelectorAll('.card').length, sameFirstCard: first?.isConnected ?? null };
    await window.__cdp('shot', { path: `/tmp/panel-${tab}.png` });
  }
  return JSON.stringify(out, null, 1);
})()
