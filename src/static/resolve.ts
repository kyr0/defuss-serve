import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Stats } from 'node:fs';

export class StaticDenied extends Error {}
export class StaticBadPath extends Error {}
export interface StaticFile { path: string; stat: Stats }

export function fsCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Decode once. Reject separator escapes, Windows aliases and dot traversal. */
export function safeSegments(pathname: string, dotfiles: boolean): string[] {
  if (/%2f|%5c/i.test(pathname) || pathname.includes('\\')) throw new StaticBadPath('Invalid separator');
  return pathname.split('/').filter(Boolean).map(segment => {
    let value: string;
    try { value = decodeURIComponent(segment); } catch { throw new StaticBadPath('Malformed path'); }
    // oxlint-disable-next-line no-control-regex -- decoded control bytes must never reach the filesystem.
    if (/[\u0000-\u001f\u007f/\\:]/.test(value) || value === '.' || value === '..') throw new StaticBadPath('Invalid path segment');
    if (!dotfiles && value.startsWith('.')) throw new StaticDenied('Hidden path');
    if (process.platform === 'win32' && (/[. ]$/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))) throw new StaticDenied('Windows alias');
    return value;
  });
}

/** Resolve a canonical path and reject targets outside the public root, including symlinks. */
export async function lookup(root: string, segments: string[], dotfiles: boolean): Promise<StaticFile | undefined> {
  const candidate = resolve(root, ...segments);
  if (!inside(root, candidate)) throw new StaticDenied('Outside root');
  try {
    const canonical = await realpath(candidate);
    if (!inside(root, canonical)) throw new StaticDenied('Outside root');
    if (!dotfiles && relative(root, canonical).split(sep).some(part => part.startsWith('.'))) throw new StaticDenied('Hidden target');
    return { path: canonical, stat: await stat(canonical) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(fsCode(error) ?? '')) return undefined;
    if (['EACCES', 'EPERM', 'ELOOP'].includes(fsCode(error) ?? '')) throw new StaticDenied('Inaccessible path');
    throw error;
  }
}
