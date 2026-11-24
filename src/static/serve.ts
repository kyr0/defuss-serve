import { open, realpath, stat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import type { StaticResult } from './plan.js';
import type { Stats } from 'node:fs';
import { allowsRange, encodings, precondition, validator } from './cache.js';
import { mimeType } from './mime.js';
import { parseRange } from './range.js';
import { fsCode, inside, safeSegments, StaticBadPath, StaticDenied } from './resolve.js';
import { AssetIndex } from './index.js';
import type { StaticFile } from './resolve.js';
import { bunRuntime } from '../runtime/bun-types.js';
import type { ServeOptions } from '../types.js';

interface Representation { file: StaticFile; coding: string; headers: Headers; etag: string }
interface Digest { size: number; sha256: string }
/** Resolve against a trusted deployment directory, never a user-writable upload directory. */
export class StaticStore {
  private root?: string;
  private fallback?: string[];
  private index?: AssetIndex;
  private readonly representations = new Map<string, Map<string, Representation>>();
  private digests?: Record<string, Digest>;
  get paths(): Iterable<string> { return this.index?.paths() ?? []; }
  constructor(private readonly options: ServeOptions, private readonly nativeBun: boolean, private readonly reserveFile: () => (() => void) | undefined) {}

  async init(): Promise<void> {
    if (!this.options.publicDir) return;
    this.root = await realpath(resolve(this.options.publicDir));
    if (!(await stat(this.root)).isDirectory()) throw new Error('publicDir must be a directory');
    this.index = new AssetIndex(this.root, this.options.staticMode === 'immutable', !!this.options.allowDotfiles, this.options.staticCacheTtlMs ?? 0, this.options.staticCacheEntries ?? 4096, this.options.maxManifestEntries ?? 100000);
    await this.index.init();
    if (this.options.assetManifest) {
      const manifestPath = await realpath(this.options.assetManifest);
      if (inside(this.root, manifestPath)) throw new Error('assetManifest must be outside publicDir');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: number; files: Record<string, Digest> };
      if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('Invalid assetManifest');
      this.digests = manifest.files;
      for (const [key, file] of this.index.files()) {
        const digest = Object.hasOwn(this.digests, key) ? this.digests[key] : undefined;
        if (!digest || digest.size !== file.stat.size || !/^[0-9a-f]{64}$/.test(digest.sha256)) throw new Error(`Missing or invalid asset digest: ${key}`);
      }
    }
    if (this.index.immutable) for (const [key, file] of this.index.files()) {
      const reps = new Map<string, Representation>();
      reps.set('identity', this.representation(file, key, key, 'identity', file.stat));
      if (this.options.precompressed !== false) for (const [coding, suffix] of [['br', '.br'], ['gzip', '.gz']]) {
        const variant = this.index.snapshot(key + suffix);
        if (variant?.stat.isFile()) reps.set(coding, this.representation(variant, key, key + suffix, coding, variant.stat));
      }
      this.representations.set(key, reps);
    }
    if (this.options.spaFallback) {
      const path = this.options.spaFallback === true ? 'index.html' : this.options.spaFallback;
      this.fallback = safeSegments(path, !!this.options.allowDotfiles);
      const file = await this.index.get(this.fallback);
      if (!file?.stat.isFile()) throw new Error('SPA fallback must be an existing file');
    }
  }

  async fetch(request: Request, url: URL, spa = false): Promise<StaticResult | undefined> {
    if (!this.index || (request.method !== 'GET' && request.method !== 'HEAD')) return;
    try {
      let segments = safeSegments(url.pathname, !!this.options.allowDotfiles);
      if (spa) {
        if (!this.fallback || segments.at(-1)?.includes('.') || !(request.headers.get('accept') ?? '').split(',').some(item => {
          const [type, ...params] = item.trim().toLowerCase().split(';');
          return type === 'text/html' && !params.some(p => /^q\s*=\s*0(?:\.0*)?$/.test(p.trim()));
        })) return;
        segments = this.fallback;
      }
      let file = this.index.immutable ? this.index.immutableGet(segments.join('/')) : await this.index.get(segments);
      if (!file) return;
      if (file.stat.isDirectory()) {
        const index = this.index.immutable ? this.index.directoryIndex(segments.join('/')) : await this.index.get([...segments, 'index.html']);
        if (!index?.stat.isFile()) return;
        if (!url.pathname.endsWith('/') && !spa) return new Response(null, { status: 308, headers: { location: url.pathname + '/' + url.search } });
        segments = [...segments, 'index.html'];
        file = index;
      }
      if (!file.stat.isFile()) return new Response('Forbidden', { status: 403 });
      return await this.respond(request, file, segments);
    } catch (error) {
      if (error instanceof StaticBadPath) return new Response('Bad Request', { status: 400 });
      if (error instanceof StaticDenied || ['EACCES', 'EPERM', 'ELOOP'].includes(fsCode(error) ?? '')) return new Response('Forbidden', { status: 403 });
      // A file vanished after lookup. Do not fall through to a dynamic endpoint.
      if (['ENOENT', 'ENOTDIR'].includes(fsCode(error) ?? '')) return new Response('Not Found', { status: 404 });
      throw error;
    }
  }

  private representation(file: StaticFile, key: string, representationKey: string, coding: string, meta: Stats): Representation {
    const etag = this.digests ? `"sha256-${this.digests[representationKey].sha256}-${coding}"` : validator(meta, coding);
    const immutable = this.index!.immutable && this.options.immutableAssetPattern?.test(key);
    const headers = new Headers({ 'X-Content-Type-Options': 'nosniff', 'ETag': etag,
      'Last-Modified': new Date(meta.mtimeMs).toUTCString(),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : this.options.cacheControl ?? 'public, max-age=0, must-revalidate',
      'Content-Type': mimeType(key), 'Accept-Ranges': 'bytes' });
    if (this.options.precompressed !== false) headers.set('Vary', 'Accept-Encoding');
    if (coding !== 'identity') headers.set('Content-Encoding', coding);
    return { file, coding, headers, etag };
  }

  private async respond(request: Request, original: StaticFile, segments: string[]): Promise<StaticResult> {
    const rangeHeader = request.method === 'GET' ? request.headers.get('range') : null;
    const choices = encodings(request.headers.get('accept-encoding'), !!rangeHeader, this.options.precompressed !== false);
    const key = segments.join('/');
    const cached = this.representations.get(key);
    let rep: Representation | undefined;
    let selected: StaticFile | undefined;
    let coding = 'identity';
    for (const choice of choices) {
      if (cached) { rep = cached.get(choice); if (rep) { selected = rep.file; coding = choice; break; } continue; }
      if (choice === 'identity') { selected = original; break; }
      const suffix = choice === 'br' ? '.br' : '.gz';
      const variant = await this.index!.get([...segments.slice(0, -1), segments.at(-1)! + suffix]);
      if (variant?.stat.isFile()) { selected = variant; coding = choice; break; }
    }
    if (!selected) return new Response(null, { status: 406, headers: this.options.precompressed === false ? {} : { Vary: 'Accept-Encoding' } });
    const openFile = () => open(selected.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let release: (() => void) | undefined;
    let handedOff = false;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => { try { await handle?.close(); } finally { release?.(); } })();
    try {
      if (!cached) {
        release = this.reserveFile();
        if (!release) return new Response(null, { status: 503 });
        handle = await openFile();
      }
      const meta = handle ? await handle.stat() : selected.stat;
      if (!meta.isFile()) return new Response(null, { status: 403 });
      if (!Number.isSafeInteger(meta.size)) throw new Error('File size exceeds safe integer range');
      rep ??= this.representation(selected, key, key + (coding === 'br' ? '.br' : coding === 'gzip' ? '.gz' : ''), coding, meta);
      const { etag } = rep;
      const headers = new Headers(rep.headers);
      const conditional = precondition(request.headers, etag, meta.mtimeMs);
      if (conditional) {
        if (conditional === 412) headers.delete('Content-Encoding');
        return new Response(null, { status: conditional, headers });
      }
      const range = parseRange(allowsRange(request.headers.get('if-range'), etag, meta.mtimeMs) ? rangeHeader : null, meta.size);
      if (range.kind === 'unsatisfiable') {
        headers.set('Content-Range', `bytes */${meta.size}`);
        headers.delete('Content-Encoding');
        return new Response(null, { status: 416, headers });
      }
      const start = range.kind === 'partial' ? range.start : 0;
      const end = range.kind === 'partial' ? range.end : meta.size - 1;
      const status = range.kind === 'partial' ? 206 : 200;
      headers.set('Content-Length', String(end - start + 1));
      if (range.kind === 'partial') headers.set('Content-Range', `bytes ${start}-${end}/${meta.size}`);
      if (request.method === 'HEAD' || meta.size === 0) return new Response(null, { status, headers });
      if (request.signal.aborted) throw request.signal.reason;
      // Native BunFile has no portable completion callback. The explicit untracked mode
      // cannot be combined with descriptor/stream admission or completion observation.
      if (this.nativeBun && this.options.nativeStaticFastPath && coding === 'identity' && (!rangeHeader || range.kind === 'partial')) {
        const file = bunRuntime()!.file(selected.path);
        return new Response(range.kind === 'partial' ? file.slice(start, end + 1) : file, { status, headers });
      }
      if (!handle) {
        release = this.reserveFile();
        if (!release) return new Response(null, { status: 503 });
        handle = await openFile();
        const current = await handle.stat();
        if (!current.isFile() || current.dev !== meta.dev || current.ino !== meta.ino || current.size !== meta.size || current.mtimeMs !== meta.mtimeMs || current.ctimeMs !== meta.ctimeMs) return new Response('Asset snapshot changed', { status: 503 });
      }
      const plan = { response: new Response(null, { status, headers }), handle, start, end, close };
      handedOff = true;
      return plan;
    } finally { if (!handedOff) await close(); }
  }
}
