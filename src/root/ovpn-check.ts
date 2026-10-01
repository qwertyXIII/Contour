/**
 * Проверка .ovpn перед тем, как отдать его openvpn от root.
 *
 * Конфиг OpenVPN умеет запускать программы (`up`, `down`, `plugin`…) и писать
 * файлы (`log`, `writepid`, `status`) — а openvpn у нас работает от root.
 * Конфиг, пришедший из панели, такие директивы иметь не может: свои
 * (`--up`, `--log-append`, `--writepid`) Contour ставит сам в командной строке.
 * Встроенные блоки (`<ca>…</ca>`) — можно: это данные.
 */

export class OvpnError extends Error {}

const FORBIDDEN = new Set([
  'up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'learn-address', 'client-connect', 'client-disconnect',
  'tls-verify', 'auth-user-pass-verify', 'plugin', 'script-security', 'setenv', 'setenv-safe', 'management',
  'daemon', 'log', 'log-append', 'writepid', 'status', 'cd', 'chroot', 'config', 'user', 'group', 'iproute',
  'tmp-dir', 'askpass', 'dev-node',
]);
// `dev`, `dev-type`, `route`, `redirect-gateway` в клиентских .ovpn обычны и
// безвредны: Contour ставит свои `--dev`/`--dev-type` после `--config`, а
// `--route-noexec` не даёт openvpn трогать маршруты.

/**
 * Возвращает строку «OpenVPN, сервер:порт» или бросает с причиной. `withAuth` —
 * к ключу приложены логин и пароль: тогда голая `auth-user-pass` допустима,
 * файл с ними Contour передаст сам (`--auth-user-pass` после `--config`).
 */
export function checkOvpn(text: string, withAuth = false): string {
  if (!/^\s*remote\s+\S+/m.test(text)) throw new OvpnError('в .ovpn нет строки remote — это не конфиг клиента');
  let inBlock: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const open = /^<([a-z-]+)>$/.exec(line);
    const close = /^<\/([a-z-]+)>$/.exec(line);
    if (inBlock) { if (close?.[1] === inBlock) inBlock = null; continue; }
    if (open) { inBlock = open[1] as string; continue; }
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const directive = line.split(/\s+/)[0]?.toLowerCase().replace(/^--/, '') ?? '';
    if (FORBIDDEN.has(directive)) throw new OvpnError(`директива «${directive}» в .ovpn не допускается: openvpn работает от root, программы и файлы задаёт Contour`);
    if (directive === 'auth-user-pass' && line.split(/\s+/).length > 1) throw new OvpnError('auth-user-pass с путём к файлу не допускается — убери путь, логин и пароль впиши в поля');
    if (directive === 'auth-user-pass' && !withAuth) throw new OvpnError('.ovpn просит логин и пароль — впиши их в поля ниже');
  }
  if (inBlock) throw new OvpnError(`блок <${inBlock}> не закрыт`);
  const m = /^\s*remote\s+(\S+)(?:\s+(\d+))?/m.exec(text);
  return `OpenVPN, ${m?.[1]}:${m?.[2] ?? 1194}`;
}
