import encodeQR from 'qr';
import type { ShareDevice, ShareSettings } from './store.ts';

/**
 * Что телефону дать, чтобы он подключился: сервер (ссылка `vless://` и её
 * QR) и правила (ссылка на конфиг и та же ссылка «открыть в Shadowrocket»).
 *
 * `alpn=http/1.1` — нарочно: nginx на 443 говорит и HTTP/2, а WebSocket через
 * nginx живёт только поверх HTTP/1.1; клиент, выбравший h2, до края не дойдёт.
 */

export type ShareLinks = { server: string; config: string; open: string; qr: string };

export function shareLinks(d: ShareDevice, s: ShareSettings): ShareLinks | null {
  if (!s.domain) return null;
  const q = new URLSearchParams({ encryption: 'none', security: 'tls', sni: s.domain, alpn: 'http/1.1', type: 'ws', host: s.domain, path: s.path });
  const server = `vless://${d.uuid}@${s.domain}:443?${q.toString()}#${encodeURIComponent('Contour')}`;
  const config = `https://${s.domain}/list/${d.list}/contour.conf`;
  return { server, config, open: `shadowrocket://config/add/${config}`, qr: qrDataUri(server) };
}

/** QR картинкой для `<img>`: белая подложка — иначе в тёмной теме чёрные модули на прозрачном не видны. */
function qrDataUri(text: string): string {
  const svg = encodeQR(text, 'svg', { ecc: 'medium', border: 2 }).replace(/^<svg([^>]*)>/, '<svg$1><rect width="100%" height="100%" fill="#fff"/>');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
