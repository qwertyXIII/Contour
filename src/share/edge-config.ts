import { stringify } from 'yaml';
import { shareWho, type ShareDevice } from './store.ts';

/**
 * Конфиг края — второго mihomo, к которому телефоны приходят по VLESS через
 * WebSocket. TLS снимает nginx перед ним (сертификат домена), сам край слушает
 * только `127.0.0.1`.
 *
 * Край ничего не решает: каждое устройство ведётся в HTTP-прокси Contour под
 * своим именем (`share.<id>`), а там — как у любой программы: выбор выхода,
 * повтор, ограда частных адресов, карта портов, счётчики. `DIRECT` в правилах
 * нет нарочно: напрямую телефон ходит сам, из той сети, где он, — а «напрямую
 * отсюда» было бы прокси в домашнюю сеть и в интернет от имени дома.
 *
 * `allow-insecure` — вход без своего TLS: mihomo 1.19 без него вход VLESS не
 * открывает вовсе (проверено `scripts/share-smoke.ts`), а TLS здесь снимает nginx.
 *
 * UDP пока отвергается (шаг второй — UDP через SOCKS выхода): HTTP-прокси его
 * не несёт, а Shadowrocket с `block-quic` уводит QUIC на TCP сам.
 */

export type EdgeInput = {
  devices: ShareDevice[];
  wsPath: string;
  listen: string;
  port: number;
  /** HTTP-прокси Contour. */
  proxy: { host: string; port: number };
  controller: string;
  secret: string;
};

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
    proxies: devices.map((d) => ({
      name: `via-${d.id}`,
      type: 'http',
      server: input.proxy.host,
      port: input.proxy.port,
      username: shareWho(d.id),
      password: d.uuid,
    })),
    rules: [
      'NETWORK,udp,REJECT',
      ...devices.map((d) => `IN-USER,${d.id},via-${d.id}`),
      'MATCH,REJECT',
    ],
  };
  return stringify(doc, { lineWidth: 0 });
}
