import type { Stats } from 'node:fs';

/** Metadata validators are weak: equal metadata is not proof of byte equality. */
export function validator(stat: Stats, encoding: string): string {
  return `W/"${stat.ino.toString(16)}-${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}-${Math.trunc(stat.ctimeMs).toString(16)}-${encoding}"`;
}
const weak = (tag: string) => tag.trim().replace(/^W\//, '');
const tags = (value: string) => value.match(/(?:W\/)?"[^"\r\n]*"|\*/g) ?? [];
const seconds = (ms: number) => Math.floor(ms / 1000) * 1000;

/** RFC 9110 precondition order. Static resources always exist at this point. */
export function precondition(headers: Headers, etag: string, mtime: number): 304 | 412 | undefined {
  const match = headers.get('if-match');
  if (match !== null) {
    if (match.trim() !== '*' && !tags(match).some(t => !t.startsWith('W/') && !etag.startsWith('W/') && t === etag)) return 412;
  } else {
    const date = Date.parse(headers.get('if-unmodified-since') ?? '');
    if (Number.isFinite(date) && seconds(mtime) > date) return 412;
  }
  const none = headers.get('if-none-match');
  if (none !== null) {
    if (none.trim() === '*' || tags(none).some(t => weak(t) === weak(etag))) return 304;
  } else {
    const date = Date.parse(headers.get('if-modified-since') ?? '');
    if (Number.isFinite(date) && seconds(mtime) <= date) return 304;
  }
  return undefined;
}

/** A weak entity tag is never valid for If-Range. Dates must match exactly. */
export function allowsRange(value: string | null, etag: string, mtime: number): boolean {
  if (value === null) return true;
  if (value.startsWith('"') || value.startsWith('W/')) return !etag.startsWith('W/') && value === etag;
  const date = Date.parse(value);
  return Number.isFinite(date) && date === seconds(mtime);
}

/** Ordered acceptable codings. With Range, prefer identity if allowed. */
export function encodings(value: string | null, range: boolean, enabled: boolean): string[] {
  const weights = new Map<string, number>();
  for (const item of (value ?? '').split(',')) {
    const [name, ...params] = item.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map(s => s.trim()).find(s => s.startsWith('q='));
    const weight = q === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q.slice(2)) : 0;
    weights.set(name, weight);
  }
  const quality = (name: string) => weights.get(name) ?? (name === 'identity' ? (weights.get('*') === 0 ? 0 : 1) : weights.get('*') ?? 0);
  const choices = (enabled ? ['br', 'gzip', 'identity'] : ['identity']).filter(n => quality(n) > 0);
  return choices.sort((a, b) => range && (a === 'identity' || b === 'identity') ? (a === 'identity' ? -1 : 1) : quality(b) - quality(a));
}
