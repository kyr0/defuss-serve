import { acceptMark } from '../ownership.js';
import { fieldList } from '../policy.js';
import type { WebSocketAccept, WebSocketHandlers } from '../types.js';

/** What a plugin's acceptance carries to the listener. */
export interface Acceptance { readonly handlers: WebSocketHandlers; readonly protocol: string; readonly key: string }
const tokens = (value: string | null) => (value ?? '').split(',').map(token => token.trim()).filter(Boolean);
const has = (value: string | null, wanted: string) => tokens(value).some(token => token.toLowerCase() === wanted);

/** Answer a WebSocket opening handshake (RFC 6455 section 4.2.1) from a plugin's fetch. A request that is no
 * handshake gets 400, a version other than 13 gets 426 with the version this server speaks (4.4). Otherwise the
 * returned Response marks the acceptance; the listener then sends 101 with the plugin's extra fields and runs the
 * socket. A subprotocol must be one the client offered (4.2.2); a protocol or field the plugin may not send throws.
 * VERIFIED: tests/websocket.test.ts, the refusal test (400, 426, 403, 500) and the RFC 6455 1.3 accept value. */
export function acceptWebSocket(request: Request, accept: WebSocketAccept = {}): Response {
  const headers = request.headers;
  if (request.method !== 'GET' || !has(headers.get('upgrade'), 'websocket') || !has(headers.get('connection'), 'upgrade')) {
    return new Response('WebSocket upgrade expected', { status: 400 });
  }
  if (headers.get('sec-websocket-version') !== '13') return new Response('Unsupported WebSocket version', { status: 426, headers: { 'Sec-WebSocket-Version': '13' } });
  const key = headers.get('sec-websocket-key') ?? '';
  // A base64 nonce of 16 bytes is 22 characters and its padding (4.1).
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return new Response('Invalid Sec-WebSocket-Key', { status: 400 });
  const protocol = accept.protocol ?? '';
  if (protocol && !tokens(headers.get('sec-websocket-protocol')).includes(protocol)) throw new TypeError('The client did not offer this subprotocol');
  const response = new Response(null, { status: 200, headers: new Headers(fieldList(accept.headers, 'acceptWebSocket headers') as [string, string][]) });
  Object.defineProperty(response, acceptMark, { value: { handlers: accept, protocol, key } satisfies Acceptance });
  return response;
}
/** The acceptance a plugin's Response carries, from this or the other module copy (ESM or CommonJS). */
export function acceptanceOf(response: Response): Acceptance | undefined {
  return (response as Response & { [acceptMark]?: Acceptance })[acceptMark];
}
