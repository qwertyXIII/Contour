import { stringify } from 'yaml';
import { EXIT_HEADER } from '../inlets/http-proxy.ts';
import { PRIVATE_V4 } from '../inlets/fence.ts';
import { shareWho, type ShareDevice } from './store.ts';

/**
 * Конфиг края — второго mihomo, к которому телефоны приходят по VLESS через
 * WebSocket. TLS снимает nginx перед ним (сертификат домена), сам край слушает
 * только `127.0.0.1`.
 *
 * TCP край не решает: каждое устройство ведётся в HTTP-прокси Contour под своим
 * именем (`share.<id>`), а там — как у любой программы: выбор выхода, повтор,
 * ограда частных адресов, карта портов, счётчики. `DIRECT` в правилах TCP нет
 * нарочно: напрямую телефон ходит сам, из той сети, где он.
 *
 * Страны: у устройства есть второй пользователь на каждую (`<id>.ru`, второй
 * сервер в Shadowrocket — «Contour-RU»). Его TCP идёт в тот же прокси с
 * заголовком `Contour-Exit: RU` — Contour выпустит его в России (прямой выход
 * дома или выход-туннель в Россию), не в другой стране.
 *
 * UDP (голос Discord, звонки, игры) HTTP-прокси не несёт, поэтому он идёт прямо
 * в выходы — группой `fallback`, «первый живой»: обычный — в SOCKS ядерных
 * выходов, страны — в выходы этой страны (прямой выход — `DIRECT` отсюда).
 * Contour этот путь не видит, поэтому ограда — здесь: частные и служебные адреса
 * отвергаются до выхода (и ещё раз внутри namespace, `contour-netns.sh`). Имя для
 * UDP mihomo разрешает сам и до правил — через DoH внутри выхода, не DNS дома.
 *
 * `allow-insecure` — вход без своего TLS: mihomo 1.19 без него вход VLESS не
 * открывает вовсе (проверено `scripts/share-smoke.ts`), а TLS здесь снимает nginx.
 */

export type UdpOutlet = { name: string; direct?: boolean; onRequest?: boolean; country?: string | null; socks: { host: string; port: number; user: string; pass: string } };

export type EdgeInput = {
  devices: ShareDevice[];
  wsPath: string;
  listen: string;
  port: number;
  /** HTTP-прокси Contour. */
  proxy: { host: string; port: number };
  /** Ядерные выходы для обычного UDP — по приоритету; пусто — UDP отвергается. */
  udp: UdpOutlet[];
  /** Страны (`share.countries`) и их выходы для UDP — по приоритету. */
  countries: Array<{ code: string; udp: UdpOutlet[] }>;
  /** Проверка живости выходов в группах UDP (`health.probeHost` + `probePath`). */
  probeUrl: string;
  controller: string;
  secret: string;
};

const UDP_GROUP = 'udp';
const lower = (c: string): string => c.toLowerCase();
const member = (o: UdpOutlet): string => (o.direct ? 'DIRECT' : `udp-${o.name}`);

function users(devices: ShareDevice[], codes: string[]): Array<{ username: string; uuid: string }> {
  return devices.flatMap((d) => [
    { username: d.id, uuid: d.uuid },
    ...codes.filter((c) => d.exits[c]).map((c) => ({ username: `${d.id}.${lower(c)}`, uuid: d.exits[c] as string })),
  ]);
}

function proxies(input: EdgeInput, devices: ShareDevice[], codes: string[]): Record<string, unknown>[] {
  const http = (name: string, d: ShareDevice, headers?: Record<string, string>) => ({
    name, type: 'http', server: input.proxy.host, port: input.proxy.port, username: shareWho(d.id), password: d.uuid, ...(headers ? { headers } : {}),
  });
  const socks = new Map<string, UdpOutlet>();
  for (const o of [...input.udp, ...input.countries.flatMap((c) => c.udp)]) if (!o.direct) socks.set(o.name, o);
  return [
    ...devices.flatMap((d) => [http(`via-${d.id}`, d), ...codes.map((c) => http(`via-${d.id}-${lower(c)}`, d, { [EXIT_HEADER]: c }))]),
    ...[...socks.values()].map((o) => ({ name: `udp-${o.name}`, type: 'socks5', server: o.socks.host, port: o.socks.port, username: o.socks.user, password: o.socks.pass, udp: true })),
  ];
}

function groups(input: EdgeInput): Record<string, unknown>[] {
  const group = (name: string, list: UdpOutlet[]) => ({ name, type: 'fallback', proxies: list.map(member), url: input.probeUrl, interval: 60, lazy: false });
  return [
    ...(input.udp.length > 0 ? [group(UDP_GROUP, input.udp)] : []),
    ...input.countries.filter((c) => c.udp.length > 0).map((c) => group(`udp-${c.code}`, c.udp)),
  ];
}

function rules(input: EdgeInput, devices: ShareDevice[], codes: string[]): string[] {
  const countryUdp = input.countries.filter((c) => codes.includes(c.code)).map((c) => {
    const who = devices.map((d) => `${d.id}.${lower(c.code)}`).join('/');
    return `AND,((NETWORK,udp),(IN-USER,${who})),${c.udp.length > 0 ? `udp-${c.code}` : 'REJECT'}`;
  });
  return [
    ...PRIVATE_V4.map(([net, bits]) => `IP-CIDR,${net}/${bits},REJECT,no-resolve`),
    ...(devices.length > 0 ? countryUdp : []),
    `NETWORK,udp,${input.udp.length > 0 ? UDP_GROUP : 'REJECT'}`,
    ...devices.flatMap((d) => [...codes.map((c) => `IN-USER,${d.id}.${lower(c)},via-${d.id}-${lower(c)}`), `IN-USER,${d.id},via-${d.id}`]),
    'MATCH,REJECT',
  ];
}

export function buildEdgeConfig(input: EdgeInput): string {
  const devices = input.devices.filter((d) => d.enabled);
  const codes = input.countries.map((c) => c.code);
  const doc = {
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'find-process-mode': 'off',
    'external-controller': input.controller,
    secret: input.secret,
    'geo-auto-update': false,
    ...(input.udp.length > 0 ? { dns: { enable: true, ipv6: false, nameserver: [`https://1.1.1.1/dns-query#${UDP_GROUP}`, `https://8.8.8.8/dns-query#${UDP_GROUP}`] } } : {}),
    listeners: [{ name: 'share', type: 'vless', listen: input.listen, port: input.port, 'ws-path': input.wsPath, 'allow-insecure': true, users: users(devices, codes) }],
    proxies: proxies(input, devices, codes),
    ...(groups(input).length > 0 ? { 'proxy-groups': groups(input) } : {}),
    rules: rules(input, devices, codes),
  };
  return stringify(doc, { lineWidth: 0 });
}
