import encodeQR from 'qr';
import { countryGroup, countryNode, SHARE_NODE } from './rules.ts';
import { deviceCountries, type ShareDevice, type ShareSettings } from './store.ts';

/**
 * Что телефону дать, чтобы он подключился: подписку (одна ссылка и один QR —
 * все его серверы: «Contour» и по одному на открытую ему страну, «Contour-RU»),
 * правила (ссылка на конфиг и та же ссылка «открыть в Shadowrocket») и серверы
 * по одному — запасным путём.
 *
 * Подписка — по тому же токену, что правила: в её ответе ключи, а адрес попадает
 * в журнал nginx — владелец согласен (2026-10-02). Открыл телефону страну —
 * сервер появится в Shadowrocket сам, при обновлении подписки.
 *
 * Имя сервера — часть ссылки (`#Contour`), и правила зовут сервер по нему:
 * переименовал в Shadowrocket — правило его не найдёт.
 *
 * `alpn=http/1.1` — нарочно: nginx на 443 говорит и HTTP/2, а WebSocket через
 * nginx живёт только поверх HTTP/1.1; клиент, выбравший h2, до края не дойдёт.
 */

export type ShareServer = { name: string; country: string | null; server: string };
/** `group` — группа страны в правилах (её название по-русски); у обычного сервера — null. */
export type ShareNode = ShareServer & { group: string | null; qr: string; open: string };
export type ShareLinks = { subscription: { url: string; qr: string; open: string }; nodes: ShareNode[]; config: string; open: string };

/** Серверы устройства строками `vless://` — для подписки и для окна «Подключить»; адреса нет — null. */
export function shareServers(d: ShareDevice, s: ShareSettings, allowed: readonly string[] | null): ShareServer[] | null {
  if (!s.domain) return null;
  const q = new URLSearchParams({ encryption: 'none', security: 'tls', sni: s.domain, alpn: 'http/1.1', type: 'ws', host: s.domain, path: s.path }).toString();
  const node = (name: string, country: string | null, uuid: string): ShareServer => ({ name, country, server: `vless://${uuid}@${s.domain}:443?${q}#${encodeURIComponent(name)}` });
  return [node(SHARE_NODE, null, d.uuid), ...deviceCountries(d, allowed).map((c) => node(countryNode(c), c, d.exits[c] as string))];
}

/** Тело подписки: строки серверов в base64 — так её читают Shadowrocket и прочие клиенты. */
export function subscriptionBody(servers: ShareServer[]): string {
  return Buffer.from(`${servers.map((x) => x.server).join('\n')}\n`).toString('base64');
}

export function shareLinks(d: ShareDevice, s: ShareSettings, allowed: readonly string[] | null): ShareLinks | null {
  const servers = shareServers(d, s, allowed);
  if (!servers) return null;
  const base = `https://${s.domain}/list/${d.list}`;
  // `#Contour` — имя подписки в Shadowrocket (справка: «#name» или заголовок profile-title).
  const subscription = `${base}/servers#${SHARE_NODE}`;
  const config = `${base}/contour.conf`;
  return {
    subscription: { url: subscription, qr: qrDataUri(subscription), open: `shadowrocket://add/${subscription}` },
    nodes: servers.map((x) => ({ ...x, group: x.country ? countryGroup(x.country) : null, qr: qrDataUri(x.server), open: `shadowrocket://add/${x.server}` })),
    config,
    open: `shadowrocket://config/add/${config}`,
  };
}

/** QR картинкой для `<img>`: белая подложка — иначе в тёмной теме чёрные модули на прозрачном не видны. */
function qrDataUri(text: string): string {
  const svg = encodeQR(text, 'svg', { ecc: 'medium', border: 2 }).replace(/^<svg([^>]*)>/, '<svg$1><rect width="100%" height="100%" fill="#fff"/>');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
