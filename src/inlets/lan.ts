import net, { type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../config.ts';
import { errorText, type Logger } from '../log.ts';
import { inCidr, matchesDomain } from './lan-match.ts';
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
 * Только из домашней сети и только имена из списка — иначе это открытый
 * прокси для всей сети. Учёт — по адресу устройства (`lan:192.168.0.42`).
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

function serve(kind: 'tls' | 'http', port: number, client: Socket, lan: LanConfig, deps: RelayDeps): void {
  const { log } = deps;
  const from = client.remoteAddress ?? '?';
  const who = `lan:${from.replace(/^::ffff:/, '')}`;
  if (!inCidr(from, lan.allow)) {
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
    if (!matchesDomain(r.name, lan.domains)) {
      // DNS отдаёт наш адрес только для списка, так что сюда это попадает разве
      // что по старому кэшу устройства. Чужое не ведём — это не открытый прокси.
      log.info(`${who}: «${r.name}» не из списка — отказ`);
      client.destroy();
      return;
    }
    relay(client, buf, who, { host: r.name, port }, deps, {
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

export function startLanInlet(lan: LanConfig, deps: RelayDeps): net.Server[] {
  const servers: net.Server[] = [];
  for (const [kind, port] of [['tls', 443], ['http', 80]] as const) {
    const server = net.createServer((client) => serve(kind, port, client, lan, deps));
    void listen(server, lan.address, port, deps.log);
    servers.push(server);
  }
  deps.log.info(`домашняя сеть: ${lan.allow}, сайтов в списке ${lan.domains.length}`);
  return servers;
}
