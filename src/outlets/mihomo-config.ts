import { isIPv4, isIPv6 } from 'node:net';
import { stringify } from 'yaml';
import type { MihomoOutlet } from './outlet.ts';

/**
 * Конфиг mihomo собирается из выходов — руками не правится.
 *
 * Форма намеренно бедная: ни правил, ни групп, ни своего DNS. Каждый выход —
 * это `proxy` и свой `listener` типа SOCKS с `proxy: <имя>`, то есть вход,
 * который ведёт ровно в этот туннель. Выбор выхода, повтор и прилипание — наш
 * слой, а не mihomo: ему нужен повтор на отказе конкретного соединения, а
 * группы mihomo переключаются по проверке раз в интервал.
 *
 * `rules: [MATCH,REJECT]` — всё, что не пришло через именованный вход (а
 * такого быть не должно), отвергается. `remote-dns-resolve` — имена
 * разрешаются на дальнем конце туннеля: так CDN отдаёт узел рядом с выходом,
 * а резолвер этой машины не видит, куда ходят потребители.
 */

const DEFAULT_DNS = ['1.1.1.1', '8.8.8.8'];

/** Числа — числами, остальное (`i1` с байтовыми шаблонами) — строкой. */
function amneziaOption(raw: Record<string, string>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = /^\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}

function proxyOf(o: MihomoOutlet): Record<string, unknown> {
  const p = o.profile;
  const bare = p.addresses.map((a) => a.split('/')[0] as string);
  const proxy: Record<string, unknown> = {
    name: o.outlet.name,
    type: 'wireguard',
    'private-key': p.privateKey,
    server: p.peer.host,
    port: p.peer.port,
    ip: bare.find(isIPv4),
    'public-key': p.peer.publicKey,
    'allowed-ips': p.peer.allowedIps,
    udp: true,
    'remote-dns-resolve': true,
    dns: p.dns.length > 0 ? p.dns : DEFAULT_DNS,
  };
  const v6 = bare.find(isIPv6);
  if (v6) proxy.ipv6 = v6;
  if (p.peer.presharedKey) proxy['pre-shared-key'] = p.peer.presharedKey;
  if (p.mtu) proxy.mtu = p.mtu;
  if (p.peer.keepalive) proxy['persistent-keepalive'] = p.peer.keepalive;
  if (o.config.protocol === 'amneziawg' && Object.keys(p.amnezia).length > 0) {
    proxy['amnezia-wg-option'] = amneziaOption(p.amnezia);
  }
  return proxy;
}

function listenerOf(o: MihomoOutlet): Record<string, unknown> {
  return {
    name: `in-${o.outlet.name}`,
    type: 'socks',
    listen: o.outlet.socks.host,
    port: o.outlet.socks.port,
    proxy: o.outlet.name,
    udp: false,
    users: [{ username: o.outlet.socks.user, password: o.outlet.socks.pass }],
  };
}

export function buildMihomoConfig(input: { outlets: MihomoOutlet[]; controller: string; secret: string }): string {
  const doc = {
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'external-controller': input.controller,
    secret: input.secret,
    'geo-auto-update': false,
    'unified-delay': true,
    listeners: input.outlets.map(listenerOf),
    proxies: input.outlets.map(proxyOf),
    rules: ['MATCH,REJECT'],
  };
  return stringify(doc, { lineWidth: 0 });
}
