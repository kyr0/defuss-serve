import { peerMark } from './ownership.js';
import type { CorsOptions } from './types.js';

export function vary(headers: Headers, name: string): void {
  const existing = headers.get('vary');
  if (existing === '*' || existing?.split(',').some(v => v.trim().toLowerCase() === name.toLowerCase())) return;
  headers.set('Vary', existing ? `${existing}, ${name}` : name);
}
export function validateCors(cors: CorsOptions): void {
  if (cors.credentials && cors.origins.includes('*')) throw new Error('Credentialed CORS requires exact origins');
  for (const origin of cors.origins) if (origin !== '*' && origin !== 'null' && new URL(origin).origin !== origin) throw new Error('Invalid CORS origin');
  if (cors.maxAge !== undefined && (!Number.isSafeInteger(cors.maxAge) || cors.maxAge < 0)) throw new Error('Invalid CORS maxAge');
  new Headers({ 'Access-Control-Allow-Methods': cors.methods?.join(', ') ?? '', 'Access-Control-Allow-Headers': cors.headers?.join(', ') ?? '', 'Access-Control-Expose-Headers': cors.exposeHeaders?.join(', ') ?? '' });
}
const originAllowed = (origin: string, cors: CorsOptions) => cors.origins.includes('*') || cors.origins.includes(origin);
export function preflight(request: Request, cors?: CorsOptions): Response | undefined {
  const origin = request.headers.get('origin');
  const method = request.headers.get('access-control-request-method');
  if (!cors || request.method !== 'OPTIONS' || !origin || !method) return;
  const methods = cors.methods ?? ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'];
  const allowedHeaders = cors.headers ?? ['Content-Type', 'Authorization', 'Range', 'Content-Encoding', 'Content-Disposition', 'Origin', 'Accept', 'X-Requested-With', 'X-Upload-Id', 'X-Upload-Offset', 'X-Upload-Handler', 'X-Original-Size', 'X-File-Sha256', 'X-Original-Filename', 'X-File-Name', 'X-File-Type', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID'];
  const requested = (request.headers.get('access-control-request-headers') ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  const headers = new Headers({ Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' });
  if (!originAllowed(origin, cors) || !methods.includes(method.toUpperCase()) || requested.some(h => !allowedHeaders.some(a => a.toLowerCase() === h))) return new Response(null, { status: 403, headers });
  headers.set('Access-Control-Allow-Methods', methods.join(', '));
  headers.set('Access-Control-Allow-Headers', allowedHeaders.join(', '));
  headers.set('Access-Control-Max-Age', String(cors.maxAge ?? 600));
  return new Response(null, { status: 204, headers });
}

/** Mutate ordinary response headers in place to preserve a BunFile fast path. */
export function applyCors(request: Request, response: Response, cors?: CorsOptions): Response {
  if (!cors) return response;
  const decorate = (headers: Headers) => {
    vary(headers, 'Origin');
    headers.delete('Access-Control-Allow-Origin');
    headers.delete('Access-Control-Allow-Credentials');
    headers.delete('Access-Control-Expose-Headers');
    const origin = request.headers.get('origin');
    if (origin && originAllowed(origin, cors)) {
      headers.set('Access-Control-Allow-Origin', cors.origins.includes('*') ? '*' : origin);
      if (cors.credentials) headers.set('Access-Control-Allow-Credentials', 'true');
      const expose = cors.exposeHeaders ?? ['Content-Range', 'Accept-Ranges', 'ETag', 'Content-Disposition', 'X-File-Sha256', 'X-Upload-Offset', 'X-Upload-Handler', 'X-Original-Size', 'X-Upload-Status', 'Content-Length', 'X-Download-Id', 'X-File-Size', 'Mcp-Session-Id', 'MCP-Protocol-Version'];
      if (expose.length) headers.set('Access-Control-Expose-Headers', expose.join(', '));
    }
  };
  try { decorate(response.headers); return response; }
  catch { const headers = new Headers(response.headers); decorate(headers); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
}

/** Record the direct socket peer on the Request handed to a plugin. Why not a header: a client could send one.
 * VERIFIED: tests/proxy.test.ts: a forged X-Forwarded-For leaves it 127.0.0.1, and the packed consumer reads a mark
 * that the CommonJS copy set from the ESM copy. */
export function markPeer(request: Request, peer: string | undefined): void {
  if (peer) Object.defineProperty(request, peerMark, { value: peer });
}
/** The direct socket peer of a Request that defuss-serve handed to a plugin, else undefined. A Request the plugin
 * builds itself has none. This is the peer, not a forwarded client: read forwarding fields only from trusted proxies. */
export function remoteAddress(request: Request): string | undefined {
  const peer = (request as Request & { [peerMark]?: unknown })[peerMark];
  return typeof peer === 'string' ? peer : undefined;
}
/** Do not trust forwarding metadata from an arbitrary client. No automatic origin rewriting. */
export function sanitizeForwarding(request: Request, peer: string | undefined, trusted: readonly string[]): Request {
  if (peer && trusted.includes(peer)) return request;
  let headers: Headers | undefined;
  for (const name of request.headers.keys()) {
    if (name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-')) {
      headers ??= new Headers(request.headers); headers.delete(name);
    }
  }
  return headers ? new Request(request, { headers }) : request;
}
export interface BoundedBody { request: Request; failure(): 408 | 413 | undefined; dispose(): void }
const noop = () => {};
const noFailure = () => undefined;
/** Limit actual wire bytes and body-read time without buffering. The listener handles unread bytes. */
export function boundBody(request: Request, limit: number, timeoutMs: number): BoundedBody | Response {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(limit))) return new Response('Payload Too Large', { status: 413 });
  if (!request.body) return { request, failure: noFailure, dispose: noop };
  const reader = request.body.getReader();
  let bytes = 0; let failure: 408 | 413 | undefined; let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const dispose = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  };
  const fail = (status: 408 | 413) => {
    if (closed) return;
    failure = status;
    controller.error(new Error(status === 408 ? 'Request Timeout' : 'Payload Too Large'));
    dispose();
  };
  const onAbort = () => { if (!closed) { controller.error(request.signal.reason); dispose(); } };
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    async pull(c) {
      try {
        const chunk = await reader.read();
        if (closed) return;
        if (chunk.done) { c.close(); dispose(); return; }
        bytes += chunk.value.byteLength;
        if (bytes > limit) fail(413); else c.enqueue(chunk.value);
      } catch (error) { if (!closed) { c.error(error); dispose(); } }
    },
    cancel() { dispose(); },
  }, { highWaterMark: 0 });
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (timeoutMs) { timer = setTimeout(() => fail(408), timeoutMs); timer.unref?.(); }
  if (request.signal.aborted) onAbort();
  return { request: new Request(request, { body, duplex: 'half' } as RequestInit), failure: () => failure, dispose };
}
