import http from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { errorText, type Logger } from '../log.ts';
import { apiRouter, type RoutesDeps } from './routes.ts';

/**
 * Веб-панель Contour.
 *
 * Сама слушает только `127.0.0.1:18090` (ssh-тоннель, проверки). Из домашней
 * сети её отдаёт вход lan: запрос на `:80` второго адреса с Host `vpn.home`
 * или самим адресом передаётся сюда целым сокетом (`take`). Наружу из дома её
 * не видно: адрес домашний, nginx не тронут.
 *
 * Статика — `web/` (страница) и `web/shared/` (копия дизайн-системы Alter'а,
 * по тому же адресу `/shared/`, что и в Alter'е: пути внутри неё не меняются).
 */

const WEB = path.join(import.meta.dirname, '../../web');

export type Panel = { server: http.Server; take: (socket: Socket, head: Buffer) => void };

function staticFiles(app: express.Express): void {
  // Шрифты названы по хешу содержимого — их можно держать вечно; остальное — проверять каждый раз.
  app.use('/shared/assets/fonts', express.static(path.join(WEB, 'shared/assets/fonts'), { maxAge: '365d', immutable: true }));
  app.use(express.static(WEB, { maxAge: 0, etag: true, index: 'index.html' }));
}

function security(app: express.Express): void {
  app.disable('x-powered-by');
  app.use(helmet({
    // Панель ходит по http внутри дома: «повышать» запросы до https и HSTS здесь сломали бы всё.
    strictTransportSecurity: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'upgrade-insecure-requests': null,
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
      },
    },
  }));
}

export function createPanel(opts: RoutesDeps & { listen: string; port: number; log: Logger }): Panel {
  const app = express();
  security(app);
  // Списки правил приходят текстом целиком (файл до 5 МБ); остальному хватит малого.
  app.use('/api/rules/lists', express.json({ limit: '6mb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', apiRouter(opts));
  staticFiles(app);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) opts.log.error(`панель: ${errorText(err)}`);
    res.status(status).json({ ok: false, error: { code: status === 413 ? 'TOO_LARGE' : 'INTERNAL', message: status === 413 ? 'слишком большой запрос' : 'внутренняя ошибка' } });
  });

  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.listen(opts.port, opts.listen, () => opts.log.info(`панель слушает ${opts.listen}:${opts.port}`));
  server.on('error', (e) => opts.log.error(`панель не открылась на ${opts.listen}:${opts.port}: ${e.message}`));
  return {
    server,
    take(socket, head) {
      if (head.length > 0) socket.unshift(head);
      server.emit('connection', socket);
      socket.resume();
    },
  };
}
