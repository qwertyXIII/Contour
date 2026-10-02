import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SpeedProbe } from '../src/select/speed-probe.ts';
import type { Candidate } from '../src/select/speed-rank.ts';
import { PROBE_SERVICE, SpeedBook, type SpeedTuning } from '../src/select/speed.ts';
import { median, quantile } from '../src/select/speed-window.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });
const T0 = Date.now();
const MB = 1_000_000;

function book(tuning: Partial<SpeedTuning> = {}, file = path.join(mkdtempSync(path.join(tmpdir(), 'contour-speed-')), 'speed.json')): SpeedBook {
  return new SpeedBook({ file, log: quiet, tuning });
}

const cand = (name: string, latencyMs: number | null = null, state: Candidate['state'] = 'alive'): Candidate => ({ name, latencyMs, state });
const names = (order: readonly Candidate[]): string[] => order.map((c) => c.name);

/** `n` замеров TTFB подряд, по секунде между ними. */
function feed(b: SpeedBook, service: string, outlet: string, values: number[], at = T0): void {
  values.forEach((v, i) => b.noteTtfb(service, outlet, v, at - (values.length - i) * 1000));
}
const times = (n: number, v: number): number[] => Array.from({ length: n }, () => v);

test('медиана окна не замечает выбросов; запредельный TTFB — не замер', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([], 0.5), null);

  const b = book();
  // 10 нормальных и 4 «сайт задумался» — EWMA увело бы далеко, медиана — нет.
  feed(b, 'openai', 'de', [...times(10, 100), 3000, 2500, 4000, 3500]);
  feed(b, 'openai', 'nl', times(14, 160));
  b.noteTtfb('openai', 'de', 60_000, T0); // долгий опрос — меряет сайт, а не дорогу
  const r = b.rank('openai', [cand('de'), cand('nl')], 'de', { now: T0 });
  assert.equal(r.leader, 'de');
  assert.match(r.reason, /TTFB openai: «nl» 160 мс, «de» 100 мс/);
  assert.equal(b.snapshot(T0).de?.ttfbCount, 14, 'запредельный замер не записан');
});

test('данных мало — по выходу в целом (по общим сервисам), затем по задержке', () => {
  const b = book();
  // Этот сервис меряли только через de — сравнить по нему нельзя.
  feed(b, 'openai', 'de', times(8, 200));
  // Три общих сервиса: через nl везде вдвое быстрее.
  for (const s of ['a.com', 'b.com', 'c.com']) {
    feed(b, s, 'de', times(6, 300));
    feed(b, s, 'nl', times(6, 150));
  }
  const byOutlet = b.rank('openai', [cand('de', 50), cand('nl', 90)], 'de', { now: T0 });
  assert.equal(byOutlet.leader, 'nl', 'по общим сервисам, а не по задержке');
  assert.match(byOutlet.reason, /быстрее «de» на 50%: TTFB по 3 общим сервисам/);

  // Сырые медианы выходов сильно разные, но общих сервисов нет — сравнивать их нельзя: только задержка.
  const c = book();
  feed(c, 'slow.example', 'de', times(10, 900));
  feed(c, 'fast.example', 'nl', times(10, 50));
  const byLatency = c.rank('openai', [cand('de', 40), cand('nl', 120)], 'de', { now: T0 });
  assert.equal(byLatency.leader, 'de');
  assert.match(byLatency.reason, /задержка: «nl» 120 мс, «de» 40 мс/);

  const none = c.rank('openai', [cand('x'), cand('y')], null, { now: T0 });
  assert.deepEqual(names(none.order), ['x', 'y']);
  assert.match(none.reason, /данных о скорости нет/);
  assert.equal(none.switched, false);
});

test('гистерезис: уходим от текущего только при заметном выигрыше и обратно не прыгаем', () => {
  const b = book();
  feed(b, 's', 'de', times(10, 200));
  feed(b, 's', 'nl', times(10, 170));
  const small = b.rank('s', [cand('de'), cand('nl')], 'de', { now: T0 });
  assert.equal(small.leader, 'de', 'на 15% — мало');
  assert.equal(small.switched, false);
  assert.match(small.reason, /остаёмся на «de»: «nl» быстрее лишь на 15%.*нужно от 25%/);
  assert.equal(b.rank('s', [cand('de'), cand('nl')], null, { now: T0 }).leader, 'nl', 'без текущего — первый выбор, порог только в мс');

  feed(b, 's', 'nl', times(10, 120), T0 + 60_000);
  const big = b.rank('s', [cand('de'), cand('nl')], 'de', { now: T0 + 60_000 });
  assert.equal(big.leader, 'nl');
  assert.equal(big.switched, true);
  assert.match(big.reason, /«nl» быстрее «de» на 40%: TTFB s: «nl» 120 мс, «de» 200 мс/);
  assert.deepEqual(names(big.order), ['nl', 'de']);

  // Теперь текущий nl; de подтянулся почти вровень — назад не прыгаем.
  feed(b, 's', 'de', times(10, 130), T0 + 120_000);
  const back = b.rank('s', [cand('de'), cand('nl')], 'nl', { now: T0 + 120_000 });
  assert.equal(back.leader, 'nl');
  assert.equal(back.switched, false);

  // 30%, но 12 мс — шум.
  const c = book();
  feed(c, 's', 'de', times(10, 40));
  feed(c, 's', 'nl', times(10, 28));
  assert.equal(c.rank('s', [cand('de'), cand('nl')], 'de', { now: T0 }).leader, 'de');
});

test('задержка — медиана последних проверок: один всплеск не перекидывает', () => {
  const b = book();
  const de = (at: number, ms: number): Candidate => ({ name: 'de', state: 'alive', latencyMs: ms, checkedAt: at, failures: 0 });
  const nl = (at: number, ms: number): Candidate => ({ name: 'nl', state: 'alive', latencyMs: ms, checkedAt: at, failures: 0 });
  for (let i = 0; i < 5; i += 1) b.rank('s', [de(T0 + i * 10_000, 100), nl(T0 + i * 10_000, 60)], 'de', { now: T0 + i * 10_000 });
  assert.equal(b.rank('s', [de(T0 + 50_000, 100), nl(T0 + 50_000, 60)], 'de', { now: T0 + 50_000 }).leader, 'nl');
  // Всплеск у nl на одной проверке — уже текущий, остаётся.
  const spike = b.rank('s', [de(T0 + 60_000, 100), nl(T0 + 60_000, 300)], 'nl', { now: T0 + 60_000 });
  assert.equal(spike.leader, 'nl');
  // Проваленная проверка (`failures`) — прошлая задержка, в окно не идёт.
  const failed = { ...nl(T0 + 70_000, 60), failures: 1 };
  b.rank('s', [de(T0 + 70_000, 100), failed], 'nl', { now: T0 + 70_000 });
  assert.equal(b.rank('s', [de(T0 + 80_000, 100), nl(T0 + 60_000, 300)], 'nl', { now: T0 + 80_000 }).leader, 'nl');
});

test('скорость — только по большим рывкам без задержки со стороны клиента', () => {
  const b = book();
  const chunk = 64 * 1024;
  // Маленький ответ: 300 КБ — меряет задержку, не канал.
  const small = b.flow('de');
  for (let i = 0; i < 5; i += 1) small.data(chunk, T0 + i * 10);
  small.end();
  assert.equal(b.passiveCount('de', T0), 0);

  // 3 МБ за ~1 с, потом пауза 2 с (рывок кончился), ещё 3 МБ.
  const big = b.flow('de');
  for (let i = 0; i <= 48; i += 1) big.data(chunk, T0 + i * 20);
  for (let i = 0; i <= 48; i += 1) big.data(chunk, T0 + 3000 + i * 20);
  big.end();
  assert.equal(b.passiveCount('de', T0 + 5000), 2, 'два рывка — два замера');
  const mbps = b.snapshot(T0 + 5000).de?.mbps ?? 0;
  assert.ok(mbps > 25 && mbps < 27, `≈ 26 Мбит/с без первого куска, вышло ${mbps}`);

  // Клиент не успевал — relay останавливал выход: рывок меряет клиента.
  const slow = b.flow('de');
  for (let i = 0; i <= 48; i += 1) { slow.data(chunk, T0 + 10_000 + i * 20); if (i === 10) slow.paused(); }
  slow.end();
  assert.equal(b.passiveCount('de', T0 + 12_000), 2);

  // Напрямую — те же пороги.
  b.noteTransfer('de', 200_000, 2000, T0);
  b.noteTransfer('de', 5 * MB, 100, T0);
  assert.equal(b.passiveCount('de', T0 + 12_000), 2);
});

test('скорость вторым критерием: запрещает медленный канал и решает при равной задержке', () => {
  const b = book();
  feed(b, 's', 'de', times(10, 200));
  feed(b, 's', 'nl', times(10, 120));
  b.noteTransfer('de', 10 * MB, 1000, T0); // 80 Мбит/с
  b.noteTransfer('nl', 2 * MB, 1000, T0); // 16 Мбит/с — отвечает быстро, качает плохо
  const veto = b.rank('s', [cand('de'), cand('nl')], 'de', { now: T0 });
  assert.equal(veto.leader, 'de');
  assert.match(veto.reason, /«nl» отвечает быстрее на 40%.*но качает медленнее — 16 Мбит\/с против 80 Мбит\/с/);

  const c = book();
  feed(c, 's', 'de', times(10, 100));
  feed(c, 's', 'nl', times(10, 110));
  for (let i = 0; i < 3; i += 1) {
    c.noteTransfer('de', 2 * MB, 1000, T0 - i);
    c.noteTransfer('nl', 8 * MB, 1000, T0 - i);
  }
  const pull = c.rank('s', [cand('de'), cand('nl')], 'de', { now: T0 });
  assert.equal(pull.leader, 'nl');
  assert.match(pull.reason, /«nl» качает быстрее «de» в 4 раза: 64 Мбит\/с против 16 Мбит\/с/);
});

test('группы не смешиваются, мёртвые — в конце; текущий негодный — гистерезиса нет', () => {
  const b = book();
  feed(b, 's', 'cut', times(10, 50));
  feed(b, 's', 'pass', times(10, 200));
  feed(b, 's', 'pass2', times(10, 160));
  const list = [cand('cut'), cand('pass'), cand('gone', null, 'dead'), cand('pass2')];
  const tier = (c: Candidate): number => (c.name === 'cut' ? 3 : 0);
  const r = b.rank('s', list, 'pass', { now: T0, tier });
  assert.deepEqual(names(r.order), ['pass', 'pass2', 'cut', 'gone'], 'режущий порт не обгоняет, хоть и быстрее; 160 против 200 — мало');

  const lost = b.rank('s', [cand('pass'), cand('pass2'), cand('cut', null, 'dead')], 'cut', { now: T0 });
  assert.equal(lost.leader, 'pass2');
  assert.equal(lost.switched, true);
  assert.match(lost.reason, /^«cut» сейчас не годится — /);
});

test('проба: только где пассивных данных мало, по одному выходу и не чаще срока', async () => {
  const b = book();
  for (let i = 0; i < 3; i += 1) b.noteTransfer('busy', 4 * MB, 1000, T0 - i);
  const outlets = [
    { name: 'busy', state: 'alive' as const },
    { name: 'idle1', state: 'alive' as const },
    { name: 'idle2', state: 'alive' as const },
    { name: 'down', state: 'dead' as const },
    { name: 'spare', state: 'standby' as const },
  ];
  const calls: string[] = [];
  let release: (() => void) | null = null;
  const download = (name: string, bytes: number) => {
    calls.push(name);
    return new Promise<{ bytes: number; ms: number; firstByteMs: number }>((resolve, reject) => {
      if (name === 'idle2') { reject(new Error('выход не отвечает')); return; }
      release = () => resolve({ bytes, ms: 1000, firstByteMs: 90 });
    });
  };
  const probe = new SpeedProbe(b, { download, outlets: () => outlets, log: quiet, everyMs: 6 * 3_600_000, bytes: 2 * MB });

  const first = probe.tick(T0);
  assert.equal(await probe.tick(T0), null, 'пока одна проба идёт — вторую не начинаем');
  (release as unknown as () => void)();
  assert.equal(await first, 'idle1');
  assert.equal(b.snapshot(T0).idle1?.mbps, 16);
  assert.equal(b.snapshot(T0).idle1?.probes, 1);
  assert.equal(b.snapshot(T0).idle1?.ttfbCount, 1, `TTFB пробы — под ${PROBE_SERVICE}`);

  assert.equal(await probe.tick(T0 + 1000), 'idle2', 'следующий — другой выход');
  assert.equal(await probe.tick(T0 + 2000), null, 'busy — пассивных данных хватает, мёртвый и запасной — не пробуем, остальные — в сроке');
  assert.deepEqual(calls, ['idle1', 'idle2']);
  assert.equal(b.probedAt('idle2'), T0 + 1000, 'неудачная проба тоже отодвигает следующую');

  const again = probe.tick(T0 + 6 * 3_600_000 + 1);
  (release as unknown as () => void)();
  assert.equal(await again, 'idle1', 'срок вышел — давно пробованный первым');
});

test('хранение: переживает перезапуск, битый файл — пустая книга, старое и лишнее выбрасывается', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-speed-'));
  const file = path.join(dir, 'speed.json');
  const a = book({}, file);
  feed(a, 's', 'de', times(6, 200));
  feed(a, 's', 'nl', times(6, 100));
  a.noteTransfer('de', 4 * MB, 1000, T0);
  a.markProbed('nl', T0);
  a.stop();
  assert.ok(existsSync(file));

  const b = book({}, file);
  assert.equal(b.rank('s', [cand('de'), cand('nl')], 'de', { now: T0 }).leader, 'nl');
  assert.equal(b.passiveCount('de', T0), 1);
  assert.equal(b.probedAt('nl'), T0);
  assert.equal(b.snapshot(T0).de?.services, 1);

  writeFileSync(file, '{не json');
  assert.deepEqual(book({}, file).snapshot(T0), {});

  const old = T0 - 10 * 86_400_000;
  writeFileSync(file, JSON.stringify({
    outlets: { de: { ttfb: [[100, T0], 'мусор', [5, 'вчера'], [-1, T0], [300, old]], transfers: 5, probedAt: 'никогда' }, nl: 7 },
    services: { s: { de: [[100, T0], [200, old]], nl: 'x' }, empty: { de: [[1, old]] } },
  }));
  const c = book({}, file);
  const snap = c.snapshot(T0);
  assert.deepEqual(Object.keys(snap), ['de']);
  assert.equal(snap.de?.ttfbCount, 1, 'годный и свежий — один');
  assert.equal(snap.de?.services, 1);
  assert.equal(snap.de?.probedAt, null);

  const capped = book({ maxServices: 10 });
  for (let i = 0; i < 25; i += 1) capped.noteTtfb(`site${i}.com`, 'de', 100, T0 + i);
  assert.equal(capped.snapshot(T0 + 100).de?.services, 10, 'сервисов не больше предела');
});
