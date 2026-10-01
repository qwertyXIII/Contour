import net from 'node:net';

/**
 * Договор между панелью (пользователь `contour`) и помощником от root.
 *
 * Unix-сокет `/run/contour/root.sock` с правами `root:contour 660`: говорить
 * может только группа `contour`. Строка JSON на запрос, строка JSON на ответ.
 * Команд мало, и каждая проверяет свои аргументы сама — помощник не верит
 * панели: дыра в панели не должна стать root на машине.
 */

export const ROOT_SOCKET = '/run/contour/root.sock';
/** Предел запроса: ключ или .ovpn с сертификатами — десятки КБ, не мегабайты. */
export const MAX_REQUEST_BYTES = 256 * 1024;

export type AddSource = 'conf' | 'link' | 'subscription' | 'ovpn';
/** Логин и пароль OpenVPN (`auth-user-pass`). Лежат у root в `<имя>.auth`, 600. */
export type OvpnAuth = { user: string; pass: string };

export type RootRequest =
  | { cmd: 'status' }
  | { cmd: 'outlet.add'; name: string; source: AddSource; text: string; priority?: number; auth?: OvpnAuth }
  | { cmd: 'outlet.remove'; name: string }
  | { cmd: 'outlet.restart'; name: string }
  | { cmd: 'outlet.enable'; name: string; enabled: boolean }
  | { cmd: 'outlet.priority'; name: string; priority: number }
  | { cmd: 'outlet.activate'; name: string }
  | { cmd: 'outlet.group'; name: string; with: string | null }
  | { cmd: 'gateway.set'; mac: string; mode: 'blocked' | 'all' | null }
  | { cmd: 'gateway.allow'; ips: string[]; ttl: number }
  | { cmd: 'contour.restart' };

export type OutletRuntime = {
  name: string;
  kind: 'netns' | 'mihomo';
  protocol: string;
  enabled: boolean;
  priority: number;
  /** Группа соперников (config.ts → OutletConfig.group). */
  group: string | null;
  /** Что о выходе можно показать: протокол, сервер. Без ключей. */
  about: string;
  /** Для ядерных: поднят ли namespace, рукопожатие, байты туннеля. */
  up?: boolean;
  handshakeAgoS?: number | null;
  rxBytes?: number;
  txBytes?: number;
};

export type RootStatus = {
  units: Record<string, string>;
  outlets: OutletRuntime[];
};

export type RootResponse = { ok: true; data?: unknown } | { ok: false; error: string };

/** Запрос помощнику; ответ — или ошибка словами. */
export function rootCall<T = unknown>(req: RootRequest, timeoutMs = 120_000, socketPath = ROOT_SOCKET): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('помощник не ответил')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      socket.end();
      let res: RootResponse;
      try {
        res = JSON.parse(buf.slice(0, nl)) as RootResponse;
      } catch {
        reject(new Error('помощник ответил непонятно'));
        return;
      }
      if (res.ok) resolve(res.data as T);
      else reject(new Error(res.error));
    });
    socket.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const words: Record<string, string> = {
        ENOENT: 'помощник от root не запущен (contour-root)',
        ECONNREFUSED: 'помощник от root не запущен (contour-root)',
        EACCES: 'нет прав на сокет помощника — процесс не в группе contour',
      };
      reject(new Error(words[e.code ?? ''] ?? e.message));
    });
  });
}
