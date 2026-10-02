import encodeQR from 'qr';
import { countryNode, SHARE_NODE } from './rules.ts';
import type { ShareDevice, ShareSettings } from './store.ts';

/**
 * Что телефону дать, чтобы он подключился: серверы (ссылка `vless://` и её QR —
 * «Contour» и по одному на страну, «Contour-RU») и правила (ссылка на конфиг и
 * та же ссылка «открыть в Shadowrocket»).
 *
 * Имя сервера — часть ссылки (`#Contour`), и правила зовут сервер по нему:
 * переименовал в Shadowrocket — правило его не найдёт.
 *
 * `alpn=http/1.1` — нарочно: nginx на 443 говорит и HTTP/2, а WebSocket через
 * nginx живёт только поверх HTTP/1.1; клиент, выбравший h2, до края не дойдёт.
 */

export type ShareNode = { name: string; country: string | null; server: string; qr: string };
export type ShareLinks = { nodes: ShareNode[]; config: string; open: string };

export function shareLinks(d: ShareDevice, s: ShareSettings): ShareLinks | null {
  if (!s.domain) return null;
  const q = new URLSearchParams({ encryption: 'none', security: 'tls', sni: s.domain, alpn: 'http/1.1', type: 'ws', host: s.domain, path: s.path }).toString();
  const node = (name: string, country: string | null, uuid: string): ShareNode => {
    const server = `vless://${uuid}@${s.domain}:443?${q}#${encodeURIComponent(name)}`;
    return { name, country, server, qr: qrDataUri(server) };
  };
  const config = `https://${s.domain}/list/${d.list}/contour.conf`;
  return {
    nodes: [node(SHARE_NODE, null, d.uuid), ...Object.entries(d.exits).map(([c, uuid]) => node(countryNode(c), c, uuid))],
    config,
    open: `shadowrocket://config/add/${config}`,
  };
}

/** QR картинкой для `<img>`: белая подложка — иначе в тёмной теме чёрные модули на прозрачном не видны. */
function qrDataUri(text: string): string {
  const svg = encodeQR(text, 'svg', { ecc: 'medium', border: 2 }).replace(/^<svg([^>]*)>/, '<svg$1><rect width="100%" height="100%" fill="#fff"/>');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
