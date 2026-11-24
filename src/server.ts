import { listenBun } from './runtime/bun.js';
import { bunRuntime } from './runtime/bun-types.js';
import { listenNode } from './runtime/node.js';
import { claim, release as releaseOwner } from './ownership.js';
import { validateResponse } from './runtime/framing.js';
import type { StaticFilePlan, StaticResult } from './static/plan.js';
import type { Listener, DispatchResult } from './runtime/types.js';
import { StaticStore } from './static/serve.js';
import { acquire, entry, remaining, Routes, validate, waitIdle, waitUntil } from './registry.js';
import type { Entry, Lease } from './registry.js';
import { applyCors, boundBody, preflight, sanitizeForwarding, validateCors } from './http.js';
import type { BoundedBody } from './http.js';
import type { Diagnostic, LifecycleEvent, ServeOptions, ServePlugin, ServeServer, ServeStats, ServerState } from './types.js';

const GiB = 1024 ** 3;
const noop = () => {};
function checkOptions(options: ServeOptions): void {
  for (const [name, value, min, max] of [
    ['port', options.port, 0, 65535], ['idleTimeout', options.idleTimeout, 0, 255],
    ['maxBodyBytes', options.maxBodyBytes, 1, Number.MAX_SAFE_INTEGER], ['shutdownTimeoutMs', options.shutdownTimeoutMs, 0, 2 ** 31 - 1],
    ['bodyTimeoutMs', options.bodyTimeoutMs, 0, 2 ** 31 - 1], ['headersTimeoutMs', options.headersTimeoutMs, 1, 2 ** 31 - 1],
    ['pluginStartTimeoutMs', options.pluginStartTimeoutMs, 1, 2 ** 31 - 1],
    ['maxConcurrentRequests', options.maxConcurrentRequests, 0, Number.MAX_SAFE_INTEGER], ['maxConcurrentStreams', options.maxConcurrentStreams, 0, Number.MAX_SAFE_INTEGER],
    ['maxConnections', options.maxConnections, 0, Number.MAX_SAFE_INTEGER], ['maxConcurrentHandlers', options.maxConcurrentHandlers, 0, Number.MAX_SAFE_INTEGER], ['maxConcurrentUploads', options.maxConcurrentUploads, 0, Number.MAX_SAFE_INTEGER], ['maxOpenStaticFiles', options.maxOpenStaticFiles, 0, Number.MAX_SAFE_INTEGER],
    ['staticCacheTtlMs', options.staticCacheTtlMs, 0, 2 ** 31 - 1], ['staticCacheEntries', options.staticCacheEntries, 0, Number.MAX_SAFE_INTEGER], ['maxManifestEntries', options.maxManifestEntries, 1, Number.MAX_SAFE_INTEGER],
  ] as const) if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max)) throw new RangeError(`Invalid ${name}`);
  if (options.runtime && !['auto', 'bun', 'node'].includes(options.runtime)) throw new Error('Invalid runtime');
  if (options.staticMode && !['live', 'immutable'].includes(options.staticMode)) throw new Error('Invalid staticMode');
  if (options.staticShadow && !['allow', 'warn', 'error'].includes(options.staticShadow)) throw new Error('Invalid staticShadow');
  if (options.spaFallback && !options.publicDir) throw new Error('spaFallback requires publicDir');
  if (options.publicDir === '') throw new Error('Invalid publicDir');
  // VERIFIED: on Node 22.16 (probe) Node binds an empty host to every interface, bypassing the wildcard allowedHosts guard below.
  if (options.host === '') throw new Error('Invalid host');
  if (options.assetManifest && (!options.publicDir || options.staticMode !== 'immutable')) throw new Error('assetManifest requires immutable publicDir');
  if (options.nativeStaticFastPath && (options.maxConcurrentRequests !== 0 || options.maxConcurrentStreams !== 0 || options.maxOpenStaticFiles || options.onLifecycle)) throw new Error('nativeStaticFastPath requires disabled admission limits and no lifecycle observer');
  if (options.cacheControl !== undefined) {
    if (/[\r\n\0]/.test(options.cacheControl)) throw new Error('Invalid cacheControl');
    new Headers({ 'Cache-Control': options.cacheControl });
  }
  if (options.immutableAssetPattern?.global || options.immutableAssetPattern?.sticky) throw new Error('immutableAssetPattern must not be stateful');
  for (const host of options.allowedHosts ?? []) if (!host || (host !== '*' && /[\s/\\@?#%,]/.test(host))) throw new Error('Invalid allowedHosts');
  if (['0.0.0.0', '::', '[::]'].includes(options.host ?? '') && !options.allowedHosts?.length) throw new Error('Wildcard binding requires explicit allowedHosts');
  if (options.cors) validateCors(options.cors);
}

/** One native listener and an atomically published route snapshot. */
class Server implements ServeServer {
  private phase: ServerState = 'idle';
  private listener?: Listener;
  private entries: Entry[];
  private routes: Routes;
  private pending = new Map<string, Entry>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly staticStore: StaticStore;
  private readonly options: ServeOptions;
  private readonly timeout: number;
  private readonly startupTimeout: number;
  private readonly hosts: Set<string>;
  private readonly requestLimit: number;
  private readonly streamLimit: number;
  private readonly owner = {};
  private readonly handlerLimit: number;
  private readonly uploadLimit: number;
  private readonly fileLimit: number;
  private activeHandlers = 0;
  private activeUploads = 0;
  private openStaticFiles = 0;
  private activeRequests = 0;
  private activeStreams = 0;
  private rejected = 0;
  readonly runtime: 'node' | 'bun';
  constructor(options: ServeOptions) {
    checkOptions(options);
    this.options = { ...options, allowedHosts: options.allowedHosts?.slice(), trustedProxies: options.trustedProxies?.slice(), immutableAssetPattern: options.immutableAssetPattern ? new RegExp(options.immutableAssetPattern.source, options.immutableAssetPattern.flags) : undefined, cors: options.cors ? { ...options.cors, origins: [...options.cors.origins], methods: options.cors.methods?.slice(), headers: options.cors.headers?.slice(), exposeHeaders: options.cors.exposeHeaders?.slice() } : undefined, tls: options.tls ? { ...options.tls } : undefined };
    this.runtime = options.runtime === 'node' || (options.runtime !== 'bun' && !bunRuntime()) ? 'node' : 'bun';
    if (this.runtime === 'bun' && options.maxConnections) throw new Error('maxConnections is not supported by the Bun adapter');
    this.timeout = options.shutdownTimeoutMs ?? 5000;
    this.startupTimeout = options.pluginStartTimeoutMs ?? 30000;
    const bind = options.host ?? '127.0.0.1';
    this.hosts = new Set((options.allowedHosts ?? (['localhost', '127.0.0.1', '::1', '[::1]'].includes(bind) ? ['localhost', '127.0.0.1', '[::1]'] : [bind])).map(h => h.toLowerCase().replace(/^::1$/, '[::1]')));
    this.requestLimit = options.maxConcurrentRequests ?? 1024;
    this.streamLimit = options.maxConcurrentStreams ?? 0;
    this.handlerLimit = options.maxConcurrentHandlers ?? 0;
    this.uploadLimit = options.maxConcurrentUploads ?? 0;
    this.fileLimit = options.maxOpenStaticFiles ?? (options.nativeStaticFastPath ? 0 : 256);
    this.entries = (options.plugins ?? []).map(entry);
    validate(this.entries);
    this.routes = new Routes(this.entries);
    this.staticStore = new StaticStore(this.options, this.runtime === 'bun', () => {
      if (this.fileLimit && this.openStaticFiles >= this.fileLimit) { this.rejected++; return; }
      this.openStaticFiles++;
      let released = false;
      return () => { if (!released) { released = true; this.openStaticFiles--; } };
    });
    claim(this.entries.map(e => e.plugin), this.owner);
  }
  get state(): ServerState { return this.phase; }
  get url(): URL | undefined { return this.listener ? new URL(this.listener.url) : undefined; }
  get port(): number | undefined { return this.listener?.port; }
  get plugins(): readonly string[] { return this.entries.map(e => e.name); }
  get stats(): ServeStats { return { activeRequests: this.activeRequests, activeStreams: this.activeStreams, activeHandlers: this.activeHandlers, activeUploads: this.activeUploads, openStaticFiles: this.openStaticFiles, pendingCleanup: this.pending.size, rejected: this.rejected }; }
  private publish(entries: Entry[]): void { this.routes = new Routes(entries); this.entries = entries; }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(noop); return next;
  }
  private diagnostic(event: Diagnostic): void { try { this.options.onDiagnostic?.(event); } catch { /* observers cannot break requests */ } }
  private checkShadows(routes: Routes): void {
    if (this.options.staticShadow === 'allow') return;
    const origin = `${this.options.tls ? 'https' : 'http'}://localhost`;
    for (const path of this.staticStore.paths) {
      const candidates = routes.candidates(path);
      const seen = new Set<Entry>();
      for (const method of ['GET', 'HEAD']) for (const e of routes.shadowsAtStartup(origin + path, method, candidates)) {
        if (seen.has(e)) continue;
        seen.add(e);
        if (this.options.staticShadow === 'error') throw new Error(`Static/API shadow: ${path} (${e.name})`);
        this.diagnostic({ code: 'static-shadow', plugin: e.name });
      }
    }
  }
  private async startEntry(e: Entry): Promise<void> {
    e.state = 'starting';
    const initializing = Promise.resolve().then(() => e.plugin.start?.());
    e.initializing = initializing;
    if (!(await waitUntil(initializing, performance.now() + this.startupTimeout))) throw new Error(`Plugin startup deadline: ${e.name}`);
    e.state = 'active'; e.initializing = undefined;
  }
  /** Dispose only after real handler and source cancellation completion. Deadline expiry quarantines the instance. */
  private async closeEntry(e: Entry, deadline: number): Promise<void> {
    e.state = 'draining'; this.pending.set(e.name, e);
    const idle = waitIdle(e);
    if (e.active.size && !(await waitUntil(idle, deadline))) {
      for (const controller of e.active) controller.abort(new Error('Plugin drain deadline'));
      this.diagnostic({ code: 'plugin-drain-timeout', plugin: e.name });
    }
    const cleanup = Promise.all([idle, e.initializing?.catch(noop)]).then(async () => {
      try { await e.plugin.close?.(); releaseOwner(e.plugin, this.owner); }
      catch (error) { this.diagnostic({ code: 'plugin-close-error', plugin: e.name }); throw error; }
      finally { e.state = 'closed'; this.pending.delete(e.name); }
    });
    // A late rejection is reported by diagnostics, not an unhandled rejection.
    void cleanup.catch(noop);
    if (!(await waitUntil(cleanup, deadline))) this.diagnostic({ code: 'plugin-close-timeout', plugin: e.name });
  }
  private async closeAll(deadline: number): Promise<void> {
    const old = this.entries; this.publish([]);
    const results = await Promise.allSettled([...old].reverse().map(e => this.closeEntry(e, deadline)));
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'Plugin shutdown failed');
  }
  start(): Promise<ServeServer> {
    return this.serialize(async () => {
      if (this.phase === 'running') return this;
      if (this.phase !== 'idle') throw new Error('A stopped server cannot restart; create a new instance');
      this.phase = 'starting';
      try {
        await this.staticStore.init(); this.checkShadows(this.routes);
        for (const e of this.entries) await this.startEntry(e);
        this.phase = 'running';
        this.listener = await (this.runtime === 'bun' ? listenBun : listenNode)(this.options, this.dispatch);
        return this;
      } catch (error) {
        this.phase = 'stopped';
        try { await this.closeAll(performance.now() + this.timeout); } catch (closeError) { throw new AggregateError([error, closeError], 'Startup and cleanup failed'); }
        throw error;
      }
    });
  }
  stop(): Promise<void> {
    return this.serialize(async () => {
      if (this.phase === 'stopped') return;
      this.phase = 'stopping'; const deadline = performance.now() + this.timeout;
      try {
        const results = await Promise.allSettled([this.listener?.stop(remaining(deadline)), this.closeAll(deadline)]);
        const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
        if (errors.length) throw new AggregateError(errors, 'Server shutdown failed');
      } finally { this.listener = undefined; this.phase = 'stopped'; }
    });
  }
  addPlugin(plugin: ServePlugin): Promise<void> {
    return this.serialize(async () => {
      if (this.phase !== 'idle' && this.phase !== 'running') throw new Error('Server is closed');
      const e = entry(plugin);
      if (this.pending.has(e.name) || [...this.pending.values()].some(p => p.plugin === plugin)) throw new Error(`Plugin cleanup pending: ${e.name}`);
      const entries = [...this.entries, e]; validate(entries); this.checkShadows(new Routes(entries));
      claim([plugin], this.owner);
      if (this.phase === 'running') {
        try { await this.startEntry(e); } catch (error) {
          try { await this.closeEntry(e, performance.now() + this.timeout); } catch (closeError) { throw new AggregateError([error, closeError], 'Plugin startup and cleanup failed'); }
          throw error;
        }
      }
      this.publish(entries);
    });
  }
  removePlugin(name: string): Promise<boolean> {
    return this.serialize(async () => {
      const found = this.entries.find(e => e.name === name);
      if (!found) return false;
      this.publish(this.entries.filter(e => e !== found));
      await this.closeEntry(found, performance.now() + this.timeout); return true;
    });
  }
  private dispatch = async (incoming: Request, peer?: string): Promise<DispatchResult> => {
    const observed = this.options.onLifecycle || this.options.onRequest;
    const started = observed ? performance.now() : 0;
    let handler = 'http', route = 'unmatched';
    let status: number | undefined;
    let lease: Lease | undefined, bounded: BoundedBody | undefined;
    let stream = false, admitted = false, finished = false, failed = false, upload = false;
    let executionExpired = false;
    let plan: StaticFilePlan | undefined;
    const emit = (phase: LifecycleEvent['phase'], bytes = 0) => {
      if (this.options.onLifecycle) try { this.options.onLifecycle({ phase, method: incoming.method, handler, route, status, bytes, durationMs: performance.now() - started, activeRequests: this.activeRequests, activeStreams: this.activeStreams }); } catch { /* isolated observer */ }
    };
    const finish = (phase: 'complete' | 'error' | 'cancel', bytes: number) => {
      if (finished) return; finished = true;
      try { bounded?.dispose(); } catch { this.diagnostic({code: 'request-error', plugin: handler}); } finally { lease?.release(); }
      if (stream) this.activeStreams--;
      if (upload) this.activeUploads--;
      if (admitted) this.activeRequests--;
      emit(phase === 'complete' && failed ? 'error' : phase, bytes);
    };
    const reject = (code: number, message: string) => { this.rejected++; return new Response(message, { status: code }); };
    let response: Response;
    const cancel = async (r: Response, reason?: unknown) => {
      if (plan) { const file = plan; plan = undefined; await file.close(); }
      else await r.body?.cancel(reason);
    };
    const selectFile = (file: StaticResult): Response => {
      if (file instanceof Response) return file;
      plan = file; return file.response;
    };
    try {
      const url = new URL(incoming.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const host = incoming.headers.get('host');
      const authority = host && !/[\s/\\@?#%,]/.test(host) ? host.toLowerCase() === url.host ? url : (() => { try { return new URL(`${url.protocol}//${host}`); } catch { return undefined; } })() : undefined;
      if (this.phase !== 'running') response = reject(503, 'Service Unavailable');
      else if (!authority) response = reject(400, 'Bad Request');
      else if (!this.hosts.has('*') && !this.hosts.has(authority.hostname.toLowerCase())) response = reject(403, 'Forbidden Host');
      else if (authority.host !== url.host) response = reject(400, 'Bad Request');
      else if ((this.requestLimit && this.activeRequests >= this.requestLimit)) response = reject(503, 'Server Busy');
      else {
        admitted = true; this.activeRequests++; emit('start');
        const request = sanitizeForwarding(incoming, peer, this.options.trustedProxies ?? []);
        const cors = preflight(request, this.options.cors);
        if (cors) response = cors;
        else if (url.pathname.startsWith('//') || /%2f|%5c|%00|\\/i.test(url.pathname)) response = reject(400, 'Bad Request');
        else {
          const file = this.options.publicDir ? await this.staticStore.fetch(request, url) : undefined;
          // Read the snapshot AFTER any asynchronous filesystem lookup.
          const snapshot = this.routes; const candidates = snapshot.candidates(path);
          if (file) {
            handler = 'static'; route = 'static'; response = selectFile(file);
            if (this.options.staticShadow !== 'allow') for (const e of snapshot.shadows(request, candidates)) {
              this.diagnostic({ code: 'static-shadow', plugin: e.name });
              if (this.options.staticShadow === 'error') { await cancel(response); response = reject(503, 'Static/API collision'); break; }
            }
          } else if (this.phase !== 'running') response = reject(503, 'Service Unavailable');
          else {
            const matched = snapshot.match(request, candidates);
            if (matched.collision) { failed = true; this.diagnostic({ code: 'plugin-collision' }); response = new Response('Internal Server Error', { status: 500 }); }
            else if (matched.entry) {
              const e = matched.entry; handler = e.name; route = matched.route ?? e.name;
              if ((this.handlerLimit && this.activeHandlers >= this.handlerLimit) ||
                  (e.plugin.maxConcurrentRequests && e.active.size >= e.plugin.maxConcurrentRequests) ||
                  (request.body && this.uploadLimit && this.activeUploads >= this.uploadLimit)) {
                response = reject(503, 'Plugin Busy');
              } else {
              if (request.body) { upload = true; this.activeUploads++; }
              lease = acquire(e, request);
              const limit = Math.min(this.options.maxBodyBytes ?? GiB, e.plugin.maxBodyBytes ?? Infinity);
              const globalTimeout = this.options.bodyTimeoutMs ?? 300000;
              const localTimeout = e.plugin.bodyTimeoutMs ?? 0;
              const bodyTimeout = Math.min(globalTimeout || Infinity, localTimeout || Infinity);
              const scoped = new Request(request, { signal: lease.signal });
              const result = boundBody(scoped, limit, Number.isFinite(bodyTimeout) ? bodyTimeout : 0);
              if (result instanceof Response) response = result;
              else {
                bounded = result;
                if (lease.signal.aborted) throw lease.signal.reason;
                this.activeHandlers++;
                // The timeout may finish the HTTP request, but never releases a still-running
                // handler or its source. Keep the plugin lease and upload reservation until real settlement.
                if (e.plugin.executionTimeoutMs) {
                  const heldLease = lease;
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  const expired = Symbol('execution deadline');
                  const deadline = new Promise<typeof expired>(resolve => {
                    timer = setTimeout(() => {
                      executionExpired = true;
                      this.diagnostic({ code: 'plugin-execution-timeout', plugin: e.name });
                      resolve(expired);
                      heldLease.abort(new Error('Plugin execution deadline'));
                    }, e.plugin.executionTimeoutMs);
                    timer.unref?.();
                  });
                  const work = Promise.resolve().then(() => e.plugin.fetch(result.request)).finally(() => { this.activeHandlers--; });
                  try {
                    const outcome = await Promise.race([work, deadline]);
                    if (outcome === expired) {
                      const heldBody = bounded; const heldUpload = upload;
                      bounded = undefined; upload = false; lease = undefined;
                      void work.then(async late => {
                        if (late instanceof Response) await late.body?.cancel(heldLease.signal.reason);
                      }, noop).catch(noop).finally(() => {
                        try { heldBody?.dispose(); } catch { this.diagnostic({code: 'request-error', plugin: e.name}); }
                        finally { if (heldUpload) this.activeUploads--; heldLease.release(); }
                      });
                      response = reject(504, 'Plugin Execution Timeout');
                    } else response = outcome;
                  } finally { if (timer) clearTimeout(timer); }
                } else {
                  try { response = await e.plugin.fetch(result.request); }
                  finally { this.activeHandlers--; }
                }
                if (!(response instanceof Response)) throw new TypeError('Plugin must return a Response');
              }
              }
            } else {
              const allow = snapshot.allowed(candidates);
              if (allow.length && !allow.includes(request.method)) response = new Response('Method Not Allowed', { status: 405, headers: { Allow: allow.join(', ') } });
              else {
                const spa = candidates.length || !this.options.spaFallback ? undefined : await this.staticStore.fetch(request, url, true);
                if (spa) { handler = 'spa'; route = 'spa'; response = selectFile(spa); } else response = new Response('Not Found', { status: 404 });
              }
            }
          }
        }
      }
    } catch {
      if (plan) { await plan.close().catch(noop); plan = undefined; }
      if (!bounded?.failure() && !lease?.signal.aborted) { failed = true; this.diagnostic({ code: 'request-error' }); }
      response = new Response('Internal Server Error', { status: 500 });
    }
    const failure = bounded?.failure();
    try {
      if (failure) { await cancel(response).catch(noop); response = reject(failure, failure === 408 ? 'Request Timeout' : 'Payload Too Large'); }
      const signal = executionExpired ? incoming.signal : lease?.signal ?? incoming.signal;
      if (signal.aborted) { await cancel(response, signal.reason).catch(noop); finish('cancel', 0); return {response: new Response(null, { status: 503 }), signal: incoming.signal, finish}; }
      if (incoming.method === 'HEAD' && (response.body || plan)) {
        await cancel(response).catch(noop);
        response = new Response(null, { status: response.status, headers: response.headers });
      }
      response = applyCors(incoming, response, this.options.cors);
      let length: number | undefined;
      try { length = validateResponse(response, !!plan || !!response.body, incoming.method); }
      catch (error) {
        await cancel(response, error).catch(noop);
        failed = true; this.diagnostic({code: 'response-framing-error', plugin: handler});
        response = applyCors(incoming, new Response('Internal Server Error', {status: 500}), this.options.cors);
      }
      const untracked = this.runtime === 'bun' && this.options.nativeStaticFastPath && !plan && (handler === 'static' || handler === 'spa');
      if ((response.body || plan) && admitted && !untracked) {
        if (this.streamLimit && this.activeStreams >= this.streamLimit) {
          await cancel(response).catch(noop);
          this.rejected++; response = applyCors(incoming, new Response(null, {status:503}), this.options.cors);
          length = undefined;
        } else { stream = true; this.activeStreams++; }
      }
      status = response.status;
      try { this.options.onRequest?.({ method: incoming.method, handler, status, durationMs: performance.now() - started }); } catch { /* isolated observer */ }
      emit('headers');
      if (untracked) finish('complete', 0);
      return {response, file: plan, signal, length, finish, untracked};
    } catch (error) {
      await cancel(response, error).catch(noop);
      finish('error', 0); this.diagnostic({ code: 'request-error' });
      return {response: new Response('Internal Server Error', { status: 500 }), signal: incoming.signal, finish};
    }
  };
}
/** Construct without opening a socket; call start() explicitly. */
export function createServer(options: ServeOptions = {}): ServeServer { return new Server(options); }
