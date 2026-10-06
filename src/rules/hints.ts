/**
 * Подсказки панели «добавь подсеть в правило»: имя правила «только через
 * выход» разрешилось DNS выхода во внутренний адрес, а подсети этого адреса в
 * правилах нет — ограда соединение не пустила. Ограду сами не расширяем
 * (решение владельца 2026-10-06: внутренние подсети — явно, в правиле), но и
 * гадать не заставляем: панель показывает имя, адрес и предлагает его /24 одной
 * кнопкой, в тот же список.
 *
 * Только в памяти: после перезапуска подсказка вернётся с первой же попыткой.
 */

export type InternalHint = {
  /** Имя, которое просили. */
  name: string;
  /** Внутренний адрес от DNS выхода. */
  ip: string;
  /** Через какой выход. */
  outlet: string;
  /** Предлагаемая подсеть — /24 адреса. */
  net: string;
  /** Список, чьё правило взяло имя (заголовок — так источник зовёт движок). */
  list: string;
  at: number;
};

const MAX = 20;
const KEEP_MS = 3 * 86_400_000;

export const net24 = (ip: string): string => `${ip.split('.').slice(0, 3).join('.')}.0/24`;

export class InternalHints {
  private readonly items = new Map<string, InternalHint>();

  /** Новая попытка того же имени — наверх; больше `MAX` — старые долой. */
  note(h: Omit<InternalHint, 'net' | 'at'>, now = Date.now()): void {
    this.items.delete(h.name);
    this.items.set(h.name, { ...h, net: net24(h.ip), at: now });
    while (this.items.size > MAX) this.items.delete(this.items.keys().next().value as string);
  }

  /** Свежие, новые первыми; `covered` — уже в правилах (подсеть добавили) — не показывать. */
  list(covered: (h: InternalHint) => boolean, now = Date.now()): InternalHint[] {
    for (const [k, h] of this.items) if (now - h.at > KEEP_MS || covered(h)) this.items.delete(k);
    return [...this.items.values()].reverse();
  }

  get(name: string): InternalHint | undefined {
    return this.items.get(name);
  }

  forget(name: string): void {
    this.items.delete(name);
  }
}

/** Текст списка с подсетью подсказки — своим разделом того же назначения в конце: где бы ни стояло имя, строка попадёт куда надо. */
export function withHintNet(text: string, h: InternalHint, section: string): string {
  return `${text.replace(/\s*$/, '')}\n\n# ${h.name} → ${h.ip} (DNS выхода «${h.outlet}») — подсеть добавлена из панели\n${section}\n${h.net}\n`;
}
