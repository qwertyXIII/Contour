import net, { type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../config.ts';
import { errorText, type Logger } from '../log.ts';
import { noRules } from '../rules/need.ts';
import { checkDestination } from './fence.ts';
import { inCidr, lanClient } from './lan-match.ts';
import { clientStatus, isStatusRequest, replyStatus } from './lan-status.ts';
import { relay, type RelayDeps } from './relay.ts';
import { parseHttpHost, parseSni } from './sni.ts';

/**
 * Вход для устройств домашней сети: SNI на :443 и Host на :80.
 *
 * Устройство (телевизор) спрашивает DNS у `contour-dns`, получает для сайтов
 * из списка адрес сервера и соединяется сюда. Мы читаем имя сайта из
 * приветствия TLS (или заголовка Host), ведём поток через выход и
 * проигрываем прочитанное. **Шифрование не трогаем**: TLS идёт насквозь от
 * устройства до сайта, сертификаты не подменяются.
 *
 * Только из домашней сети; какие имена вести — решает DNS (списки и
 * самообучение), а здесь стоит ограда. Учёт — по адресу устройства (`lan:192.168.0.42`).
 */

type LanConfig = Config['lan'];

/** Сколько ждём начала запроса от устройства. */
const HELLO_TIMEOUT_MS = 10_000;
/** Больше этого ClientHello не бывает; дальше — не TLS или атака. */
const HELLO_CAP = 16 * 1024 + 5;
const RETRY_BIND_MS = 10_000;

type Sniffed = { name: string } | { reject: string };

function sniff(kind: 'tls' | 'http', buf: Buffer): Sniffed | null {
  if (kind === 'tls') {
    const r = parseSni(buf);
    if (r.kind === 'need-more') return buf.length >= HELLO_CAP ? { reject: 'ClientHello слишком длинный' } : null;
    return r.kind === 'name' ? { name: r.name } : { reject: r.reason };
  }
  const host = parseHttpHost(buf);
  if (host === 'need-more') return null;
  return host ? { name: host } : { reject: 'нет Host' };
}

/** Панель: какие Host её, и куда отдать сокет. */
export type PanelHook = { hosts: Set<string>; take: (socket: Socket, head: Buffer) => void };

function serve(kind: 'tls' | 'http', port: number, client: Socket, lan: LanConfig, deps: RelayDeps, panel: PanelHook | null = null): void {
  const { log } = deps;
  // Адреса нет — устройство оборвало соединение раньше, чем мы его взяли (так бывает сразу после перезапуска). Не отказ, а нечего вести.
  const from = client.remoteAddress;
  if (!from) { client.destroy(); return; }
  // Клиент входа (`lan.clients`) — по имени и со своей страной; дом — по адресу.
  const member = lanClient(from, lan.clients);
  const who = member ? `lan:${member.name}` : `lan:${from.replace(/^::ffff:/, '')}`;
  if (!member && !inCidr(from, lan.allow)) {
    log.warn(`${who}: не из домашней сети — отказ`);
    client.destroy();
    return;
  }

  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => client.destroy(), HELLO_TIMEOUT_MS);
  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk]);
    const r = sniff(kind, buf);
    if (!r) return;
    client.off('data', onData);
    clearTimeout(timer);
    client.pause();
    if ('reject' in r) {
      log.debug(`${who}: :${port} — ${r.reject}`);
      client.destroy();
      return;
    }
    // Клиенту входа — его состояние: жив ли выход в его стране (lan-status.ts).
    if (kind === 'http' && member && isStatusRequest(buf)) {
      replyStatus(client, clientStatus(member, deps.chooser));
      return;
    }
    // http на имя панели или на сам адрес — это панель, а не сайт.
    if (kind === 'http' && panel && panel.hosts.has(r.name)) {
      panel.take(client, buf);
      return;
    }
    // Вести ли сайт через Contour, решил DNS; куда — правила (страна, только эти
    // выходы, запрет). Открытым прокси это не становится: пускаем только
    // домашнюю сеть, и ограда не пускает в частные адреса.
    const fence = checkDestination(r.name, port);
    // Страна клиента — как заголовок страны у прокси: сильнее правил, кроме «запретить» и «только через».
    const routed = (deps.route ?? noRules)(r.name, member?.country ? { country: member.country } : undefined);
    if (!fence.ok || routed.reject) {
      log.warn(`${who}: отказ — ${routed.reject ? `запрещено правилом «${routed.why}»` : fence.ok ? '' : fence.reason}`);
      client.destroy();
      return;
    }
    relay(client, buf, who, { host: r.name, port, need: routed.need }, deps, {
      onEstablished: () => client.resume(),
      onFail: () => client.destroy(),
    });
  };
  client.on('data', onData);
  client.on('error', () => client.destroy());
}

/** Слушать адрес, которого может ещё не быть (unit второго адреса не поднялся) — повторяя. */
async function listen(server: net.Server, address: string, port: number, log: Logger): Promise<void> {
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, address, () => { server.off('error', reject); resolve(); });
      });
      log.info(`вход для домашней сети слушает ${address}:${port}`);
      return;
    } catch (error) {
      log.error(`вход для домашней сети ${address}:${port} не открылся: ${errorText(error)}; повтор через ${RETRY_BIND_MS / 1000} с`);
      await sleep(RETRY_BIND_MS);
    }
  }
}

/** Тот же разбор для тестов — порт 443 в тесте не взять. */
export const serveForTest = serve;

export function startLanInlet(lan: LanConfig, deps: RelayDeps, panel: PanelHook | null = null): net.Server[] {
  const servers: net.Server[] = [];
  // Слушаем внутренние порты; на них пакеты к address:443/80 переадресует таблица
  // nft от contour-addr (сами :443/:80 на всех адресах держит nginx).
  for (const [kind, port, listenPort] of [['tls', 443, lan.tlsPort], ['http', 80, lan.httpPort]] as const) {
    const server = net.createServer((client) => serve(kind, port, client, lan, deps, panel));
    void listen(server, lan.address, listenPort, deps.log);
    servers.push(server);
  }
  deps.log.info(`домашняя сеть: ${lan.allow}, сайтов в списке ${lan.domains.length}${lan.clients.length > 0 ? `; клиенты входа: ${lan.clients.map((c) => `${c.name} ${c.net}${c.country ? ` → ${c.country}` : ''}`).join(', ')}` : ''}`);
  return servers;
}
