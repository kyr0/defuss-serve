import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { hostUrl, within } from './types.js';
import { checkChunk, checkEnd } from './framing.js';
import type { Dispatch, DispatchResult, Listen } from './types.js';

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

async function handle(req: IncomingMessage, res: ServerResponse, dispatch: Dispatch, secure: boolean): Promise<void> {
  const abort = new AbortController();
  const onClose = () => { if (!res.writableFinished) abort.abort(new Error('Client disconnected')); };
  const onRequestClose = () => { if (!req.complete) abort.abort(new Error('Request incomplete')); };
  req.once('close', onRequestClose); res.once('close', onClose);
  try {
    let request: Request;
    try {
      const url = requestUrl(req, secure);
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const method = req.method ?? 'GET';
      const body = method !== 'GET' && method !== 'HEAD' && (headers.has('content-length') || headers.has('transfer-encoding'))
        ? Readable.toWeb(req, { strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength } }) as ReadableStream<Uint8Array> : undefined;
      request = new Request(url, { method, headers, body, signal: abort.signal, ...(body ? { duplex: 'half' } : {}) } as RequestInit);
    } catch {
      res.writeHead(400, { Connection: 'close' }).end('Bad Request'); return;
    }
    const result = await dispatch(request, req.socket.remoteAddress);
    if (result.response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) res.setTimeout(0);
    // If a protocol rejected an unread upload, close instead of draining attacker-controlled data.
    if (!req.complete) res.setHeader('Connection', 'close');
    await send(result, req, res);
  } catch {
    if (!res.headersSent && !res.destroyed) {
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      res.writeHead(500, { Connection: 'close' }).end('Internal Server Error');
    }
    else if (!res.destroyed) res.destroy();
  } finally {
    req.off('close', onRequestClose); res.off('close', onClose);
  }
}

/** Native Node HTTP/HTTPS listener with backpressure, cancellation and bounded shutdown. */
export const listenNode: Listen = async (options, dispatch) => {
  const handler = (req: IncomingMessage, res: ServerResponse) => { void handle(req, res, dispatch, !!options.tls); };
  const server = options.tls ? createTlsServer(options.tls, handler) : createServer(handler);
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
