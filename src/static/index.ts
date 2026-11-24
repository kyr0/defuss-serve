import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup, safeSegments, StaticDenied, type StaticFile } from './resolve.js';

interface Cached { file: StaticFile | undefined; expires: number }
/** Bounded live lookup cache or deployment-time immutable snapshot. Never cache permission errors. */
export class AssetIndex {
  private readonly manifest = new Map<string, StaticFile>();
  private readonly denied = new Set<string>();
  private readonly directoryIndexes = new Map<string, StaticFile>();
  private readonly cache = new Map<string, Cached>();
  constructor(private readonly root: string, readonly immutable: boolean, private readonly dotfiles: boolean, private readonly ttl: number, private readonly capacity: number, private readonly maximum: number) {}
  async init(): Promise<void> {
    if (!this.immutable) return;
    this.manifest.set('', { path: this.root, stat: await stat(this.root) });
    const pending: Array<{ key: string; path: string }> = [{ key: '', path: this.root }];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const item of await readdir(directory.path, { withFileTypes: true })) {
        if (!this.dotfiles && item.name.startsWith('.')) continue;
        try { safeSegments(encodeURIComponent(item.name), this.dotfiles); } catch { continue; }
        const key = directory.key ? `${directory.key}/${item.name}` : item.name;
        if (this.manifest.size + this.denied.size >= this.maximum) throw new Error('Static manifest entry limit exceeded');
        // No aliases or traversal cycles in production. Live mode retains internal symlink support.
        if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) { this.denied.add(key); continue; }
        const path = join(directory.path, item.name);
        const file = { path, stat: await stat(path) };
        this.manifest.set(key, file);
        if (item.isDirectory()) pending.push({ key, path });
      }
    }
    for (const [key, file] of this.manifest) if (file.stat.isDirectory()) {
      const index = this.manifest.get(key ? `${key}/index.html` : 'index.html');
      if (index?.stat.isFile()) this.directoryIndexes.set(key, index);
    }
  }
  directoryIndex(key: string): StaticFile | undefined {
    if (this.denied.has(key ? `${key}/index.html` : 'index.html')) throw new StaticDenied('Immutable index alias');
    return this.directoryIndexes.get(key);
  }
  *files(): Iterable<[string, StaticFile]> {
    for (const [key, file] of this.manifest) if (file.stat.isFile()) yield [key, file];
  }
  snapshot(key: string): StaticFile | undefined { return this.manifest.get(key); }
  immutableGet(key: string): StaticFile | undefined {
      const file = this.manifest.get(key);
      if (file) return file;
      // Explicitly deny the symlink and any descendants, rather than fall through to an API.
      let prefix = key;
      for (;;) {
        if (this.denied.has(prefix)) throw new StaticDenied('Immutable symlink or special file');
        const slash = prefix.lastIndexOf('/'); if (slash < 0) break; prefix = prefix.slice(0, slash);
      }
      return;
  }
  async get(segments: string[]): Promise<StaticFile | undefined> {
    const key = segments.join('/');
    if (this.immutable) return this.immutableGet(key);
    if (!this.ttl || !this.capacity) return lookup(this.root, segments, this.dotfiles);
    const now = performance.now();
    const cached = this.cache.get(key);
    if (cached && cached.expires > now) { this.cache.delete(key); this.cache.set(key, cached); return cached.file; }
    if (cached) this.cache.delete(key);
    const file = await lookup(this.root, segments, this.dotfiles);
    // Positive metadata can become unsafe on a mutable filesystem; re-resolve before serving.
    // Negative entries alone avoid repeated misses without weakening live symlink containment.
    if (!file) {
      this.cache.set(key, { file, expires: now + this.ttl });
      while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
    }
    return file;
  }
  *paths(): Iterable<string> {
    for (const [key, file] of this.manifest) {
      if (file.stat.isFile()) yield '/' + key.split('/').map(encodeURIComponent).join('/');
      else if (this.directoryIndexes.has(key)) yield '/' + key.split('/').map(encodeURIComponent).join('/');
    }
  }
}
