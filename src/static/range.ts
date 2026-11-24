export type ByteRange = { kind: 'full' } | { kind: 'unsatisfiable' } | { kind: 'partial'; start: number; end: number };

/** Single byte ranges. Unsupported units, malformed syntax and multi-range requests are ignored. */
export function parseRange(value: string | null, size: number): ByteRange {
  if (!value || value.length > 256) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return { kind: 'full' };
  const total = BigInt(size);
  if (match[1] && match[2] && BigInt(match[1]) > BigInt(match[2])) return { kind: 'full' };
  if (total === 0n) return { kind: 'unsatisfiable' };
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Number(suffix >= total ? 0n : total - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]);
  if (start >= total) return { kind: 'unsatisfiable' };
  const end = match[2] ? BigInt(match[2]) : total - 1n;
  return { kind: 'partial', start: Number(start), end: Number(end >= total ? total - 1n : end) };
}
