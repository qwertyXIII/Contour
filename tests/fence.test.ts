import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDestination } from '../src/inlets/fence.ts';

test('частные и служебные адреса IPv4 не выпускаются', () => {
  for (const ip of ['127.0.0.1', '10.200.0.1', '192.168.0.113', '172.16.5.5', '172.31.255.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1']) {
    assert.equal(checkDestination(ip, 443).ok, false, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.7']) {
    assert.equal(checkDestination(ip, 443).ok, true, ip);
  }
});

test('локальные адреса IPv6 и v4-mapped не выпускаются', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '[::ffff:192.168.1.1]']) {
    assert.equal(checkDestination(ip, 443).ok, false, ip);
  }
  assert.equal(checkDestination('2606:4700:4700::1111', 443).ok, true);
  assert.equal(checkDestination('[2606:4700:4700::1111]', 443).ok, true);
});

test('местные имена не выпускаются, обычные — да', () => {
  for (const name of ['localhost', 'server', 'nas.local', 'printer.lan', 'db.internal', 'router.home.arpa', 'a.localhost']) {
    assert.equal(checkDestination(name, 80).ok, false, name);
  }
  for (const name of ['youtube.com', 'www.googlevideo.com', 'xn--80ak6aa92e.com', 'пример.рф', 'a.b.c.d.example']) {
    assert.equal(checkDestination(name, 80).ok, true, name);
  }
});

test('порт вне диапазона и пустой адрес — отказ', () => {
  assert.equal(checkDestination('example.com', 0).ok, false);
  assert.equal(checkDestination('example.com', 70000).ok, false);
  assert.equal(checkDestination('', 80).ok, false);
});
