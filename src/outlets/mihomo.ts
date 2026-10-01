import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '../log.ts';

/**
 * mihomo — дочерний процесс Contour, а не отдельный unit.
 *
 * Конфиг собирает Contour, и перезапускать ядро после смены выходов должен он
 * же — без sudo и без systemctl. Упало — поднимаем с нарастающей паузой;
 * строки его лога идут в наш лог с пометкой `src: mihomo`.
 */

export type MihomoHandle = {
  /** Ядро отвечает по API управления — можно открывать входы. */
  ready: Promise<void>;
  stop(): Promise<void>;
};

type Options = {
  bin: string;
  dir: string;
  configPath: string;
  controller: string;
  secret: string;
  log: Logger;
  /** Имя в журнале: `mihomo` — выходы, `edge` — край раздачи (`share/edge.ts`). */
  label?: string;
};

const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const BACKOFF_MS = [1_000, 3_000, 10_000, 30_000];

function forwardLines(stream: NodeJS.ReadableStream, write: (line: string) => void): void {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) write(line);
  });
  stream.on('end', () => { if (rest.trim()) write(rest); });
}

/** mihomo пишет `time="…" level=warning msg="…"` — уровень берём его, время своё. */
function levelOf(line: string): 'debug' | 'info' | 'warn' | 'error' {
  const m = /level=(\w+)/.exec(line);
  const level = m?.[1];
  if (level === 'error' || level === 'fatal' || level === 'panic') return 'error';
  if (level === 'warning' || level === 'warn') return 'warn';
  if (level === 'debug') return 'debug';
  return 'info';
}

async function waitReady(controller: string, secret: string, log: Logger, label: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${controller}/version`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) {
        const body = await res.json() as { version?: string };
        log.info(`${label} отвечает: ${body.version ?? '?'}`);
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(300);
  }
  throw new Error(`${label} не ответил по API за ${READY_TIMEOUT_MS / 1000} с: ${lastError}`);
}

export function runMihomo(opts: Options): MihomoHandle {
  const label = opts.label ?? 'mihomo';
  const log = opts.log.child({ src: label });
  let child: ChildProcess | null = null;
  let stopping = false;
  let crashes = 0;

  const start = (): void => {
    child = spawn(opts.bin, ['-d', opts.dir, '-f', opts.configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const pid = child.pid;
    opts.log.info(`${label} запущен, pid ${pid}`);
    if (child.stdout) forwardLines(child.stdout, (line) => log[levelOf(line)](line));
    if (child.stderr) forwardLines(child.stderr, (line) => log[levelOf(line)](line));
    child.on('error', (error) => opts.log.error(`${label} не запустился: ${error.message}`));
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      const pause = BACKOFF_MS[Math.min(crashes, BACKOFF_MS.length - 1)] as number;
      crashes += 1;
      opts.log.error(`${label} завершился (код ${code ?? '—'}, сигнал ${signal ?? '—'}), перезапуск через ${pause / 1000} с`);
      setTimeout(() => { if (!stopping) start(); }, pause).unref();
    });
  };

  start();
  const ready = waitReady(opts.controller, opts.secret, opts.log, label).then(() => { crashes = 0; });

  return {
    ready,
    async stop() {
      stopping = true;
      const c = child;
      if (!c) return;
      c.kill('SIGTERM');
      const exited = once(c, 'exit');
      const timer = sleep(STOP_TIMEOUT_MS).then(() => 'timeout' as const);
      if (await Promise.race([exited.then(() => 'exited' as const), timer]) === 'timeout') {
        opts.log.warn(`${label} не вышел по SIGTERM — SIGKILL`);
        c.kill('SIGKILL');
      }
    },
  };
}
