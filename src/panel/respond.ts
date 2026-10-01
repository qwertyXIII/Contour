import type { Request, Response } from 'express';
import type { z } from 'zod';

/** Ответ ошибкой в общем виде API панели: `{ ok: false, error: { code, message } }`. */
export function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ ok: false, error: { code, message } });
}

/** Тело запроса по схеме; не подошло — 400 словами схемы и null. */
export function parse<T>(schema: z.ZodType<T>, req: Request, res: Response): T | null {
  const r = schema.safeParse(req.body);
  if (r.success) return r.data;
  fail(res, 400, 'VALIDATION', r.error.issues[0]?.message ?? 'неверный запрос');
  return null;
}
