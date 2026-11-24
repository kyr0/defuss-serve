import type { ServePlugin, ServeRoute } from './types.js';
import { routePathMatches } from './plugins/endpoint.js';
import { within } from './runtime/types.js';

export interface Entry {
  plugin: ServePlugin;
  name: string;
  routes?: readonly ServeRoute[];
  active: Set<AbortController>;
  waiters: Set<() => void>;
  state: 'registered' | 'starting' | 'active' | 'draining' | 'closed';
  initializing?: Promise<void>;
}
export function entry(plugin: ServePlugin): Entry {
  if (!plugin.name?.trim() || (!plugin.routes?.length && typeof plugin.matches !== 'function') || (plugin.matches !== undefined && typeof plugin.matches !== 'function') || typeof plugin.fetch !== 'function') throw new TypeError('Invalid plugin');
  for (const [name, value, min] of [['maxBodyBytes', plugin.maxBodyBytes, 1], ['bodyTimeoutMs', plugin.bodyTimeoutMs, 0], ['maxConcurrentRequests', plugin.maxConcurrentRequests, 0], ['executionTimeoutMs', plugin.executionTimeoutMs, 0]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > (name.endsWith('TimeoutMs') ? 2147483647 : Number.MAX_SAFE_INTEGER))) throw new RangeError(`Invalid plugin ${name}`);
  }
  const routes = plugin.routes?.length ? plugin.routes.map(r => {
    if (!r.path.startsWith('/') || (r.path !== '/' && r.path.endsWith('/')) || /[?#%\\\s]/.test(r.path) || r.path.split('/').some(s => s === '.' || s === '..')) throw new TypeError(`Invalid route: ${r.path}`);
    if (r.methods && (!r.methods.length || r.methods.some(m => !/^[A-Z]+$/.test(m)))) throw new TypeError('Invalid route methods');
    return { path: r.path, prefix: !!r.prefix, methods: r.methods ? [...new Set(r.methods)] : undefined };
  }) : undefined;
  return { plugin, name: plugin.name, routes, active: new Set(), waiters: new Set(), state: 'registered' };
}
export function validate(entries: readonly Entry[]): void {
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    if (a.name === b.name || a.plugin === b.plugin) throw new Error(`Duplicate plugin name: ${a.name}`);
    for (const r of a.routes ?? []) for (const s of b.routes ?? []) {
      if ((routePathMatches(r.path, s) || routePathMatches(s.path, r)) && (!r.methods || !s.methods || r.methods.some(m => s.methods!.includes(m)))) throw new Error(`Plugin route collision: ${a.name}, ${b.name}`);
    }
  }
}
interface Candidate { entry: Entry; route: ServeRoute }
const noCandidates: readonly Candidate[] = [];
const noEntries: readonly Entry[] = [];
/** Exact paths are indexed; small prefix tables avoid trie allocations. Dynamic matchers stay explicit. */
export class Routes {
  private exact = new Map<string, Candidate[]>();
  private prefixes: Candidate[] = [];
  private dynamic: Entry[] = [];
  constructor(entries: readonly Entry[]) {
    for (const e of entries) {
      if (!e.routes) this.dynamic.push(e);
      else for (const route of e.routes) {
        const item = { entry: e, route };
        if (route.prefix) this.prefixes.push(item);
        else { const bucket = this.exact.get(route.path); if (bucket) bucket.push(item); else this.exact.set(route.path, [item]); }
      }
    }
  }
  candidates(path: string): readonly Candidate[] {
    const exact = this.exact.get(path) ?? noCandidates;
    if (!this.prefixes.length) return exact;
    const prefixes = this.prefixes.filter(({ route }) => route.path === '/' || path === route.path || path.startsWith(route.path + '/'));
    return prefixes.length ? [...exact, ...prefixes] : exact;
  }
  match(request: Request, candidates: readonly Candidate[]): { entry?: Entry; route?: string; collision: boolean } {
    let selected: Entry | undefined; let route: string | undefined;
    for (const candidate of candidates) {
      const e = candidate.entry;
      if (e === selected || e.state !== 'active' || (candidate.route.methods && !candidate.route.methods.includes(request.method)) || (e.plugin.matches && !e.plugin.matches(request))) continue;
      if (selected) return { collision: true };
      selected = e; route = candidate.route.path;
    }
    for (const e of this.dynamic) {
      if (e.state !== 'active' || (e.plugin.matches && !e.plugin.matches(request))) continue;
      if (selected) return { collision: true };
      selected = e; route = e.name;
    }
    return { entry: selected, route, collision: false };
  }
  /** Check static collisions even for matcher-only endpoints, including before startup. */
  shadowsAtStartup(url: string, method: string, candidates: readonly Candidate[]): readonly Entry[] {
    if (!candidates.length && !this.dynamic.length) return noEntries;
    const selected = new Set<Entry>();
    for (const { entry, route } of candidates) if (!route.methods || route.methods.includes(method)) selected.add(entry);
    if (this.dynamic.length) {
      const request = new Request(url, {method});
      for (const e of this.dynamic) if (e.plugin.matches?.(request)) selected.add(e);
    }
    return [...selected];
  }
  shadows(request: Request, candidates: readonly Candidate[]): readonly Entry[] {
    if (!candidates.length && !this.dynamic.length) return noEntries;
    const selected = new Set<Entry>();
    for (const { entry, route } of candidates) if (!route.methods || route.methods.includes(request.method)) selected.add(entry);
    for (const e of this.dynamic) if (e.plugin.matches?.(request)) selected.add(e);
    return [...selected];
  }
  allowed(candidates: readonly Candidate[]): string[] {
    return candidates.some(c => !c.route.methods) ? [] : [...new Set(candidates.flatMap(c => c.route.methods!))].sort();
  }
}
export function remaining(deadline: number): number { return Math.max(0, Math.ceil(deadline - performance.now())); }
export function waitIdle(e: Entry): Promise<void> {
  if (!e.active.size) return Promise.resolve();
  return new Promise<void>(resolve => e.waiters.add(resolve));
}
export async function waitUntil(promise: Promise<unknown>, deadline: number): Promise<boolean> { return within(promise, remaining(deadline)); }
export interface Lease { signal: AbortSignal; abort(reason: unknown): void; release(): void }
/** Abort requests without pretending that an uncooperative handler or cancel hook has completed. */
export function acquire(e: Entry, client: AbortSignal, scope?: AbortController): Lease {
  // VERIFIED: (disconnect test) a supplied scope already aborts on disconnect; otherwise forward the client signal without AbortSignal.any.
  const controller = scope ?? new AbortController();
  const forward = scope ? undefined : () => controller.abort(client.reason);
  if (forward) { if (client.aborted) forward(); else client.addEventListener('abort', forward, { once: true }); }
  e.active.add(controller);
  return { signal: controller.signal, abort: reason => controller.abort(reason), release() {
    if (forward) client.removeEventListener('abort', forward);
    if (!e.active.delete(controller)) return;
    if (!e.active.size) { for (const waiter of e.waiters) waiter(); e.waiters.clear(); }
  } };
}
