import { readFileSync } from 'node:fs';
import path from 'node:path';
import { formatCidr, parseCidr, parseCidrList, type Cidr } from '../cidr.ts';
import { inSet } from '../dns/lists.ts';
import type { OverrideMap } from '../dns/overrides.ts';
import { pickSubnets, SUBNETS_FILE } from '../dns/subnets.ts';
import type { Sites } from '../panel/sites.ts';

/**
 * Правила раздачи для Shadowrocket: заблокированное — через Contour, остальное —
 * напрямую из той сети, где телефон. Спрашивать сервер по каждому соединению
 * клиент не умеет, поэтому решение уезжает на телефон списком, который сам
 * обновляется.
 *
 * Те же данные, что у DNS дома: свой список, общий, выученное «через VPN»,
 * ручные решения из панели (`Sites`), плюс подсети сервисов, что ходят по
 * адресам (голос Discord, Telegram), — как у шлюза. Выученное — история
 * посещений дома, поэтому правила отдаются только по токену устройства.
 *
 * Формат — по справке Shadowrocket (github.com/LOWERTOP/Shadowrocket):
 * - `DOMAIN-SET` — файл без типов правил, `.example.com` — сам сайт и поддомены;
 * - правила идут сверху вниз, доменные — раньше адресных; ручное «напрямую»
 *   поэтому стоит первым и перебивает список;
 * - `IP-CIDR …,no-resolve` — только соединениям по адресу: иначе телефон
 *   спрашивал бы DNS о каждом сайте, чтобы сверить его адрес с подсетями;
 * - `update-url` — откуда конфиг обновляется сам.
 */

/** Сайты через Contour и ручные «напрямую»: без поддоменов того, что уже в списке, и без того, что владелец увёл напрямую. */
export function shareDomains(input: { own: string[]; common: string[]; learned: string[]; overrides: OverrideMap }): { tunnel: string[]; direct: string[] } {
  const direct = Object.entries(input.overrides).filter(([, v]) => v === 'direct').map(([k]) => k).sort();
  const directSet = new Set(direct);
  const forced = Object.entries(input.overrides).filter(([, v]) => v === 'tunnel').map(([k]) => k);
  const all = new Set([...input.own, ...input.common, ...input.learned, ...forced].filter((n) => !inSet(n, directSet)));
  const tunnel = [...all].filter((n) => {
    const dot = n.indexOf('.');
    return dot < 0 || !inSet(n.slice(dot + 1), all);
  });
  return { tunnel: tunnel.sort(), direct };
}

export function domainSetText(names: string[]): string {
  return `# Contour: сайты через VPN, ${names.length}\n${names.map((n) => `.${n}`).join('\n')}\n`;
}

export type ConfInput = {
  /** `https://contour.example.ru/list/<токен>` — без «/» в конце. */
  base: string;
  device: string;
  direct: string[];
  nets: string[];
};

export function shadowrocketConf(input: ConfInput): string {
  return [
    `# Contour — правила для «${input.device}»: заблокированное через Contour, остальное напрямую.`,
    '# Обновляются сами (update-url ниже); правка руками здесь пропадёт при обновлении.',
    '[General]',
    'dns-server = system',
    'fallback-dns-server = system',
    'ipv6 = false',
    // QUIC (UDP) через край пока не ходит — пусть приложения сразу идут по TCP.
    'block-quic = all-proxy',
    'udp-policy-not-supported-behaviour = REJECT',
    `update-url = ${input.base}/contour.conf`,
    '',
    '[Rule]',
    ...input.direct.map((n) => `DOMAIN-SUFFIX,${n},DIRECT`),
    `DOMAIN-SET,${input.base}/domains.list,PROXY`,
    ...input.nets.map((c) => `IP-CIDR,${c},PROXY,no-resolve`),
    'FINAL,DIRECT',
    '',
  ].join('\n');
}

/** Данные правил с диска: папка DNS (`Sites`) и копия списков подсетей. */
export class ShareRules {
  private readonly sites: Sites;
  private readonly dnsDir: string;
  private readonly skip: Cidr[];

  constructor(opts: { sites: Sites; dnsDir: string; skip: string[] }) {
    this.sites = opts.sites;
    this.dnsDir = opts.dnsDir;
    this.skip = opts.skip.map((s) => parseCidr(s)).filter((c): c is Cidr => c !== null);
  }

  domains(): { tunnel: string[]; direct: string[] } {
    const learned = this.sites.learned().filter((l) => l.via === 'tunnel').map((l) => l.name);
    return shareDomains({ own: this.sites.ownNames(), common: this.sites.commonNames(), learned, overrides: this.sites.overrides() });
  }

  /** Подсети — те же, что у шлюза: без частных, без Cloudflare. DNS ещё не скачал — пусто. */
  nets(): string[] {
    try {
      const list = parseCidrList(readFileSync(path.join(this.dnsDir, SUBNETS_FILE), 'utf8'));
      return pickSubnets(list, this.skip).nets.map(formatCidr);
    } catch {
      return [];
    }
  }
}
