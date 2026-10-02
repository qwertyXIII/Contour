import { chmodSync, chownSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { errorText, log } from '../log.ts';
import { allowAddresses, applyGateway, seenDevices, setDeviceMode, setNets, syncGatewayRoutes } from './gateway.ts';
import { setFenceAllow } from './fence-allow.ts';
import { declareClasses, routeAddresses } from './gateway-classes.ts';
import { activateOutletCmd, addOutletCmd, enableOutletCmd, groupOutletCmd, priorityOutletCmd, removeOutletCmd, restartContourCmd, restartOutletCmd, statusCmd } from './outlets.ts';
import { MAX_REQUEST_BYTES, ROOT_SOCKET, type RootRequest, type RootResponse } from './protocol.ts';
import { groupId } from './sys.ts';

/**
 * `contour-root` — помощник от root для панели: поднять и снять выходы,
 * положить ключ, перезапустить сервисы. Всё остальное Contour делает без root.
 *
 * Запускается из `/opt/contour/root-app` — копии кода от root, которую кладёт
 * install.sh. Не из папки владельца: правка кода там не должна становиться
 * командой от root.
 *
 * Изменяющие команды идут строго по одной: два одновременных «добавить выход»
 * получили бы один номер моста.
 */

const rlog = log.child({ src: 'root' });
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

/** Сверить маршруты классов шлюза; ошибка — в журнал, следующая сверка повторит. */
async function syncRoutes(force: boolean): Promise<void> {
  try {
    await syncGatewayRoutes(force);
  } catch (error) {
    rlog.warn(`шлюз: маршруты классов не сверены — ${errorText(error)}`);
  }
}

/** Команда над выходами — и сразу сверка маршрутов классов: мост выхода мог подняться или уйти. */
function outletJob<T>(job: () => Promise<T>): Promise<T> {
  return serial(async () => {
    try {
      return await job();
    } finally {
      await syncRoutes(true);
    }
  });
}

async function dispatch(req: RootRequest): Promise<unknown> {
  switch (req.cmd) {
    case 'status': return statusCmd();
    case 'outlet.add': return outletJob(() => addOutletCmd(req));
    case 'outlet.remove': return outletJob(() => removeOutletCmd(req));
    case 'outlet.restart': return outletJob(() => restartOutletCmd(req));
    case 'outlet.enable': return outletJob(() => enableOutletCmd(req));
    case 'outlet.priority': return outletJob(() => priorityOutletCmd(req));
    case 'outlet.activate': return outletJob(() => activateOutletCmd(req));
    case 'outlet.group': return outletJob(() => groupOutletCmd(req));
    case 'gateway.set': return serial(() => setDeviceMode(req.mac, req.mode));
    // Не в общую очередь: DNS ждёт ответа перед ответом устройству, а очередь может стоять за минутным подъёмом выхода.
    case 'gateway.allow': return allowAddresses(req.ips, req.ttl);
    case 'gateway.route': return routeAddresses(req.ips, req.ttl, req.route);
    case 'gateway.classes': return serial(() => declareClasses(req.classes));
    case 'gateway.seen': return seenDevices();
    case 'gateway.nets': return serial(() => setNets(req.cidrs));
    case 'outlet.fence': return outletJob(() => setFenceAllow(req));
    case 'contour.restart': return serial(async () => restartContourCmd());
    default: throw new Error('неизвестная команда');
  }
}

/** Что сделано — в журнал помощника; ключи и тексты не пишутся. */
function describe(req: RootRequest): string {
  const name = 'name' in req ? ` «${String(req.name)}»` : '';
  const extra = req.cmd === 'outlet.add' ? ` (${req.source})`
    : req.cmd === 'outlet.enable' ? ` → ${req.enabled ? 'вкл' : 'выкл'}`
    : req.cmd === 'outlet.group' ? ` → ${req.with === null ? 'без соперника' : `соперник «${String(req.with)}»`}`
    : req.cmd === 'gateway.set' ? ` ${String(req.mac)} → ${req.mode ?? 'выкл'}`
    : req.cmd === 'gateway.nets' ? ` — ${Array.isArray(req.cidrs) ? req.cidrs.length : '?'} подсетей`
    : req.cmd === 'gateway.classes' ? ` — ${Array.isArray(req.classes) ? req.classes.map((c) => String(c?.name)).join(', ') || 'без классов' : '?'}` : '';
  return `${req.cmd}${name}${extra}`;
}

function handle(socket: net.Socket): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.setTimeout(10_000, () => socket.destroy());
  socket.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_REQUEST_BYTES) { socket.destroy(); return; }
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    socket.setTimeout(0);
    let req: RootRequest;
    try {
      req = JSON.parse(buf.slice(0, nl)) as RootRequest;
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: 'запрос не JSON' })}\n`);
      return;
    }
    // gateway.allow и gateway.route — десятки в минуту от DNS: журналу помощника они не нужны.
    const mutating = req.cmd !== 'status' && req.cmd !== 'gateway.allow' && req.cmd !== 'gateway.route' && req.cmd !== 'gateway.seen';
    void dispatch(req).then(
      (data) => {
        if (mutating) rlog.info(`сделано: ${describe(req)}`);
        socket.end(`${JSON.stringify({ ok: true, data } satisfies RootResponse)}\n`);
      },
      (error: unknown) => {
        if (mutating) rlog.warn(`не вышло: ${describe(req)} — ${errorText(error).split('\n')[0]}`);
        socket.end(`${JSON.stringify({ ok: false, error: errorText(error) } satisfies RootResponse)}\n`);
      },
    );
  });
  socket.on('error', () => socket.destroy());
}

function listen(): void {
  const dir = path.dirname(ROOT_SOCKET);
  const gid = groupId('contour');
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  chownSync(dir, 0, gid);
  chmodSync(dir, 0o750);
  rmSync(ROOT_SOCKET, { force: true });
  const server = net.createServer(handle);
  server.listen(ROOT_SOCKET, () => {
    chownSync(ROOT_SOCKET, 0, gid);
    chmodSync(ROOT_SOCKET, 0o660);
    rlog.info(`помощник слушает ${ROOT_SOCKET} (root:contour 660)`);
  });
  const stop = (): void => { server.close(); rmSync(ROOT_SOCKET, { force: true }); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/**
 * Шлюз — из файла, при каждом запуске помощника: так он переживает и перезагрузку
 * сервера, и перезапуск помощника. При загрузке сети может ещё не быть — повтор.
 * Каждая попытка — в общей очереди: `gateway.classes`, пришедший сразу после
 * запуска, иначе мог бы лечь раньше, а подъём из файла — затереть его старым набором.
 */
async function restoreGateway(): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await serial(() => applyGateway());
      return;
    } catch (error) {
      if (attempt === 1 || attempt === 30) rlog.warn(`шлюз не поднять (попытка ${attempt}): ${errorText(error)}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

if (process.getuid?.() !== 0) {
  rlog.error('contour-root должен работать от root');
  process.exit(1);
}
/**
 * Подъём выхода ловится сверкой: выход поднимает systemd (при загрузке, по
 * команде, руками) — помощник об этом не узнаёт иначе. Падение отрабатывает
 * ядро само: маршрут уходит вместе с мостом. Сверка без перемен — один `ip -j addr`.
 */
const ROUTES_TICK_MS = 5_000;
let ticking = false;

listen();
void restoreGateway().then(() => {
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    void serial(() => syncRoutes(false)).finally(() => { ticking = false; });
  }, ROUTES_TICK_MS);
});
