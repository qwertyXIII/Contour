import net, { type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../config.ts';
import { errorText, type Logger } from '../log.ts';
import type { Hints, PortRule } from './hints.ts';
import { inCidr } from './lan-match.ts';
import { relay, type RelayDeps } from './relay.ts';

/**
 * Порты игр на адресе для домашней сети: TCP без имени в соединении.
 *
 * DNS отдал игре наш адрес (имя в общем списке — Supercell, например), игра
 * пришла сюда на свой порт. Куда вести — по подсказке DNS: какое имя этого
 * правила устройство спросило последним (hints.ts). Дальше — тот же поток с
 * повтором по выходам, что и у сайтов.
 *
 * Только TCP. UDP (бои в реальном времени, голос) — дело режима шлюза.
 */

const RETRY_BIND_MS = 10_000;

async function listen(server: net.Server, address: string, port: number, log: Logger): Promise<void> {
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, address, () => { server.off('error', reject); resolve(); });
      });
      log.info(`порт игр слушает ${address}:${port}`);
      return;
    } catch (error) {
      log.error(`порт игр ${address}:${port} не открылся: ${errorText(error)}; повтор через ${RETRY_BIND_MS / 1000} с`);
      await sleep(RETRY_BIND_MS);
    }
  }
}

function serve(client: Socket, rule: PortRule, lan: Config['lan'], hints: Hints, deps: RelayDeps): void {
  const from = (client.remoteAddress ?? '').replace(/^::ffff:/, '');
  const who = `lan:${from}`;
  if (!inCidr(from, lan.allow)) { client.destroy(); return; }
  const host = hints.pick(from, rule);
  if (!host) {
    deps.log.info(`${who}: :${rule.port} — не знаю куда: устройство не спрашивало у нашего DNS имя этого порта`);
    client.destroy();
    return;
  }
  client.on('error', () => client.destroy());
  relay(client, Buffer.alloc(0), who, { host, port: rule.port }, deps, {
    onEstablished: () => undefined,
    onFail: () => client.destroy(),
  });
}

export function startGamePorts(lan: Config['lan'], hints: Hints, deps: RelayDeps): net.Server[] {
  return lan.ports.map((rule) => {
    const server = net.createServer((client) => serve(client, rule, lan, hints, deps));
    void listen(server, lan.address, rule.port, deps.log);
    return server;
  });
}
