import type { FetchEndpoint, ServePlugin, ServeRoute, TransportLimits } from '../types.js';
import { endpointIdentity } from '../ownership.js';
import { endpointPlugin, routeMatches } from './endpoint.js';

type LegacyRpcRoute = (context: { request: Request }) => Response | Promise<Response>;
export interface RpcPluginOptions extends TransportLimits {
  readonly name?: string;
  /** Maximum decompressed JSON call bytes. Raw upload endpoints are exempt. */
  readonly maxCallBytes?: number;
}
const rpcRoutes: readonly ServeRoute[] = [
  { path: '/rpc', methods: ['POST'] },
  // VERIFIED: the defuss-rpc 2.0.0 to 4.0.0 client fetches the schema with POST; GET-only answered it 405.
  { path: '/rpc/schema', methods: ['GET', 'POST'] },
  { path: '/rpc/upload', methods: ['POST'] },
  { path: '/rpc/upload', prefix: true, methods: ['HEAD'] },
  { path: '/rpc/upload/progress', prefix: true, methods: ['GET'] },
  { path: '/rpc/download', methods: ['GET'] },
];
const errorResponse = (status: number, error: string) => Response.json({ error }, { status });

/** Preserve the legacy HTTP core's content-type guard and bounded decompression for JSON calls. */
async function prepareCall(request: Request, limit: number): Promise<Request | Response> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return errorResponse(415, 'RPC calls require application/json');
  const encoding = (request.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (!['identity', 'gzip', 'x-gzip', 'deflate'].includes(encoding)) return errorResponse(415, 'Unsupported content encoding');
  if (encoding === 'identity' && Number(request.headers.get('content-length')) > limit) return errorResponse(413, 'RPC call too large');
  if (!request.body) return request;
  const body = encoding === 'identity' ? request.body : request.body.pipeThrough(new DecompressionStream(encoding === 'deflate' ? 'deflate' : 'gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      // Do not cancel the incoming Node stream here: its socket must remain open for the 413.
      if (size > limit) return errorResponse(413, 'RPC call too large');
      chunks.push(chunk.value);
    }
  } catch { return errorResponse(400, 'Unreadable RPC body'); }
  finally { reader.releaseLock(); }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(request.headers);
  headers.delete('content-encoding'); headers.set('content-length', String(size));
  return new Request(request.url, { method: request.method, headers, body: data, signal: request.signal });
}

/** Wrap the existing rpcRoute or an instance-local RPC endpoint. No singleton is created here. */
export function rpcPlugin(endpoint: FetchEndpoint | LegacyRpcRoute, options: RpcPluginOptions | string = {}): ServePlugin {
  const config = typeof options === 'string' ? { name: options } : options;
  const limit = config.maxCallBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid maxCallBytes');
  const target: FetchEndpoint = typeof endpoint === 'function' ? { fetch: request => endpoint({ request }) } : endpoint;
  const plugin = endpointPlugin(config.name ?? 'rpc', {
    async fetch(request) {
      if (request.method === 'POST' && new URL(request.url).pathname.replace(/\/+$/, '') === '/rpc') {
        const prepared = await prepareCall(request, limit);
        if (prepared instanceof Response) return prepared;
        request = prepared;
      }
      return target.fetch(request);
    },
    start: target.start ? () => target.start!() : undefined,
    close: target.close ? () => target.close!() : undefined,
  }, rpcRoutes, config);
  return { ...plugin, [endpointIdentity]: endpoint, matches(request) {
    if (!rpcRoutes.some(route => routeMatches(request, route))) return false;
    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    if (request.method === 'HEAD') return /^\/rpc\/upload\/[^/]+$/.test(path);
    if (request.method === 'GET' && path.startsWith('/rpc/upload/progress')) return /^\/rpc\/upload\/progress\/[^/]+$/.test(path);
    return true;
  } } as ServePlugin;
}
