import { asResponse } from '../static/plan.js';
import { trackBody } from '../lifecycle.js';
import { bunRuntime } from './bun-types.js';
import { within } from './types.js';
import type { Listen } from './types.js';

/** Keep Bun's native Fetch server and file-backed responses, without an Express shim. */
export const listenBun: Listen = async (options, dispatch) => {
  const bun = bunRuntime();
  if (!bun) throw new Error('Bun runtime requested but unavailable');
  const server = bun.serve({
    hostname: options.host ?? '127.0.0.1', port: options.port ?? 8080,
    // VERIFIED: on Bun 1.4.5 (raw probe) development:false implies SO_REUSEPORT; an occupied port must fail like Node's EADDRINUSE.
    idleTimeout: options.idleTimeout ?? 120, development: false, reusePort: false,
    // The common dispatcher implements a streaming opt-in limit. Bun also has a native request cap.
    maxRequestBodySize: options.maxBodyBytes ?? 1024 ** 3,
    tls: options.tls,
    async fetch(request, listener) {
      const result = await dispatch(request, listener.requestIP(request)?.address);
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
        return new Response('Internal Server Error', {status: 500});
      }
    },
  });
  return { url: server.url, port: server.port, async stop(timeoutMs) {
    if (!(await within(Promise.resolve(server.stop(false)), timeoutMs))) void Promise.resolve(server.stop(true)).catch(() => {});
  } };
};
