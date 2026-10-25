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

/**
 * Имя подписки в Shadowrocket — ⚠️ не имя сервера. Политикой правила бывает и
 * подписка целиком, и Shadowrocket берёт одноимённую подписку раньше узла:
 * живьём 2026-10-02 подписка «Contour» увела всё, что правила слали на узел
 * «Contour», в сервер «Contour-RU» — Instagram и YouTube с домашнего адреса.
 */
export const SUBSCRIPTION_NAME = 'Серверы Contour';

/** Ключ устройства: обычный сервер и по одному на открытую ему страну. */
export type ShareKey = { name: string; country: string | null; uuid: string };
export type ShareServer = { name: string; country: string | null; server: string };
/** `group` — группа страны в правилах (её название по-русски); у обычного сервера — null. */
export type ShareNode = ShareServer & { group: string | null; qr: string; open: string };
/** `mihomo` — профиль для Clash Verge Rev и других клиентов на mihomo: серверы и правила одной ссылкой. */
export type ShareLinks = { subscription: { url: string; qr: string; open: string }; nodes: ShareNode[]; config: string; open: string; mihomo: { url: string; open: string } };

export function shareKeys(d: ShareDevice, allowed: readonly string[] | null): ShareKey[] {
  return [{ name: SHARE_NODE, country: null, uuid: d.uuid }, ...deviceCountries(d, allowed).map((c) => ({ name: countryNode(c), country: c, uuid: d.exits[c] as string }))];
}

/** Серверы устройства строками `vless://` — для подписки и для окна «Подключить»; адреса нет — null. */
export function shareServers(d: ShareDevice, s: ShareSettings, allowed: readonly string[] | null): ShareServer[] | null {
  if (!s.domain) return null;
  const q = new URLSearchParams({ encryption: 'none', security: 'tls', sni: s.domain, alpn: 'http/1.1', type: 'ws', host: s.domain, path: s.path }).toString();
  return shareKeys(d, allowed).map((k) => ({ name: k.name, country: k.country, server: `vless://${k.uuid}@${s.domain}:443?${q}#${encodeURIComponent(k.name)}` }));
}

/** Тело подписки: строки серверов в base64 — так её читают Shadowrocket и прочие клиенты. */
export function subscriptionBody(servers: ShareServer[]): string {
  return Buffer.from(`${servers.map((x) => x.server).join('\n')}\n`).toString('base64');
}

export function shareLinks(d: ShareDevice, s: ShareSettings, allowed: readonly string[] | null): ShareLinks | null {
  const servers = shareServers(d, s, allowed);
  if (!servers) return null;
  const base = `https://${s.domain}/list/${d.list}`;
  // `#…` — имя подписки в Shadowrocket (справка: «#name» или заголовок profile-title).
  const subscription = `${base}/servers#${encodeURIComponent(SUBSCRIPTION_NAME)}`;
  const config = `${base}/contour.conf`;
  const mihomo = `${base}/mihomo.yaml`;
  return {
    subscription: { url: subscription, qr: qrDataUri(subscription), open: `shadowrocket://add/${subscription}` },
    nodes: servers.map((x) => ({ ...x, group: x.country ? countryGroup(x.country) : null, qr: qrDataUri(x.server), open: `shadowrocket://add/${x.server}` })),
    config,
    open: `shadowrocket://config/add/${config}`,
    // `clash://install-config` — так профиль по ссылке открывают Clash Verge Rev, FlClash и другие.
    mihomo: { url: mihomo, open: `clash://install-config?url=${encodeURIComponent(mihomo)}&name=Contour` },
  };
}

/** QR картинкой для `<img>`: белая подложка — иначе в тёмной теме чёрные модули на прозрачном не видны. */
function qrDataUri(text: string): string {
  const svg = encodeQR(text, 'svg', { ecc: 'medium', border: 2 }).replace(/^<svg([^>]*)>/, '<svg$1><rect width="100%" height="100%" fill="#fff"/>');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
