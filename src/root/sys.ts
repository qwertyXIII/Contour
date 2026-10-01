import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Системные команды помощника: systemctl, ip, awg/wg. Только execFile с
 * массивом аргументов — никакой оболочки, никакой склейки строк: имя выхода
 * уже проверено регуляркой, но команда не должна полагаться и на это.
 */

const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env: { PATH, LANG: 'C.UTF-8' }, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

export async function systemctl(...args: string[]): Promise<void> {
  const r = await run('systemctl', args, 120_000);
  if (r.code !== 0) {
    // Причина обычно в журнале unit'а — последние строки, чтобы панель показала словами.
    const unit = args.find((a) => a.includes('.service') || a.includes('@'));
    const tail = unit ? (await run('journalctl', ['-u', unit, '-n', '8', '--no-pager', '-o', 'cat'])).out.trim() : '';
    throw new Error(`systemctl ${args.join(' ')}: ${(r.err || r.out).trim() || `код ${r.code}`}${tail ? `\n${tail}` : ''}`);
  }
}

export async function unitState(unit: string): Promise<string> {
  return (await run('systemctl', ['is-active', unit])).out.trim() || 'unknown';
}

/** gid группы по /etc/group — для прав на сокет. */
export function groupId(name: string): number {
  const line = readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.startsWith(`${name}:`));
  const gid = line ? Number(line.split(':')[2]) : NaN;
  if (!Number.isInteger(gid)) throw new Error(`нет группы ${name}`);
  return gid;
}

/** Состояние ядерного туннеля: namespace, рукопожатие, байты. */
export async function netnsRuntime(name: string, bridge: number, protocol: string): Promise<{ up: boolean; handshakeAgoS: number | null; rxBytes: number; txBytes: number }> {
  const ns = `ct-${name}`;
  const dev = protocol === 'openvpn' ? `ctt${bridge}` : `ctw${bridge}`;
  const link = await run('ip', ['-n', ns, '-j', '-s', 'link', 'show', 'dev', dev]);
  if (link.code !== 0) return { up: false, handshakeAgoS: null, rxBytes: 0, txBytes: 0 };
  let rx = 0;
  let tx = 0;
  try {
    const j = JSON.parse(link.out) as Array<{ stats64?: { rx?: { bytes?: number }; tx?: { bytes?: number } } }>;
    rx = j[0]?.stats64?.rx?.bytes ?? 0;
    tx = j[0]?.stats64?.tx?.bytes ?? 0;
  } catch {
    // старый ip без -j — байтов не будет, остальное есть
  }
  let handshakeAgoS: number | null = null;
  if (protocol !== 'openvpn') {
    const tool = protocol === 'amneziawg' ? 'awg' : 'wg';
    const hs = await run('ip', ['netns', 'exec', ns, tool, 'show', dev, 'latest-handshakes']);
    const ts = Number(hs.out.trim().split(/\s+/)[1]);
    if (ts > 0) handshakeAgoS = Math.max(0, Math.round(Date.now() / 1000 - ts));
  }
  return { up: true, handshakeAgoS, rxBytes: rx, txBytes: tx };
}
