import { stringify } from 'yaml';
import { PRIVATE_V4 } from '../inlets/fence.ts';
import { shareWho, type ShareDevice } from './store.ts';

/**
 * Конфиг края — второго mihomo, к которому телефоны приходят по VLESS через
 * WebSocket. TLS снимает nginx перед ним (сертификат домена), сам край слушает
 * только `127.0.0.1`.
 *
 * TCP край не решает: каждое устройство ведётся в HTTP-прокси Contour под своим
 * именем (`share.<id>`), а там — как у любой программы: выбор выхода, повтор,
 * ограда частных адресов, карта портов, счётчики. `DIRECT` в правилах нет
 * нарочно: напрямую телефон ходит сам, из той сети, где он, — а «напрямую
 * отсюда» было бы прокси в домашнюю сеть и в интернет от имени дома.
 *
 * UDP (голос Discord, звонки, игры) HTTP-прокси не несёт, поэтому он идёт прямо
 * в SOCKS ядерных выходов — группой `fallback`: первый живой по приоритету,
 * запасной из группы соперников подхватывается сам. Contour этот путь не видит,
 * поэтому ограда — здесь: частные и служебные адреса отвергаются до выхода (и ещё
 * раз внутри namespace, `contour-netns.sh`). Имя для UDP mihomo разрешает сам и
 * до правил — через DoH внутри того же выхода, а не DNS провайдера дома.
 *
 * `allow-insecure` — вход без своего TLS: mihomo 1.19 без него вход VLESS не
 * открывает вовсе (проверено `scripts/share-smoke.ts`), а TLS здесь снимает nginx.
 */

export type UdpOutlet = { name: string; socks: { host: string; port: number; user: string; pass: string } };

export type EdgeInput = {
  devices: ShareDevice[];
  wsPath: string;
  listen: string;
  port: number;
  /** HTTP-прокси Contour. */
  proxy: { host: string; port: number };
  /** Ядерные выходы для UDP — по приоритету; пусто — UDP отвергается. */
  udp: UdpOutlet[];
  /** Проверка живости выходов группы UDP (`health.probeHost` + `probePath`). */
  probeUrl: string;
  controller: string;
  secret: string;
};

const UDP_GROUP = 'udp';

function udpPart(input: EdgeInput): Record<string, unknown> {
  if (input.udp.length === 0) return {};
  return {
    dns: { enable: true, ipv6: false, nameserver: [`https://1.1.1.1/dns-query#${UDP_GROUP}`, `https://8.8.8.8/dns-query#${UDP_GROUP}`] },
    'proxy-groups': [{ name: UDP_GROUP, type: 'fallback', proxies: input.udp.map((o) => `udp-${o.name}`), url: input.probeUrl, interval: 60, lazy: false }],
  };
}

export function buildEdgeConfig(input: EdgeInput): string {
  const devices = input.devices.filter((d) => d.enabled);
  const doc = {
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'find-process-mode': 'off',
    'external-controller': input.controller,
    secret: input.secret,
    'geo-auto-update': false,
    listeners: [{
      name: 'share',
      type: 'vless',
      listen: input.listen,
      port: input.port,
      'ws-path': input.wsPath,
      'allow-insecure': true,
      users: devices.map((d) => ({ username: d.id, uuid: d.uuid })),
    }],
    proxies: [
      ...devices.map((d) => ({ name: `via-${d.id}`, type: 'http', server: input.proxy.host, port: input.proxy.port, username: shareWho(d.id), password: d.uuid })),
      ...input.udp.map((o) => ({ name: `udp-${o.name}`, type: 'socks5', server: o.socks.host, port: o.socks.port, username: o.socks.user, password: o.socks.pass, udp: true })),
    ],
    ...udpPart(input),
    rules: [
      ...PRIVATE_V4.map(([net, bits]) => `IP-CIDR,${net}/${bits},REJECT,no-resolve`),
      `NETWORK,udp,${input.udp.length > 0 ? UDP_GROUP : 'REJECT'}`,
      ...devices.map((d) => `IN-USER,${d.id},via-${d.id}`),
      'MATCH,REJECT',
    ],
  };
  return stringify(doc, { lineWidth: 0 });
}
