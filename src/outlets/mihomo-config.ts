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

/**
 * Публичные резолверы — всегда в списке, после резолвера профиля. Запросы к ним
 * идут внутрь туннеля (`allowed-ips: 0.0.0.0/0`), утечки нет. Причина — живой
 * запуск 2026-10-01: туннель ходил, а резолвер Amnezia `10.10.8.15` отвечал
 * через раз, и каждое имя висело 5 с до `dns resolve failed`.
 */
const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8'];

function dnsFor(o: MihomoOutlet): string[] {
  if (o.config.dns.length > 0) return o.config.dns;
  return [...new Set([...(o.profile?.dns ?? []), ...PUBLIC_DNS])];
}

/**
 * MTU, когда ни настройки, ни профиль его не называют. У mihomo своё умолчание
 * 1408, и с ним на живом запуске 2026-10-01 мелкие пакеты ходили, а
 * полноразмерные терялись: 1 МБ по http — 82 КБ за 25 с, TLS-рукопожатия с
 * большими сертификатами висли. 1280 проходит по любому пути (минимум IPv6);
 * точнее — полем `mtu` выхода после замера `ping -M do` до VPN-сервера.
 */
const DEFAULT_MTU = 1280;

/**
 * Стек TCP внутри туннеля. С gVisor (умолчание `auto`) на живом запуске
 * мелкие ответы ходили, а длинные загрузки вставали через ~200 КБ. `mips` —
 * свой стек mihomo; для него работает выбор управления перегрузкой, BBR
 * держит скорость при потерях лучше cubic.
 */
const IP_STACK = 'mips';

function mtuFor(o: MihomoOutlet): number {
  return o.config.mtu ?? o.profile?.mtu ?? DEFAULT_MTU;
}

/** Числа — числами, остальное (`i1` с байтовыми шаблонами) — строкой. */
function amneziaOption(raw: Record<string, string>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = /^\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}

/** Выход из ссылки: протокол как в ссылке, имя — имя выхода. */
function linkProxyOf(o: MihomoOutlet): Record<string, unknown> {
  return { ...(o.link as Record<string, unknown>), name: o.outlet.name };
}

function wgProxyOf(o: MihomoOutlet): Record<string, unknown> {
  const p = o.profile as NonNullable<MihomoOutlet['profile']>;
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
    mtu: mtuFor(o),
    'ip-stack': { mode: IP_STACK, 'congestion-controller': 'bbr' },
    'remote-dns-resolve': true,
    dns: dnsFor(o),
  };
  const v6 = bare.find(isIPv6);
  if (v6) proxy.ipv6 = v6;
  if (p.peer.presharedKey) proxy['pre-shared-key'] = p.peer.presharedKey;
  if (p.peer.keepalive) proxy['persistent-keepalive'] = p.peer.keepalive;
  if (o.config.protocol === 'amneziawg' && Object.keys(p.amnezia).length > 0) {
    proxy['amnezia-wg-option'] = amneziaOption(p.amnezia);
  }
  return proxy;
}

const PROBE_URL = 'https://www.gstatic.com/generate_204';

/**
 * Подписка — провайдер mihomo и группа `url-test` над ним с именем выхода:
 * какой сервер подписки сейчас быстрее, решает mihomo, а для Contour это один
 * выход. Подписку mihomo скачивает сам, раз в сутки; если есть ядерный выход —
 * через него (`contour-fetch`): сайт подписки отсюда может быть закрыт.
 */
function providerOf(o: MihomoOutlet, viaFetch: boolean): [string, Record<string, unknown>] {
  return [`sub-${o.outlet.name}`, {
    type: 'http',
    url: o.subscription,
    interval: 86_400,
    path: `./providers/${o.outlet.name}.yaml`,
    ...(viaFetch ? { proxy: FETCH_PROXY } : {}),
    'health-check': { enable: true, url: PROBE_URL, interval: 300 },
  }];
}

function groupOf(o: MihomoOutlet): Record<string, unknown> {
  return { name: o.outlet.name, type: 'url-test', use: [`sub-${o.outlet.name}`], url: PROBE_URL, interval: 300, tolerance: 50 };
}

export const FETCH_PROXY = 'contour-fetch';

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

/** Ядерный выход как SOCKS для mihomo — только чтобы скачать подписку. */
export type FetchVia = { host: string; port: number; user: string; pass: string };

export function buildMihomoConfig(input: { outlets: MihomoOutlet[]; controller: string; secret: string; fetchVia?: FetchVia | null }): string {
  const subs = input.outlets.filter((o) => o.subscription);
  const direct = input.outlets.filter((o) => !o.subscription);
  const via = input.fetchVia ?? null;
  const proxies: Record<string, unknown>[] = direct.map((o) => (o.link ? linkProxyOf(o) : wgProxyOf(o)));
  if (via && subs.length > 0) {
    proxies.push({ name: FETCH_PROXY, type: 'socks5', server: via.host, port: via.port, username: via.user, password: via.pass, udp: false });
  }
  const doc: Record<string, unknown> = {
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'external-controller': input.controller,
    secret: input.secret,
    'geo-auto-update': false,
    'unified-delay': true,
    listeners: input.outlets.map(listenerOf),
    proxies,
    rules: ['MATCH,REJECT'],
  };
  if (subs.length > 0) {
    doc['proxy-providers'] = Object.fromEntries(subs.map((o) => providerOf(o, via !== null)));
    doc['proxy-groups'] = subs.map(groupOf);
  }
  return stringify(doc, { lineWidth: 0 });
}
