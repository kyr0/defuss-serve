import type { FileHandle } from 'node:fs/promises';
/** Demand-driven descriptor reads: no Node-to-Web-to-Node adapter chain. */
export function fileBody(handle: FileHandle, start: number, end: number, signal: AbortSignal, dispose = () => handle.close()): ReadableStream<Uint8Array> {
  let position = start;
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closing: Promise<void> | undefined;
  const close = () => {
    closed = true; signal.removeEventListener('abort', abort);
    return closing ??= dispose();
  };
  const abort = () => {
    if (closed) return;
    controller.error(signal.reason);
    void close().catch(() => {});
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    async pull(c) {
      if (closed) return;
      try {
        if (position > end) { await close(); c.close(); return; }
        const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, end - position + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (closed) return;
        if (!bytesRead) throw new Error('Static file truncated during transfer');
        position += bytesRead;
        c.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        if (!closed) { c.error(error); await close().catch(() => {}); }
        else if (!signal.aborted) throw error;
      }
    },
    cancel() { return close(); },
  }, { highWaterMark: 0 });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return stream;
}
