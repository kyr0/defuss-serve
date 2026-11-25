import { createServer, ServerResponse, type IncomingMessage } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { hostUrl, within } from './types.js';
import { checkChunk, checkEnd } from './framing.js';
import { fieldList } from '../policy.js';
import { Session } from '../websocket/session.js';
import { openNodeWebSocket } from './node-websocket.js';
import type { Dispatch, DispatchResult, Listen } from './types.js';
import type { ServeOptions } from '../types.js';

/** Reject absolute-form targets and malformed Host values rather than trusting proxy headers. */
function requestUrl(req: IncomingMessage, secure: boolean): URL {
  const target = req.url ?? '';
  const host = req.headers.host;
  // oxlint-disable-next-line no-control-regex -- a raw control or space byte in the request target is a protocol violation.
  if (!host || /[\s/\\@?#%,]/.test(host) || !target.startsWith('/') || target.startsWith('//') || /[\\#\u0000-\u0020\u007f]/.test(target)) throw new Error('Invalid target');
  const base = new URL(`${secure ? 'https' : 'http'}://${host}`);
  const url = new URL(target, base);
  if (url.origin !== base.origin) throw new Error('Invalid origin');
  return url;
}

/** The Node adapter is the only response pump. It owns validation, cancellation and release. */
async function send(result: DispatchResult, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { response, file, signal, length, finish } = result;
  let bytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelling: Promise<unknown> | undefined;
  const cancel = (reason: unknown) => cancelling ??= Promise.resolve().then(() => file ? file.close() : reader ? reader.cancel(reason) : response.body?.cancel(reason)).catch(() => {});
  const abort = () => { if (!res.destroyed) res.destroy(); void cancel(signal.reason); };
  let phase: 'complete' | 'error' | 'cancel' = 'complete';
  try {
    if (signal.aborted || res.destroyed) { phase = 'cancel'; if (!res.destroyed) res.destroy(); await cancel(signal.reason); return; }
    res.statusCode = response.status;
    for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    if ((!file && !response.body) || req.method === 'HEAD') {
      if (file || response.body) await cancel('HEAD');
      res.end(); return;
    }
    const type = response.headers.get('content-type')?.split(';', 1)[0].toLowerCase();
    if (type === 'text/event-stream' || type === 'application/x-ndjson' || type === 'application/ndjson') res.flushHeaders();
    if (!file) reader = response.body!.getReader();
    signal.addEventListener('abort', abort, { once: true });
    let position = file?.start ?? 0;
    for (;;) {
      if (signal.aborted || res.destroyed) throw signal.reason ?? new Error('Disconnected');
      let value: Uint8Array;
      if (file) {
        if (position > file.end) break;
        const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, file.end - position + 1));
        const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) throw new Error('Static file truncated during transfer');
        position += bytesRead; value = buffer.subarray(0, bytesRead);
      } else {
        const chunk = await reader!.read();
        if (chunk.done) break;
        value = chunk.value;
      }
      if (signal.aborted || res.destroyed) throw signal.reason ?? new Error('Disconnected');
      if (!(value instanceof Uint8Array)) throw new TypeError('Response body must produce bytes');
      checkChunk(bytes + value.byteLength, length);
      bytes += value.byteLength;
      if (!res.write(value)) await once(res, 'drain', { signal });
    }
    if (signal.aborted || res.destroyed) throw signal.reason ?? new Error('Disconnected');
    checkEnd(bytes, length);
    if (file) await file.close();
    res.end();
  } catch (error) {
    phase = signal.aborted || res.destroyed ? 'cancel' : 'error';
    // Never reuse a connection with a partial or contradictory response frame.
    if (res.headersSent && !res.destroyed) res.destroy();
    await cancel(error);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    if (cancelling) await cancelling;
    try { reader?.releaseLock(); } finally { finish(phase, bytes); }
  }
}

/** The Fetch Request of a Node request; a body only for a method that carries one and declares it, or `upload`. */
function toRequest(req: IncomingMessage, url: URL, scope: AbortController, upload?: ReadableStream<Uint8Array>): Request {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const method = req.method ?? 'GET';
  const body = upload ?? (method !== 'GET' && method !== 'HEAD' && (headers.has('content-length') || headers.has('transfer-encoding'))
    ? Readable.toWeb(req, { strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength } }) as ReadableStream<Uint8Array> : undefined);
  return new Request(url, { method, headers, body, signal: scope.signal, ...(body ? { duplex: 'half' } : {}) } as RequestInit);
}
/** The adapter's own answers (a malformed request, a failed response) carry the host's fields too. */
function plain(res: ServerResponse, status: number, text: string, fields: Record<string, string>): void {
  res.writeHead(status, { ...fields, Connection: 'close' }).end(text);
}

async function handle(req: IncomingMessage, res: ServerResponse, dispatch: Dispatch, secure: boolean, fields: Record<string, string>): Promise<void> {
  // VERIFIED: (execution-deadline test) the client signal must survive a lease abort so a 504 is still sent; scope is the plugin signal.
  const client = new AbortController(), scope = new AbortController();
  const disconnect = (reason: Error) => { client.abort(reason); scope.abort(reason); };
  const onClose = () => { if (!res.writableFinished) disconnect(new Error('Client disconnected')); };
  const onRequestClose = () => { if (!req.complete) disconnect(new Error('Request incomplete')); };
  req.once('close', onRequestClose); res.once('close', onClose);
  try {
    let request: Request, url: URL;
    try {
      url = requestUrl(req, secure);
      request = toRequest(req, url, scope);
    } catch {
      plain(res, 400, 'Bad Request', fields); return;
    }
    const result = await dispatch(request, { peer: req.socket.remoteAddress, client: client.signal, scope, url });
    // Node sends a handshake (Connection: upgrade) to the 'upgrade' listener, so an acceptance here lacks one.
    if (result.upgrade) { result.finish('error', 0); plain(res, 400, 'Bad Request', fields); return; }
    if (result.response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) res.setTimeout(0);
    // If a protocol rejected an unread upload, close instead of draining attacker-controlled data.
    if (!req.complete) res.setHeader('Connection', 'close');
    await send(result, req, res);
  } catch {
    if (!res.headersSent && !res.destroyed) {
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      plain(res, 500, 'Internal Server Error', fields);
    }
    else if (!res.destroyed) res.destroy();
  } finally {
    req.off('close', onRequestClose); res.off('close', onClose);
  }
}

/** The Content-Length body of a request Node handed to 'upgrade': `head`, then the socket's bytes, with backpressure. */
function upgradeBody(socket: Socket, head: Buffer, length: number): ReadableStream<Uint8Array> {
  let left = length;
  const stop = () => { socket.off('data', push); socket.off('end', cut); socket.off('close', cut); };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  function push(chunk: Buffer) {
    const part = chunk.subarray(0, left); left -= part.length;
    controller.enqueue(new Uint8Array(part));
    if (!left) { stop(); controller.close(); } else if ((controller.desiredSize ?? 1) <= 0) socket.pause();
  }
  function cut() { stop(); controller.error(new Error('Request body truncated')); }
  return new ReadableStream<Uint8Array>({
    start(c) { controller = c; socket.on('data', push); socket.once('end', cut); socket.once('close', cut); if (head.length) push(head); },
    pull() { socket.resume(); },
    cancel() { stop(); socket.pause(); },
  }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
}

/** A request with Upgrade and Connection: upgrade. Node hands its raw socket over, so the dispatcher's answer is either
 * a WebSocket the plugin accepted, or an ordinary response written through a ServerResponse on that socket, which then
 * closes. VERIFIED: (Node 22.16 probe) a ServerResponse assigned to an upgrade socket sends a complete response with
 * Connection: close. VERIFIED: (Node 22.16 probe) Node sends every Upgrade request here, ignoring shouldUpgradeCallback,
 * also the `Upgrade: h2c` POST of `curl --http2`, which 0.3.0 answered; so another upgrade's Content-Length body is read
 * where the Node version leaves it. A WebSocket handshake's bytes after the head are frames, so a handshake with a body
 * is 400, as is a chunked body, which Node 22 and 24 no longer decode on this socket. */
async function upgrade(req: IncomingMessage, socket: Socket, head: Buffer, dispatch: Dispatch, options: ServeOptions, fields: Record<string, string>): Promise<void> {
  const client = new AbortController(), scope = new AbortController();
  const disconnect = () => { const reason = new Error('Client disconnected'); client.abort(reason); scope.abort(reason); };
  socket.on('error', () => socket.destroy());
  socket.once('close', disconnect);
  const respond = () => {
    const res = new ServerResponse(req); res.assignSocket(socket); res.shouldKeepAlive = false;
    res.once('finish', () => { res.detachSocket(socket); socket.end(); });
    return res;
  };
  let res: ServerResponse | undefined;
  try {
    let request: Request, url: URL;
    try {
      url = requestUrl(req, !!options.tls);
      const length = req.headers['content-length'] ?? '0', method = req.method ?? 'GET';
      const websocket = (req.headers.upgrade ?? '').split(',').some(token => token.trim().toLowerCase() === 'websocket');
      const bodied = /^\d+$/.test(length) && Number(length) > 0 && !websocket && method !== 'GET' && method !== 'HEAD';
      if (req.headers['transfer-encoding'] || (length !== '0' && !bodied)) throw new Error('This upgrade request cannot carry a body');
      // VERIFIED: (Node 22.16, 24.22 and 26.13 probes) Node 22 and 24 stop parsing at the head: `req` is complete and
      // empty, the body is `head` and then the socket's bytes. Node 26 parses the body into `req` and hands over only
      // the bytes after it, so `req` is then incomplete or holds buffered data, and the default body reads it.
      const parsed = !req.complete || req.readableLength > 0;
      request = toRequest(req, url, scope, bodied && !parsed ? upgradeBody(socket, head, Number(length)) : undefined);
    } catch { plain(respond(), 400, 'Bad Request', fields); return; }
    const result = await dispatch(request, { peer: socket.remoteAddress, client: client.signal, scope, url });
    if (result.upgrade) {
      socket.off('close', disconnect);   // the socket's end is now the session's
      const session = new Session(result.upgrade, socket.remoteAddress, result.signal, result.finish);
      if (socket.destroyed) { session.ended(1006, ''); return; }
      openNodeWebSocket(socket, head, session, result.upgrade.key, result.upgrade.protocol, result.response.headers, options.maxWebSocketMessageBytes ?? 1024 * 1024);
      return;
    }
    res = respond();
    await send(result, req, res);
  } catch {
    if (res && !res.headersSent && !socket.destroyed) plain(res, 500, 'Internal Server Error', fields);
    else if (!res && !socket.destroyed) plain(respond(), 500, 'Internal Server Error', fields);
    else socket.destroy();
  }
}

/** Native Node HTTP/HTTPS listener with backpressure, cancellation and bounded shutdown. */
export const listenNode: Listen = async (options, dispatch) => {
  const fields = Object.fromEntries(fieldList(options.responseHeaders, 'responseHeaders'));
  const handler = (req: IncomingMessage, res: ServerResponse) => { void handle(req, res, dispatch, !!options.tls, fields); };
  const server = options.tls ? createTlsServer(options.tls, handler) : createServer(handler);
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => { void upgrade(req, socket as Socket, head, dispatch, options, fields); });
  const sockets = new Set<Socket>();
  if (options.maxConnections) server.maxConnections = options.maxConnections;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.setTimeout((options.idleTimeout ?? 120) * 1000);
  // Node's default 300s whole-body timeout differs from the configured inactivity policy.
  server.requestTimeout = options.bodyTimeoutMs ?? 300000;
  server.headersTimeout = options.headersTimeoutMs ?? 30000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8080, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  let port: number, url: URL;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected listener address');
    port = address.port; url = hostUrl(options.host ?? '127.0.0.1', port, !!options.tls);
  } catch (error) {
    // VERIFIED: (regression test) a bound socket nobody can stop keeps the port and the process alive, e.g. when an IPv6 zone host cannot form a URL.
    server.close(); throw error;
  }
  return {
    port, url,
    async stop(timeoutMs) {
      const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      if (!(await within(closing, timeoutMs))) { for (const socket of sockets) socket.destroy(); void closing.catch(() => {}); }
    },
  };
};
