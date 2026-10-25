import { stringify } from 'yaml';
import type { ShareKey } from './links.ts';
import { countryGroup, countryNode, policyName, REJECT_KEYWORDS, setVersion, SHARE_NODE, type ConfInput } from './rules.ts';

/**
 * Профиль mihomo — те же правила раздачи, что `contour.conf` у Shadowrocket,
 * для Clash Verge Rev на Windows (владелец 2026-10-25) и других клиентов на
 * mihomo. Одна ссылка — и серверы, и правила: подписки отдельно нет.
 *
 * Как и у телефона, напрямую идёт всё, чего нет в правилах: игры не ходят через
 * Contour и не теряют в скорости. В режиме «Системный прокси» клиент их и вовсе
 * не видит; TUN нужен тем программам, что системный прокси не слушают.
 *
 * Отличия от Shadowrocket:
 * - наборы — `rule-providers` в текстовом формате со своей записью: у mihomo
 *   `.example.com` — только поддомены, сам сайт и поддомены — `+.example.com`
 *   (`mihomoSetText`); поэтому файлы свои, `…/mihomo/<набор>.list`;
 * - `?v=` в ссылке набора здесь тоже к месту: файл набора mihomo хранит под
 *   отпечатком ссылки, новая версия — новый файл, и он скачивается сразу;
 * - `block-quic = all-proxy` нет — его заменяет правило: QUIC к сайтам набора
 *   «через Contour» — отказ, браузер сразу уходит на TCP (UDP внутри туннеля
 *   хуже TCP, и UDP раздачи не держит страну);
 * - `tun-included-routes` не нужен: TUN mihomo берёт все сети, и корпоративная
 *   подсеть доходит до своего `IP-CIDR`;
 * - DNS — системный и Яндекс наперегонки: в TUN системным DNS может оказаться
 *   сам туннель, и тогда ответит второй.
 */

/** Как часто перечитывать наборы, секунд; профиль клиент перечитывает по заголовку ответа (`server.ts`). */
const LIST_SECONDS = 12 * 3600;

export type MihomoInput = ConfInput & {
  /** Адрес снаружи — сервер и имя TLS. */
  domain: string;
  /** Путь WebSocket края. */
  path: string;
  /** Ключи устройства: «Contour» и по одному на страну (`links.ts`). */
  keys: ShareKey[];
};

/** Набор для `rule-providers` (`format: text`, `behavior: domain`): сам сайт и поддомены. */
export function mihomoSetText(names: string[], what = 'сайты через VPN'): string {
  return `# Contour: ${what}, ${names.length}\n${names.map((n) => `+.${n}`).join('\n')}\n`;
}

export function mihomoConf(input: MihomoInput): string {
  const { plan, base, domain } = input;
  const providers: Record<string, unknown> = {};
  const set = (id: string, file: string, names: string[], policy: string): string[] => {
    if (names.length === 0) return [];
    providers[id] = { type: 'http', behavior: 'domain', format: 'text', url: `${base}/mihomo/${file}?v=${setVersion(names)}`, interval: LIST_SECONDS };
    return [`RULE-SET,${id},${policy}`];
  };
  const reject = set('reject', 'reject.list', plan.reject, 'REJECT');
  const tunnel = set('contour', 'domains.list', plan.tunnel, SHARE_NODE);
  const direct = set('direct', 'direct.list', plan.direct, 'DIRECT');
  const countries = input.countries.flatMap((c) => [
    ...set(`country-${c.toLowerCase()}`, `country-${c.toLowerCase()}.list`, plan.country[c] ?? [], countryGroup(c)),
    `GEOIP,${c},${countryGroup(c)}`,
  ]);
  const rules = [
    ...REJECT_KEYWORDS.map((k) => `DOMAIN-KEYWORD,${k},REJECT`),
    ...plan.exceptions.map((e) => `${e.exact ? 'DOMAIN' : 'DOMAIN-SUFFIX'},${e.name},${policyName(e.policy)}`),
    ...reject,
    ...(tunnel.length > 0 ? ['AND,((NETWORK,UDP),(DST-PORT,443),(RULE-SET,contour)),REJECT', ...tunnel] : []),
    ...direct,
    ...plan.nets.map((n) => `IP-CIDR,${n.cidr},${policyName(n.policy)},no-resolve`),
    ...countries,
    'MATCH,DIRECT',
  ];
  const config = {
    mode: 'rule',
    ipv6: false,
    'log-level': 'warning',
    dns: {
      enable: true,
      ipv6: false,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      // Местные имена и проверка сети Windows — настоящими адресами: с подставным Windows пишет «нет интернета».
      'fake-ip-filter': ['+.lan', '+.local', '+.home.arpa', '+.msftconnecttest.com', '+.msftncsi.com', 'time.windows.com', '+.pool.ntp.org'],
      nameserver: ['system', '77.88.8.8'],
    },
    // Имя сайта из TLS и HTTP — для программ со своим DNS: без него соединение по адресу ушло бы мимо правил.
    sniffer: { enable: true, 'override-destination': true, sniff: { TLS: { ports: [443, 8443] }, HTTP: { ports: [80, '8080-8880'] } } },
    proxies: input.keys.map((k) => ({
      name: k.name, type: 'vless', server: domain, port: 443, uuid: k.uuid, udp: true,
      tls: true, servername: domain, alpn: ['http/1.1'], network: 'ws', 'ws-opts': { path: input.path, headers: { Host: domain } },
    })),
    ...(input.countries.length > 0 ? { 'proxy-groups': input.countries.map((c) => ({ name: countryGroup(c), type: 'select', proxies: ['DIRECT', countryNode(c)] })) } : {}),
    'rule-providers': providers,
    rules,
  };
  return [
    `# Contour — правила для «${input.device}»: заблокированное через Contour, остальное напрямую.`,
    '# Обновляются сами (заголовок profile-update-interval); правка руками здесь пропадёт при обновлении.',
    stringify(config),
  ].join('\n');
}
