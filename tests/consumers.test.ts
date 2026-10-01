import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Consumers } from '../src/consumers.ts';
import { createLogger } from '../src/vendor/logger.js';

const quiet = createLogger({ enabled: false });

function basic(name: string, token: string): string {
  return `Basic ${Buffer.from(`${name}:${token}`).toString('base64')}`;
}

test('токен из файла пускает, чужой и короткий — нет', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-'));
  const file = path.join(dir, 'tokens');
  writeFileSync(file, '# потребители\nalter:0123456789abcdef0123456789abcdef\nshort:abc\n\nyt:fedcba9876543210fedcba9876543210\n');
  const c = new Consumers(file, quiet);
  c.load();

  assert.equal(c.authorize(basic('alter', '0123456789abcdef0123456789abcdef')), 'alter');
  assert.equal(c.authorize(basic('yt', 'fedcba9876543210fedcba9876543210')), 'yt');
  assert.equal(c.authorize(basic('alter', '0123456789abcdef0123456789abcdeX')), null);
  assert.equal(c.authorize(basic('nobody', '0123456789abcdef0123456789abcdef')), null);
  assert.equal(c.authorize(basic('short', 'abc')), null, 'короткий токен пропущен при чтении');
  assert.equal(c.authorize(undefined), null);
  assert.equal(c.authorize('Bearer xyz'), null);
  assert.equal(c.authorize('Basic !!!'), null);
});

test('трафик складывается по имени', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contour-'));
  const file = path.join(dir, 'tokens');
  writeFileSync(file, 'alter:0123456789abcdef0123456789abcdef\n');
  const c = new Consumers(file, quiet);
  c.load();
  c.account('alter', 10, 100);
  c.account('alter', 5, 50);
  assert.deepEqual(c.totals().get('alter'), { up: 15, down: 150, connections: 2 });
});
