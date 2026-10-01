import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

/**
 * Вход в панель — один пароль владельца.
 *
 * Хеш — scrypt из node:crypto (не bcrypt: нативная сборка ради одного
 * пароля не нужна, а scrypt не слабее). Файл `/etc/contour/panel.json`
 * пишет install.sh или `deploy/panel-password.sh`; сам пароль нигде не
 * хранится и не логируется.
 *
 * Сессии — в памяти и в файле (`sessions.json`, по sha256 от идентификатора —
 * сам идентификатор на диск не попадает): помощник перезапускает Contour после
 * каждой правки выхода, и без файла каждая правка выкидывала бы из панели.
 * Redis ради одного человека не нужен. Кука `HttpOnly`, `SameSite=Strict`;
 * панель ходит по http внутри дома, поэтому без `Secure`.
 *
 * Защита от подделки запроса с чужой страницы: изменяющие запросы требуют
 * заголовок `X-Contour: 1` — чужая страница не может его поставить без
 * разрешения CORS, а его панель не даёт.
 */

export const COOKIE = 'contour_session';
const SESSION_MS = 30 * 24 * 3_600_000;
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 };

type PasswordFile = { salt: string; hash: string; N: number; r: number; p: number };

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (e, key) => (e ? reject(e) : resolve(key))));
}

export async function hashPassword(password: string): Promise<PasswordFile> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { salt: salt.toString('base64'), hash: key.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
}

const digest = (id: string): string => createHash('sha256').update(id).digest('base64url');

export class Auth {
  private readonly sessions = new Map<string, number>();
  private readonly file: string;
  private readonly sessionsFile: string;

  constructor(passwordFile: string, dataDir: string) {
    this.file = passwordFile;
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    try {
      const raw = JSON.parse(readFileSync(this.sessionsFile, 'utf8')) as Record<string, number>;
      const now = Date.now();
      for (const [k, until] of Object.entries(raw)) if (until > now) this.sessions.set(k, until);
    } catch {
      // сессий ещё не было
    }
  }

  private saveSessions(): void {
    try {
      mkdirSync(path.dirname(this.sessionsFile), { recursive: true });
      writeFileSync(`${this.sessionsFile}.tmp`, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 });
      renameSync(`${this.sessionsFile}.tmp`, this.sessionsFile);
    } catch {
      // не сохранилось — переживём: войти можно заново
    }
  }

  /** Есть ли пароль вообще — без него панель отвечает «не настроена». */
  configured(): boolean {
    try {
      this.read();
      return true;
    } catch {
      return false;
    }
  }

  private read(): PasswordFile {
    const j = JSON.parse(readFileSync(this.file, 'utf8')) as PasswordFile;
    if (!j.salt || !j.hash) throw new Error('нет хеша');
    return j;
  }

  async check(password: string): Promise<boolean> {
    let f: PasswordFile;
    try {
      f = this.read();
    } catch {
      return false;
    }
    const expected = Buffer.from(f.hash, 'base64');
    const got = await scrypt(password, Buffer.from(f.salt, 'base64'), expected.length, { N: f.N, r: f.r, p: f.p });
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  open(): string {
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(digest(id), Date.now() + SESSION_MS);
    this.saveSessions();
    return id;
  }

  close(id: string | undefined): void {
    if (id && this.sessions.delete(digest(id))) this.saveSessions();
  }

  valid(id: string | undefined): boolean {
    if (!id) return false;
    const key = digest(id);
    const until = this.sessions.get(key);
    if (!until || until < Date.now()) {
      if (this.sessions.delete(key)) this.saveSessions();
      return false;
    }
    return true;
  }

  cookie(id: string): string {
    return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
  }
}

export function sessionOf(req: Request): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
}

/** Только для вошедших; изменяющие запросы — ещё и с X-Contour. */
export function requireAuth(auth: Auth) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!auth.valid(sessionOf(req))) {
      res.status(401).json({ ok: false, error: { code: 'AUTH', message: 'нужно войти' } });
      return;
    }
    if (req.method !== 'GET' && req.headers['x-contour'] !== '1') {
      res.status(403).json({ ok: false, error: { code: 'CSRF', message: 'запрос не из панели' } });
      return;
    }
    next();
  };
}
