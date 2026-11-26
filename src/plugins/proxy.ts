import { remoteAddress } from '../http.js';
import { fieldList } from '../policy.js';
import type { ServePlugin, TransportLimits } from '../types.js';

export interface ProxyPluginOptions extends TransportLimits {
  readonly name?: string;
  /** Methods to forward; omitted forwards every method. */
  readonly methods?: readonly string[];
  /** Fields set on every upstream request, replacing the client's field of that name, such as a service credential. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Set X-Forwarded-For, -Host and -Proto for the upstream. Default true. */
  readonly forwarded?: boolean;
}
// Connection-scoped fields (RFC 9110 section 7.6.1) end at this hop. Host and Content-Length belong to the new request:
// VERIFIED: (probe) Bun 1.4.5 fetch sends a Host field it is given, so the client's Host would reach the upstream.
const hopByHop = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'];
// VERIFIED: (probe) Node 22.16, Node 26.13 and Bun 1.4.5 fetch decode these codings but keep Content-Encoding and the
// encoded Content-Length. zstd is runtime-dependent: Node 22.16 passes it through raw, Node 26.13 and Bun decode it.
const decoded = new Set(['gzip', 'x-gzip', 'deflate', 'br']);
const nullBody = new Set([204, 205, 304]);
const failure = (status: number, text: string) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** Forward the subtree `path` to the same subtree of `target`: `/auth/login?x` with path `/auth` and target
 * `http://127.0.0.1:9000/apps/a/auth` goes to `http://127.0.0.1:9000/apps/a/auth/login?x`. */
export function proxyPlugin(path: string, target: string | URL, options: ProxyPluginOptions = {}): ServePlugin {
  if (typeof path !== 'string' || !/^\/(?:[^/?#\s%\\]+(?:\/[^/?#\s%\\]+)*)?$/.test(path) || path.split('/').some(s => s === '.' || s === '..')) throw new TypeError('Invalid proxy path');
  const base = new URL(target);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new TypeError('Invalid proxy target');
  const methods = options.methods?.map(m => m.toUpperCase());
  const fields = fieldList(options.headers, 'proxy headers');
  const local = path === '/' ? '' : path, upstreamPath = base.pathname.replace(/\/+$/, '');
  const forwarded = options.forwarded !== false;
  const { name, methods: _methods, headers: _headers, forwarded: _forwarded, ...limits } = options;
  return {
    ...limits, name: name ?? `proxy:${path}`,
    routes: [{ path, prefix: true, ...(methods ? { methods } : {}) }],
    async fetch(request) {
      const url = new URL(request.url);
      // The host refused encoded slashes and backslashes, and the URL parser resolved dot segments, so the rest of the
      // path cannot leave the target's subtree.
      const upstream = new URL(base.origin + upstreamPath + url.pathname.slice(local.length) + url.search);
      const headers = new Headers(request.headers);
      for (const field of (request.headers.get('connection') ?? '').split(',')) if (field.trim()) headers.delete(field.trim());
      for (const field of hopByHop) headers.delete(field);
      // Why identity: fetch would decode a compressed answer, and the host compresses nothing, so compression on this
      // hop costs CPU on both sides and saves nothing for the client.
      headers.set('Accept-Encoding', 'identity');
      if (forwarded) {
        // The host strips forwarding fields unless the peer is a trusted proxy, so any that remain came from one.
        const peer = remoteAddress(request), chain = request.headers.get('x-forwarded-for');
        if (peer) headers.set('X-Forwarded-For', chain ? `${chain}, ${peer}` : peer);
        if (!request.headers.has('x-forwarded-host')) headers.set('X-Forwarded-Host', url.host);
        if (!request.headers.has('x-forwarded-proto')) headers.set('X-Forwarded-Proto', url.protocol.slice(0, -1));
      }
      for (const [field, value] of fields) headers.set(field, value);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body ?? undefined;
      let answer: Response;
      try {
        answer = await fetch(upstream, { method: request.method, headers, body, redirect: 'manual', signal: request.signal, ...(body ? { duplex: 'half' } : {}) } as RequestInit);
      } catch (error) {
        if (request.signal.aborted) throw error;
        return failure(502, 'Bad Gateway');
      }
      const out = new Headers(answer.headers);
      const codings = (out.get('content-encoding') ?? '').split(',').map(c => c.trim().toLowerCase()).filter(c => c && c !== 'identity');
      if (codings.some(c => !decoded.has(c))) { await answer.body?.cancel().catch(() => {}); return failure(502, 'Unsupported upstream content coding'); }
      if (codings.length) { out.delete('content-encoding'); out.delete('content-length'); }
      // Keep the client on this origin: a redirect into the target's subtree points at the same place under `path`.
      const location = out.get('location'), moved = location ? URL.parse(location, upstream) : null;
      if (moved && moved.origin === base.origin && (moved.pathname === upstreamPath || moved.pathname.startsWith(`${upstreamPath}/`)))
        out.set('Location', (local + moved.pathname.slice(upstreamPath.length) || '/') + moved.search + moved.hash);
      if (nullBody.has(answer.status)) await answer.body?.cancel().catch(() => {});
      return new Response(nullBody.has(answer.status) ? null : answer.body, { status: answer.status, statusText: answer.statusText, headers: out });
    },
  };
}
