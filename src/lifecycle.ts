import { checkChunk, checkEnd } from './runtime/framing.js';
/** Observe source-body production with one pull-based wrapper. Cancellation owns the reader until settled. */
export function trackBody(response: Response, signal: AbortSignal, finish: (phase: 'complete' | 'error' | 'cancel', bytes: number) => void, length?: number): Response {
  if (!response.body) { finish(signal.aborted ? 'cancel' : 'complete', 0); return response; }
  const reader = response.body.getReader();
  let bytes = 0; let settled = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const done = (phase: 'complete' | 'error' | 'cancel') => {
    signal.removeEventListener('abort', abort);
    try { reader.releaseLock(); } finally { finish(phase, bytes); }
  };
  const cancel = async (reason: unknown) => {
    if (settled) return;
    settled = true;
    try { await reader.cancel(reason); } catch { /* cancellation failed; source is errored */ } finally { done('cancel'); }
  };
  const abort = () => {
    if (settled) return;
    try { controller.error(signal.reason); } catch { /* already terminated */ }
    void cancel(signal.reason);
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    async pull(c) {
      if (settled) return;
      try {
        const chunk = await reader.read();
        if (settled) return;
        if (chunk.done) { checkEnd(bytes, length); settled = true; c.close(); done('complete'); }
        else { if (!(chunk.value instanceof Uint8Array)) throw new TypeError('Response body must produce bytes'); checkChunk(bytes + chunk.value.byteLength, length); bytes += chunk.value.byteLength; c.enqueue(chunk.value); }
      } catch (error) {
        if (!settled) { settled = true; c.error(error); try { await reader.cancel(error); } catch { /* source errored */ } finally { done('error'); } }
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
