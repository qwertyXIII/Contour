import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq, type Document } from 'yaml';
import { parseConfig, type OutletConfig } from '../config.ts';

/**
 * Правка списка выходов в `contour.yaml` — с сохранением комментариев.
 *
 * Через Document API библиотеки `yaml`: файл владелец писал руками, с
 * комментариями, и они должны пережить правку из панели. Перед записью итог
 * проверяется тем же `parseConfig`, что читает Contour: сломанный файл не
 * пишется. Старая версия — рядом, `contour.yaml.bak`.
 */

export class ConfigEditError extends Error {}

function load(path: string): Document {
  const doc = parseDocument(readFileSync(path, 'utf8'));
  if (doc.errors.length > 0) throw new ConfigEditError(`contour.yaml не разбирается: ${doc.errors[0]?.message}`);
  return doc;
}

function outletsSeq(doc: Document): YAMLSeq {
  const seq = doc.get('outlets');
  if (isSeq(seq)) return seq;
  const fresh = new YAMLSeq();
  doc.set('outlets', fresh);
  return fresh;
}

function indexOf(seq: YAMLSeq, name: string): number {
  return seq.items.findIndex((item) => isMap(item) && item.get('name') === name);
}

function save(path: string, doc: Document): void {
  const text = doc.toString({ lineWidth: 0 });
  parseConfig(text); // бросит ConfigError — и файл останется прежним
  copyFileSync(path, `${path}.bak`);
  writeFileSync(`${path}.tmp`, text, { mode: 0o640 });
  renameSync(`${path}.tmp`, path);
}

export function readOutlets(path: string): OutletConfig[] {
  return parseConfig(readFileSync(path, 'utf8')).outlets;
}

/** Свободный номер моста для нового ядерного выхода. */
export function freeBridge(outlets: OutletConfig[]): number {
  const used = new Set(outlets.map((o) => o.bridge).filter((b): b is number => b !== null));
  for (let b = 1; b <= 250; b += 1) if (!used.has(b)) return b;
  throw new ConfigEditError('свободных мостов нет (250 ядерных выходов)');
}

export function addOutlet(path: string, entry: Record<string, unknown>): void {
  const doc = load(path);
  const seq = outletsSeq(doc);
  if (indexOf(seq, String(entry.name)) >= 0) throw new ConfigEditError(`выход «${String(entry.name)}» уже есть`);
  const map = new YAMLMap();
  for (const [k, v] of Object.entries(entry)) if (v !== undefined && v !== null) map.set(k, v);
  seq.items.push(map);
  save(path, doc);
}

export function removeOutlet(path: string, name: string): void {
  const doc = load(path);
  const seq = outletsSeq(doc);
  const i = indexOf(seq, name);
  if (i < 0) throw new ConfigEditError(`выхода «${name}» нет`);
  seq.items.splice(i, 1);
  save(path, doc);
}

export function setOutletField(path: string, name: string, key: 'enabled' | 'priority', value: boolean | number): void {
  const doc = load(path);
  const seq = outletsSeq(doc);
  const i = indexOf(seq, name);
  if (i < 0) throw new ConfigEditError(`выхода «${name}» нет`);
  (seq.items[i] as YAMLMap).set(key, value);
  save(path, doc);
}
