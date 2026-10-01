/**
 * Ссылки прокси-протоколов → выход mihomo.
 *
 * Понимает то, что выдают панели и подписки: `vless://`, `vmess://`,
 * `trojan://`, `ss://`, `hysteria2://` (и `hy2://`). Результат — объект
 * `proxies` конфига mihomo без имени (имя ставит Contour — это имя выхода).
 * Чего не понял — ошибка словами, а не молча кривой выход.
 *
 * Ключи из ссылки (uuid, пароль) не логируются; `describeLink` отдаёт только
 * протокол, сервер и транспорт.
 */

export type MihomoProxy = Record<string, unknown> & { type: string; server: string; port: number };

export class LinkError extends Error {}

const SCHEMES = ['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2'] as const;

function b64decode(text: string): string {
  const norm = text.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(norm + '='.repeat((4 - (norm.length % 4)) % 4), 'base64').toString('utf8');
}

function port(value: string | number, where: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new LinkError(`${where}: порт «${value}» не число от 1 до 65535`);
  return n;
}

function truthy(v: string | null): boolean {
  return v === '1' || v === 'true';
}

/** Транспорт (ws / grpc / h2) — общий у vless, vmess и trojan. */
function transport(net: string, opts: { path?: string | null; host?: string | null; service?: string | null }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (net && net !== 'tcp') out.network = net;
  if (net === 'ws') out['ws-opts'] = { path: opts.path || '/', ...(opts.host ? { headers: { Host: opts.host } } : {}) };
  if (net === 'grpc') out['grpc-opts'] = { 'grpc-service-name': opts.service ?? '' };
  if (net === 'h2') out['h2-opts'] = { path: opts.path || '/', ...(opts.host ? { host: [opts.host] } : {}) };
  return out;
}

function parseVless(u: URL): MihomoProxy {
  const q = u.searchParams;
  const security = q.get('security') ?? 'none';
  const proxy: MihomoProxy = {
    type: 'vless',
    server: u.hostname.replace(/^\[|\]$/g, ''),
    port: port(u.port, 'vless'),
    uuid: decodeURIComponent(u.username),
    udp: true,
    ...transport(q.get('type') ?? 'tcp', { path: q.get('path'), host: q.get('host'), service: q.get('serviceName') }),
  };
  if (!proxy.uuid) throw new LinkError('vless: нет uuid');
  if (q.get('flow')) proxy.flow = q.get('flow');
  if (security === 'tls' || security === 'reality') {
    proxy.tls = true;
    if (q.get('sni')) proxy.servername = q.get('sni');
    if (q.get('fp')) proxy['client-fingerprint'] = q.get('fp');
    if (truthy(q.get('allowInsecure'))) proxy['skip-cert-verify'] = true;
  }
  if (security === 'reality') {
    const pbk = q.get('pbk');
    if (!pbk) throw new LinkError('vless + reality: нет pbk (публичного ключа)');
    proxy['reality-opts'] = { 'public-key': pbk, ...(q.get('sid') ? { 'short-id': q.get('sid') } : {}) };
    if (!proxy['client-fingerprint']) proxy['client-fingerprint'] = 'chrome';
  }
  return proxy;
}

function parseVmess(body: string): MihomoProxy {
  let j: Record<string, string | number>;
  try {
    j = JSON.parse(b64decode(body));
  } catch {
    throw new LinkError('vmess: внутри не base64 с JSON');
  }
  const net = String(j.net ?? 'tcp');
  const proxy: MihomoProxy = {
    type: 'vmess',
    server: String(j.add ?? ''),
    port: port(j.port ?? '', 'vmess'),
    uuid: String(j.id ?? ''),
    alterId: Number(j.aid ?? 0) || 0,
    cipher: String(j.scy || 'auto'),
    udp: true,
    ...transport(net, { path: String(j.path ?? ''), host: String(j.host ?? '') || null, service: String(j.path ?? '') }),
  };
  if (!proxy.server || !proxy.uuid) throw new LinkError('vmess: нет адреса или id');
  if (j.tls === 'tls') {
    proxy.tls = true;
    const sni = String(j.sni || j.host || '');
    if (sni) proxy.servername = sni;
    if (j.fp) proxy['client-fingerprint'] = String(j.fp);
  }
  return proxy;
}

function parseTrojan(u: URL): MihomoProxy {
  const q = u.searchParams;
  const proxy: MihomoProxy = {
    type: 'trojan',
    server: u.hostname.replace(/^\[|\]$/g, ''),
    port: port(u.port || 443, 'trojan'),
    password: decodeURIComponent(u.username),
    udp: true,
    ...transport(q.get('type') ?? 'tcp', { path: q.get('path'), host: q.get('host'), service: q.get('serviceName') }),
  };
  if (!proxy.password) throw new LinkError('trojan: нет пароля');
  if (q.get('sni')) proxy.sni = q.get('sni');
  if (q.get('fp')) proxy['client-fingerprint'] = q.get('fp');
  if (truthy(q.get('allowInsecure'))) proxy['skip-cert-verify'] = true;
  return proxy;
}

/** `ss://base64(method:password)@host:port` или `ss://base64(method:password@host:port)`. */
function parseSs(raw: string): MihomoProxy {
  const body = raw.slice('ss://'.length).replace(/#.*$/, '').replace(/\/?\?.*$/, '');
  let method: string;
  let password: string;
  let hostPort: string;
  const at = body.lastIndexOf('@');
  if (at >= 0) {
    const cred = decodeURIComponent(body.slice(0, at));
    const plain = cred.includes(':') ? cred : b64decode(cred);
    [method, password] = [plain.slice(0, plain.indexOf(':')), plain.slice(plain.indexOf(':') + 1)];
    hostPort = body.slice(at + 1);
  } else {
    const plain = b64decode(body);
    const at2 = plain.lastIndexOf('@');
    if (at2 < 0) throw new LinkError('ss: не разобрать');
    const cred = plain.slice(0, at2);
    [method, password] = [cred.slice(0, cred.indexOf(':')), cred.slice(cred.indexOf(':') + 1)];
    hostPort = plain.slice(at2 + 1);
  }
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(hostPort);
  if (!m || !method || !password) throw new LinkError('ss: нужен метод, пароль, сервер и порт');
  return { type: 'ss', server: m[1] as string, port: port(m[2] as string, 'ss'), cipher: method, password, udp: true };
}

function parseHysteria2(u: URL): MihomoProxy {
  const q = u.searchParams;
  const proxy: MihomoProxy = {
    type: 'hysteria2',
    server: u.hostname.replace(/^\[|\]$/g, ''),
    port: port(u.port || 443, 'hysteria2'),
    password: decodeURIComponent(u.username || u.password),
  };
  if (q.get('sni')) proxy.sni = q.get('sni');
  if (truthy(q.get('insecure'))) proxy['skip-cert-verify'] = true;
  if (q.get('obfs')) {
    proxy.obfs = q.get('obfs');
    if (q.get('obfs-password')) proxy['obfs-password'] = q.get('obfs-password');
  }
  return proxy;
}

export function isLink(text: string): boolean {
  const scheme = text.trim().split('://')[0]?.toLowerCase() ?? '';
  return (SCHEMES as readonly string[]).includes(scheme);
}

export function parseLink(text: string): MihomoProxy {
  const raw = text.trim();
  const scheme = raw.split('://')[0]?.toLowerCase();
  if (scheme === 'vmess') return parseVmess(raw.slice('vmess://'.length).replace(/#.*$/, ''));
  if (scheme === 'ss') return parseSs(raw);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new LinkError('ссылка не разбирается');
  }
  if (scheme === 'vless') return parseVless(u);
  if (scheme === 'trojan') return parseTrojan(u);
  if (scheme === 'hysteria2' || scheme === 'hy2') return parseHysteria2(u);
  throw new LinkError(`протокол «${scheme}» не поддерживается — vless, vmess, trojan, ss, hysteria2`);
}

/** Что можно показать о ссылке: без uuid и паролей. */
export function describeLink(p: MihomoProxy): string {
  const net = typeof p.network === 'string' ? `, ${p.network}` : '';
  const reality = p['reality-opts'] ? ', Reality' : p.tls ? ', TLS' : '';
  return `${String(p.type).toUpperCase()}, ${p.server}:${p.port}${net}${reality}`;
}
