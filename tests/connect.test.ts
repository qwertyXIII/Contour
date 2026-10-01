import assert from 'node:assert/strict';
import test from 'node:test';
import { FenceError, makeDial } from '../src/outlets/connect.ts';
import { newOutlet } from '../src/outlets/outlet.ts';

const outlet = newOutlet({ name: 'x', kind: 'mihomo', bridge: null, protocol: 'wireguard', conf: '/x', env: null, dns: [], mtu: null, priority: 1, enabled: true }, 1);

test('имя, которое разрешилось в частный адрес, не пропускается', async () => {
  const dial = makeDial({ resolve: async () => ['127.0.0.1', '192.168.0.113'] }, 500);
  await assert.rejects(dial(outlet, 'evil.example', 443), FenceError);
});

test('ошибка резолвера доходит словами', async () => {
  const dial = makeDial({ resolve: async () => { throw new Error('имя «a.b» не разрешилось'); } }, 500);
  await assert.rejects(dial(outlet, 'a.b', 443), /не разрешилось/);
});
