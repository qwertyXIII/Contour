// Единственная дверь к серверу панели: JSON, таймаут, ошибки словами.
// Изменяющие запросы несут X-Contour: 1 — без него сервер их не примет
// (защита от подделки запроса с чужой страницы).
import { EVENTS, TIMING } from './constants.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, timeout = TIMING.requestMs } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, {
      method,
      signal: ctrl.signal,
      credentials: 'same-origin',
      headers: { 'X-Contour': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'нет связи с Contour');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // не JSON — ниже ошибка
  }
  if (res.status === 401 && path !== '/api/login') document.dispatchEvent(new CustomEvent(EVENTS.authLost));
  if (!res.ok || !json?.ok) {
    throw new ApiError(res.status, json?.error?.code ?? 'HTTP', json?.error?.message ?? `ошибка ${res.status}`);
  }
  return json.data;
}

/** Тост дизайн-системы. */
export function toast(text, tone) {
  document.dispatchEvent(new CustomEvent(EVENTS.toast, { detail: { text, tone } }));
}
