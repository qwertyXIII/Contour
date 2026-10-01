import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCidr, overlaps, parseCidr, parseCidrList } from '../src/cidr.ts';
import { CLOUDFLARE_V4, parseConfig } from '../src/config.ts';
import { pickSubnets } from '../src/dns/subnets.ts';
import { netCommands } from '../src/root/gateway.ts';

const c = (s: string) => parseCidr(s) as NonNullable<ReturnType<typeof parseCidr>>;

test('подсети: разбор, хост-часть обнуляется, IPv6 и мусор — мимо', () => {
  assert.equal(formatCidr(c('91.108.4.7/22')), '91.108.4.0/22');
  assert.equal(formatCidr(c('1.2.3.4')), '1.2.3.4/32');
  assert.equal(parseCidr('300.1.1.1/8'), null);
  assert.equal(parseCidr('1.2.3.4/33'), null);
  assert.deepEqual(parseCidrList('# discord\n66.22.192.0/18\n2001:db8::/32\nмусор\n\n138.128.136.0/21 # свой\n').map(formatCidr), ['66.22.192.0/18', '138.128.136.0/21']);
  assert.equal(overlaps(c('104.16.0.0/12'), c('104.16.0.0/13')), true, 'одна внутри другой');
  assert.equal(overlaps(c('66.22.192.0/18'), c('104.16.0.0/13')), false);
});

test('подсети шлюза: без Cloudflare, частных сетей и шире /8', () => {
  const skip = CLOUDFLARE_V4.map(c);
  // Как список Discord у itdoginfo на 2026-10-02.
  const discord = parseCidrList('138.128.136.0/21\n162.158.0.0/15\n172.64.0.0/13\n34.0.0.0/15\n34.2.0.0/15\n35.192.0.0/12\n35.208.0.0/12\n5.200.14.128/25\n66.22.192.0/18\n104.16.0.0/12\n');
  const { nets, skipped } = pickSubnets([...discord, c('10.0.0.0/8'), c('8.0.0.0/7')], skip);
  assert.deepEqual(nets.map(formatCidr), ['138.128.136.0/21', '34.0.0.0/15', '34.2.0.0/15', '35.192.0.0/12', '35.208.0.0/12', '5.200.14.128/25', '66.22.192.0/18']);
  assert.equal(skipped, 3, 'три подсети Cloudflare');
  assert.equal(netCommands([]), 'flush set ip contour_gw vpn_net\n');
  assert.match(netCommands(['66.22.192.0/18']), /add element ip contour_gw vpn_net \{ 66\.22\.192\.0\/18 \}/);
});

test('настройки подсетей: по умолчанию Discord, Telegram, Meta; своё — проверяется', () => {
  const d = parseConfig('').lan;
  assert.equal(d.subnetLists.length, 3);
  assert.ok(d.subnetLists.every((u) => u.startsWith('https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv4/')));
  assert.deepEqual(parseConfig('lan:\n  subnetSkip: []\n').lan.subnetSkip, [], 'пусто — с Cloudflare');
  assert.throws(() => parseConfig('lan:\n  subnetSkip: [cloudflare]\n'), /subnetSkip/);
  assert.throws(() => parseConfig('lan:\n  subnetLists: [http://x]\n'), /subnetLists/);
});
