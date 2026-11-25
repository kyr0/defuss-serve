import { asResponse } from '../static/plan.js';
import { trackBody } from '../lifecycle.js';
import { bunRuntime } from './bun-types.js';
import type { BunWebSocket } from './bun-types.js';
import { within } from './types.js';
import { fieldList, withFields } from '../policy.js';
import { BACKPRESSURE_LIMIT, Session } from '../websocket/session.js';
import type { Listen } from './types.js';

/** Keep Bun's native Fetch server and file-backed responses, without an Express shim. */
export const listenBun: Listen = async (options, dispatch) => {
  const bun = bunRuntime();
  if (!bun) throw new Error('Bun runtime requested but unavailable');
  const fields = fieldList(options.responseHeaders, 'responseHeaders');
  const session = (socket: BunWebSocket) => socket.data as Session;
  const server = bun.serve({
    hostname: options.host ?? '127.0.0.1', port: options.port ?? 8080,
    // VERIFIED: on Bun 1.4.5 (raw probe) development:false implies SO_REUSEPORT; an occupied port must fail like Node's EADDRINUSE.
    idleTimeout: options.idleTimeout ?? 120, development: false, reusePort: false,
    // The common dispatcher implements a streaming opt-in limit. Bun also has a native request cap.
    maxRequestBodySize: options.maxBodyBytes ?? 1024 ** 3,
    tls: options.tls,
    async fetch(request, listener) {
      const peer = listener.requestIP(request)?.address;
      const result = await dispatch(request, { peer, client: request.signal });
      if (result.upgrade) {
        // VERIFIED: (Bun 1.4.3 and 1.4.5 probes) without the field Bun echoes the client's first offered subprotocol. An
        // empty value in a plain object makes 1.4.5 send none; 1.4.3 sends it empty, beside its echo when there was an
        // offer, and throws on an empty plain object; in a Headers object 1.4.3 drops the empty value and echoes. So the
        // field is set only when the client offered one: the plugin's choice, or empty for a declined offer (on 1.4.3 the
        // client then rejects the handshake rather than speak a protocol nobody chose), as a plain object only when non-empty.
        const headers: Record<string, string> = {};
        for (const [name, value] of result.response.headers) headers[name] = value;
        if (result.upgrade.protocol || request.headers.has('sec-websocket-protocol')) headers['Sec-WebSocket-Protocol'] = result.upgrade.protocol;
        const data = new Session(result.upgrade, peer, result.signal, result.finish);
        if (listener.upgrade(request, { data, headers: Object.keys(headers).length ? headers : undefined })) return undefined;
        result.finish('error', 0);
        return withFields(new Response('Bad Request', { status: 400 }), fields);
      }
      let response: Response | undefined;
      const finish: typeof result.finish = (phase, bytes) => {
        if (result.file) void result.file.close().then(() => result.finish(phase, bytes), () => result.finish('error', bytes));
        else result.finish(phase, bytes);
      };
      try {
        response = result.file ? asResponse(result.file, result.signal) : result.response;
        if (response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) listener.timeout(request, 0);
        if (result.untracked) return response;
        return trackBody(response, result.signal, finish, request.method === 'HEAD' ? undefined : result.length);
      } catch (error) {
        try { await (result.file ? result.file.close() : response?.body?.cancel(error)); } finally { result.finish('error', 0); }
        return withFields(new Response('Internal Server Error', {status: 500}), fields);
      }
    },
    // Native sockets with the Node adapter's semantics: no idle timeout or pings (protocols own keepalive), no
    // compression, the message ceiling of maxWebSocketMessageBytes, and a peer that lets 16 MiB queue is closed.
    websocket: {
      maxPayloadLength: options.maxWebSocketMessageBytes ?? 1024 * 1024, idleTimeout: 0, sendPings: false, perMessageDeflate: false,
      backpressureLimit: BACKPRESSURE_LIMIT, closeOnBackpressureLimit: true,
      open(socket) {
        socket.binaryType = 'uint8array';
        session(socket).opened({ send: data => { socket.send(data); }, close: (code, reason) => socket.close(code, reason), get buffered() { return socket.getBufferedAmount(); } });
      },
      message(socket, data) { session(socket).received(data); },
      close(socket, code, reason) { session(socket).ended(code, reason); },
    },
  });
  return { url: server.url, port: server.port, async stop(timeoutMs) {
    if (!(await within(Promise.resolve(server.stop(false)), timeoutMs))) void Promise.resolve(server.stop(true)).catch(() => {});
  } };
};
