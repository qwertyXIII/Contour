import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ServiceIndex, siteOf } from '../src/rules/service-index.ts';
import { Services } from '../src/rules/services.ts';
import { parseV2flyFile, type V2flyItem } from '../src/rules/v2fly.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });

const files = (map: Record<string, string>): Map<string, V2flyItem[]> =>
  new Map(Object.entries(map).map(([k, v]) => [k, parseV2flyFile(v)]));

test('основной домен: список суффиксов с частным разделом, IP и одна метка — как есть', () => {
  assert.equal(siteOf('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('WWW.Example.COM.'), 'example.com');
  assert.equal(siteOf('x.github.io'), 'x.github.io', 'частный суффикс: у каждой страницы свой хозяин');
  assert.notEqual(siteOf('x.github.io'), siteOf('y.github.io'));
  assert.equal(siteOf('d123.cloudfront.net'), 'd123.cloudfront.net');
  assert.equal(siteOf('1.2.3.4'), '1.2.3.4');
  assert.equal(siteOf('[2001:db8::1]'), '2001:db8::1');
  assert.equal(siteOf('localhost'), 'localhost');
  assert.equal(siteOf('nas'), 'nas');
  assert.equal(siteOf('co.uk'), 'co.uk', 'сам суффикс — само имя');
  assert.equal(siteOf('xn--e1afmkfd.xn--p1ai'), 'xn--e1afmkfd.xn--p1ai');
});

test('группа сильнее основного домена; точное — только само; под частным суффиксом — тоже группа', () => {
  // Как data/openai и кусок data/youtube у v2fly (2026-10-02).
  const index = new ServiceIndex(['openai', 'google'], files({
    openai: 'chatgpt.com\noaistatic.com\nopenai.com\nfull:openaiapi-site.azureedge.net\nregexp:^chatgpt-async-.+$\nfull:o33249.ingest.sentry.io @ads\n',
    google: 'google.com\nyoutubei.googleapis.com\n',
  }));
  assert.equal(index.serviceOf('chatgpt.com'), 'openai');
  assert.equal(index.serviceOf('cdn.oaistatic.com'), 'openai');
  assert.equal(index.serviceOf('openaiapi-site.azureedge.net'), 'openai');
  assert.equal(index.serviceOf('x.openaiapi-site.azureedge.net'), siteOf('x.openaiapi-site.azureedge.net'), 'full: не берёт поддомены');
  assert.equal(index.serviceOf('youtubei.googleapis.com'), 'google', 'googleapis.com — в частном разделе, но группа сильнее');
  assert.equal(index.serviceOf('www.googleapis.com'), 'www.googleapis.com');
  assert.equal(index.serviceOf('example.co.uk'), 'example.co.uk');
  assert.equal(index.serviceOf('8.8.8.8'), '8.8.8.8');
  assert.equal(index.groupOf('example.com'), null);
  assert.deepEqual(index.stats.names, { openai: 5, google: 2 });
  assert.equal(index.stats.skipped, 1, 'regexp: — не умеем');
});

test('include: вглубь, цикл не вешает, предел глубины режет', () => {
  const data = files({
    a: 'include:b\na.com\n',
    b: 'include:c\nb.com\n',
    c: 'include:a\ninclude:d\nc.com\n',
    d: 'd.com\ninclude:nowhere\n',
  });
  const deep = new ServiceIndex(['a'], data);
  assert.deepEqual(['a.com', 'x.b.com', 'c.com', 'd.com'].map((h) => deep.serviceOf(h)), ['a', 'a', 'a', 'a']);
  assert.deepEqual(deep.stats.missing, ['nowhere']);
  const shallow = new ServiceIndex(['a'], data, [], 1);
  assert.deepEqual(['b.com', 'c.com', 'd.com'].map((h) => shallow.serviceOf(h)), ['a', 'c.com', 'd.com']);
});

test('граница: другая группа набора и площадки не втягиваются; имя в двух группах — за первой', () => {
  const data = files({
    microsoft: 'include:github\ninclude:azure\nmicrosoft.com\nlive.com\nshared.com\n',
    github: 'github.com\ngithubusercontent.com\n',
    azure: 'azurewebsites.net\n',
    other: 'shared.com\nsub.live.com\n',
  });
  const both = new ServiceIndex(['microsoft', 'github', 'other'], data, ['azure']);
  assert.equal(both.serviceOf('github.com'), 'github', 'GitHub в наборе — своя группа, хоть microsoft его и включает');
  assert.equal(both.serviceOf('site.azurewebsites.net'), siteOf('site.azurewebsites.net'), 'площадка — по владельцу, не Microsoft');
  assert.equal(both.serviceOf('shared.com'), 'microsoft', 'раньше в наборе — сильнее');
  assert.equal(both.serviceOf('a.sub.live.com'), 'other', 'длинный суффикс сильнее короткого');
  const alone = new ServiceIndex(['microsoft'], data);
  assert.equal(alone.serviceOf('github.com'), 'microsoft');
  assert.equal(alone.serviceOf('site.azurewebsites.net'), 'microsoft');
});

/** Подставной raw.githubusercontent: `data/<name>` из карты, остальное — 404. */
async function fakeGithub(t: TestContext, data: Record<string, string>): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const name = (req.url ?? '').replace(/^\/data\//, '');
    hits.push(name);
    const body = data[name];
    res.writeHead(body === undefined ? 404 : 200).end(body ?? 'нет');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // И при упавшей проверке: открытый сервер не дал бы файлу проверок завершиться.
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/data/`, hits };
}

/** Ждать, пока `check` не станет правдой (файлы приходят из сети по одному). */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('не дождался');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('Services: качает группы с include:, держит копии; без сети — по копии, без копии — по основному домену', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-svc-'));
  const gh = await fakeGithub(t, {
    openai: 'include:openai-extra\nchatgpt.com\nopenai.com\n',
    'openai-extra': 'oaiusercontent.com\ninclude:openai\n',
    tiktok: 'tiktok.com @!cn\ntiktokv.com @!cn\nbyteoversea.com\n',
  });
  let changes = 0;
  const live = new Services({ cacheDir: dir, log: quiet, groups: ['openai', 'tiktok', 'absent'], baseUrl: gh.base, onChange: () => { changes++; } });
  live.start();
  await until(() => live.stats().loaded === 3 && gh.hits.length >= 4);
  live.stop();
  await new Promise<void>((r) => gh.server.close(() => r()));
  assert.equal(live.serviceOf('files.oaiusercontent.com'), 'openai', 'include: вглубь, по сети');
  assert.equal(live.serviceOf('v16.tiktokv.com'), 'tiktok');
  assert.equal(live.serviceOf('www.example.com'), 'example.com');
  assert.deepEqual(gh.hits.sort(), ['absent', 'openai', 'openai-extra', 'tiktok'], 'каждый файл — один раз, цикл не качается заново');
  assert.ok(changes >= 3);
  assert.equal(live.stats().groups.tiktok, 3);
  assert.ok(existsSync(path.join(dir, 'openai-extra.list')));
  assert.match(readFileSync(path.join(dir, 'openai.list'), 'utf8'), /^domain:chatgpt\.com$/m, 'копия — в формате v2fly');

  // Сети нет (сервер закрыт), копии есть — работаем по ним сразу, ещё до первого ответа.
  const offline = new Services({ cacheDir: dir, log: quiet, groups: ['openai', 'tiktok'], baseUrl: gh.base });
  offline.start();
  assert.equal(offline.serviceOf('files.oaiusercontent.com'), 'openai');
  assert.equal(offline.serviceOf('tiktok.com'), 'tiktok');
  offline.stop();

  // Ни сети, ни копии — сервис по основному домену.
  const empty = new Services({ cacheDir: mkdtempSync(path.join(tmpdir(), 'contour-svc-')), log: quiet, groups: ['openai'], baseUrl: gh.base });
  empty.start();
  assert.equal(empty.serviceOf('chat.chatgpt.com'), 'chatgpt.com');
  assert.equal(empty.serviceOf('a.b.example.co.uk'), 'example.co.uk');
  empty.stop();
});

test('Services: файл, на который больше не ссылаются, перестаёт качаться', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-svc-'));
  const data: Record<string, string> = { root: 'include:old\nroot.com\n', old: 'old.com\n' };
  const gh = await fakeGithub(t, data);
  const s = new Services({ cacheDir: dir, log: quiet, groups: ['root'], baseUrl: gh.base });
  s.start();
  await until(() => s.stats().loaded === 2);
  assert.equal(s.serviceOf('old.com'), 'root');
  s.stop();
  await new Promise<void>((r) => gh.server.close(() => r()));
  // Копия корня без `include:old` — как будто upstream его убрал; `old` остался на диске со вчера.
  const gh2 = await fakeGithub(t, { root: 'root.com\n' });
  const s2 = new Services({ cacheDir: dir, log: quiet, groups: ['root'], baseUrl: gh2.base });
  s2.start();
  assert.equal(s2.serviceOf('old.com'), 'root', 'с диска: старая копия ещё ссылается');
  await until(() => gh2.hits.includes('root') && s2.serviceOf('old.com') === 'old.com');
  assert.equal(s2.stats().files, 1, 'old больше не держим');
  s2.stop();
});
