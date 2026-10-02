import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FenceError } from '../src/outlets/connect.ts';
import { ResolveError } from '../src/outlets/doh.ts';
import { failureKind, OutcomeBook, type ExitRef } from '../src/select/outcomes.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });
const DAY = 86_400_000;
const de1: ExitRef = { name: 'de1', country: 'DE' };
const de2: ExitRef = { name: 'de2', country: 'DE' };
const nl: ExitRef = { name: 'nl', country: 'NL' };
const book = (extra: Partial<ConstructorParameters<typeof OutcomeBook>[0]> = {}): OutcomeBook => new OutcomeBook({ file: null, log: quiet, ...extra });

/** Сервис отказывает через выход, а другим выход в это время отвечает: попытки с промежутком, между ними — чужой ответ. */
function refuse(b: OutcomeBook, service: string, exit: ExitRef, times: number, start: number, gap = 25_000): number {
  let t = start;
  for (let i = 0; i < times; i++) {
    b.record('youtube.com', exit, 'answered', t);
    b.record(service, exit, 'silent', t + 1_000);
    t += gap;
  }
  return t;
}

test('выход лежит целиком — сервис не портится: одно падение выхода — не больше одной попытки', () => {
  const b = book();
  const t0 = Date.now();
  b.record('youtube.com', de1, 'answered', t0);
  // Выход упал: дальше не отвечает никому — ни сервису, ни остальным.
  for (let t = t0 + 5_000; t < t0 + 100_000; t += 25_000) {
    b.record('gosuslugi.ru', de1, 'silent', t);
    b.record('youtube.com', de1, 'timeout', t + 100);
  }
  const k = b.exitVerdict('gosuslugi.ru', de1, t0 + 100_000);
  assert.equal(k.verdict, 'unknown');
  assert.equal(k.streak, 1, 'все неудачи одного падения — одна попытка');
  // Выход молчит дольше окна — неудача вообще не про сервис.
  b.record('openai', de1, 'refused', t0 + 10 * 60_000);
  assert.equal(b.exitVerdict('openai', de1, t0 + 10 * 60_000).fails, 0);
  assert.equal(b.snapshot(100, t0).rows.some((r) => r.service === 'openai'), false, 'неучтённая неудача и записи не заводит');
});

test('без единого чужого ответа неудачи не учитываются вовсе', () => {
  const b = book();
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) b.record('gosuslugi.ru', de1, 'silent', t0 + i * 30_000);
  assert.deepEqual(b.snapshot(100, t0).rows, []);
});

test('K попыток подряд — плохо; один успех снимает; хорошо — пока последнее был успех', () => {
  const b = book();
  const t0 = Date.now();
  let t = refuse(b, 'gosuslugi.ru', de1, 2, t0);
  assert.equal(b.exitVerdict('gosuslugi.ru', de1, t).verdict, 'unknown', 'двух мало');
  t = refuse(b, 'gosuslugi.ru', de1, 1, t);
  const bad = b.exitVerdict('gosuslugi.ru', de1, t);
  assert.equal(bad.verdict, 'bad');
  assert.equal(bad.streak, 3);
  assert.equal(bad.kind, 'silent');
  assert.equal(bad.until, (bad.at ?? 0) + 3 * DAY, 'обходим badDays от последней неудачи');
  b.record('gosuslugi.ru', de1, 'answered', t + 1_000);
  const good = b.exitVerdict('gosuslugi.ru', de1, t + 2_000);
  assert.equal(good.verdict, 'good');
  assert.equal(good.streak, 0);
  assert.equal(good.ok, 1);
  b.record('youtube.com', de1, 'answered', t + 30_000);
  b.record('gosuslugi.ru', de1, 'refused', t + 31_000);
  assert.equal(b.exitVerdict('gosuslugi.ru', de1, t + 32_000).verdict, 'unknown', 'неудача после успеха — уже не «хорошо»');
  assert.equal(b.exitVerdict('gosuslugi.ru', de1, t + 32_000 + 31 * DAY).verdict, 'unknown');
});

test('вспышка соединений — одна попытка; fast-close не считается и серию не рвёт', () => {
  const b = book();
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) {
    b.record('youtube.com', de1, 'answered', t0 + i * 100);
    b.record('openai', de1, 'silent', t0 + i * 100 + 50);
  }
  const k = b.exitVerdict('openai', de1, t0 + 1_000);
  assert.equal(k.streak, 1);
  assert.equal(k.fails, 6, 'неудачи посчитаны, попытка одна');

  const c = book();
  let t = refuse(c, 'x.com', de1, 2, t0);
  for (let i = 0; i < 5; i++) {
    c.record('youtube.com', de1, 'answered', t);
    c.record('x.com', de1, 'fast-close', t + 10);
    t += 30_000;
  }
  assert.equal(c.exitVerdict('x.com', de1, t).streak, 2, 'фильтр порта — дело ports.ts');
  t = refuse(c, 'x.com', de1, 1, t);
  assert.equal(c.exitVerdict('x.com', de1, t).verdict, 'bad');
  assert.equal(book().exitVerdict('y.com', de1).verdict, 'unknown');
});

test('проверка живости выхода — тоже «выход работает»; badDays истекает, новая неудача снова «плохо»', () => {
  const b = book();
  const t0 = Date.now();
  let t = t0;
  for (let i = 0; i < 3; i++) {
    b.exitAlive('de1', t);
    b.record('gosuslugi.ru', de1, 'timeout', t + 2_000);
    t += 30_000;
  }
  const bad = b.exitVerdict('gosuslugi.ru', de1, t);
  assert.equal(bad.verdict, 'bad');
  assert.equal(bad.kind, 'timeout');
  const after = (bad.until ?? 0) + 1;
  assert.equal(b.exitVerdict('gosuslugi.ru', de1, after).verdict, 'unknown', 'срок вышел — пробуем снова');
  b.exitAlive('de1', after);
  b.record('gosuslugi.ru', de1, 'silent', after + 1_000);
  assert.equal(b.exitVerdict('gosuslugi.ru', de1, after + 2_000).verdict, 'bad', 'серия не прервана успехом — одной неудачи хватает');
});

test('страна: плоха, только когда плохи все её пробованные выходы; хороша, если хорош хоть один', () => {
  const b = book();
  const t0 = Date.now();
  let t = refuse(b, 'gosuslugi.ru', de1, 3, t0);
  b.record('youtube.com', de2, 'answered', t);
  b.record('gosuslugi.ru', de2, 'silent', t + 1_000);
  assert.equal(b.countryVerdict('gosuslugi.ru', 'DE', t + 2_000).verdict, 'unknown', 'de2 ещё не плох');
  assert.equal(b.countryVerdict('gosuslugi.ru', 'NL', t).verdict, 'unknown', 'о NL ничего');
  t = refuse(b, 'gosuslugi.ru', de2, 2, t + 25_000);
  const de = b.countryVerdict('gosuslugi.ru', 'DE', t);
  assert.equal(de.verdict, 'bad', 'сервис не пускает страну');
  assert.ok(de.until !== null && de.until > t);
  b.record('gosuslugi.ru', nl, 'answered', t);
  assert.deepEqual(b.countries('gosuslugi.ru', t).map((c) => [c.country, c.verdict]), [['DE', 'bad'], ['NL', 'good']]);
  b.record('gosuslugi.ru', de2, 'answered', t + 1_000);
  assert.equal(b.countryVerdict('gosuslugi.ru', 'DE', t + 2_000).verdict, 'good', 'хорош хоть один');
  // Выход сменил страну — его прошлое было про другой адрес.
  assert.equal(b.exitVerdict('gosuslugi.ru', { name: 'de1', country: 'FR' }, t).verdict, 'unknown');
  assert.equal(b.exitVerdict('gosuslugi.ru', { name: 'de1', country: null }, t).verdict, 'bad', 'страну ещё не узнали после перезапуска — опыт не теряем');
});

test('порядок: хорошие → неизвестные → плохие, устойчиво; плохие не выкидываются; причина для журнала', () => {
  const b = book();
  const t0 = Date.now();
  const t = refuse(b, 'openai', de1, 3, t0);
  b.record('openai', nl, 'answered', t);
  const fresh: ExitRef = { name: 'fresh', country: 'NL' };
  const other: ExitRef = { name: 'other', country: 'DE' };
  const { list, why } = b.order('openai', [de1, fresh, nl, other], t + 1_000);
  assert.deepEqual(list.map((e) => e.name), ['nl', 'fresh', 'other', 'de1']);
  assert.match(why ?? '', /^openai: «nl» отвечает .*«de1» закрывает, не ответив \(3 попыт\., обходим ещё 3 дн\.\)/);
  assert.deepEqual(b.order('unknown.org', [de1, nl]).list, [de1, nl], 'ничего не знаем — как пришли');
  assert.equal(b.order('unknown.org', [de1, nl]).why, null);
  assert.deepEqual([de1, nl, fresh].map((e) => b.rank('openai', e, t + 1_000)), [2, 0, 1]);
});

test('сохранение отложенное; загрузка возвращает выученное; битый файл — пустое состояние', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-outcomes-'));
  const file = path.join(dir, 'outcomes.json');
  const t0 = Date.now();
  const a = book({ file });
  const t = refuse(a, 'gosuslugi.ru', de1, 3, t0);
  a.record('gosuslugi.ru', nl, 'answered', t);
  assert.equal(existsSync(file), false, 'не на каждое событие');
  a.flush();
  const b = book({ file });
  assert.equal(b.exitVerdict('gosuslugi.ru', de1, t).verdict, 'bad');
  assert.equal(b.exitVerdict('gosuslugi.ru', nl, t).verdict, 'good');
  assert.equal(b.countryVerdict('gosuslugi.ru', 'DE', t).verdict, 'bad');

  writeFileSync(file, '{"services": {"x.com": {"de1": {"ok": "много"}}, "y.com": {"nl": {"country":"NL","ok":1,"okAt":' + t + ',"fails":0,"failAt":null,"streak":0,"attemptAt":null,"kind":null}}}}');
  const c = book({ file });
  assert.equal(c.snapshot(100, t).services, 1, 'битая запись выпала, целая осталась');
  assert.equal(c.exitVerdict('y.com', nl, t).verdict, 'good');
  writeFileSync(file, '{не json');
  assert.equal(book({ file }).snapshot().services, 0);
  writeFileSync(file, '[1,2,3]');
  assert.equal(book({ file }).snapshot().services, 0);
});

test('предел числа сервисов: вытесняются сначала ничего не знающие, «плохо» — в последнюю очередь', () => {
  const b = book({ maxServices: 10 });
  const t0 = Date.now();
  const t = refuse(b, 'gosuslugi.ru', de1, 3, t0);
  for (let i = 0; i < 30; i++) b.record(`site${i}.com`, nl, 'answered', t + i);
  const { services } = b.snapshot(1_000, t + 100);
  assert.ok(services <= 10, `сервисов ${services}`);
  assert.equal(b.exitVerdict('gosuslugi.ru', de1, t + 100).verdict, 'bad', 'дорогое знание пережило вытеснение');
  assert.equal(b.exitVerdict('site29.com', nl, t + 100).verdict, 'good', 'свежее тоже на месте');
});

test('снимок: сначала то, где что-то известно; страна, потом её выходы; целыми сервисами до предела', () => {
  const b = book();
  const t0 = Date.now();
  b.record('quiet.org', nl, 'answered', t0);
  const t = refuse(b, 'gosuslugi.ru', de1, 3, t0 + 1_000);
  b.record('gosuslugi.ru', nl, 'answered', t);
  const { rows } = b.snapshot(100, t + 1_000);
  assert.deepEqual(rows.map((r) => [r.service, r.country, r.exit, r.verdict]), [
    ['gosuslugi.ru', 'DE', null, 'bad'],
    ['gosuslugi.ru', 'DE', 'de1', 'bad'],
    ['gosuslugi.ru', 'NL', null, 'good'],
    ['gosuslugi.ru', 'NL', 'nl', 'good'],
    ['youtube.com', 'DE', null, 'good'],
    ['youtube.com', 'DE', 'de1', 'good'],
    ['quiet.org', 'NL', null, 'good'],
    ['quiet.org', 'NL', 'nl', 'good'],
  ]);
  assert.equal(rows[1]?.fails, 3);
  assert.deepEqual(b.snapshot(5, t + 1_000).rows.map((r) => r.service), ['gosuslugi.ru', 'gosuslugi.ru', 'gosuslugi.ru', 'gosuslugi.ru'], 'сервис не режется пополам');
});

test('вид отказа по ошибке соединения: ограда и «имени нет» — не исход выхода', () => {
  assert.equal(failureKind(new FenceError('частный адрес')), null);
  assert.equal(failureKind(new ResolveError('имени нет')), null);
  assert.equal(failureKind(Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })), null);
  assert.equal(failureKind(new Error('Proxy connection timed out')), 'timeout');
  assert.equal(failureKind(new Error('нет соединения за 8 с')), 'timeout');
  assert.equal(failureKind(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })), 'refused');
  assert.equal(failureKind(new Error('Socks5 proxy rejected connection - HostUnreachable')), 'refused');
});
