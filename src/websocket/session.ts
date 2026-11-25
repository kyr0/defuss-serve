import type { Completion } from '../runtime/types.js';
import type { ServeWebSocket, WebSocketHandlers } from '../types.js';

/** What a runtime's socket offers a session: Bun's native WebSocket, or the Node adapter's RFC 6455 framing. */
export interface Transport {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  readonly buffered: number;
}
/** A dispatched acceptance: its handlers, chosen subprotocol, the client's key, and how to report a handler error. */
export interface Upgrade { readonly handlers: WebSocketHandlers; readonly protocol: string; readonly key: string; report(): void }

/** A peer that lets this many bytes queue unsent is disconnected: Bun's closeOnBackpressureLimit, and the Node adapter's check. */
export const BACKPRESSURE_LIMIT = 16 * 1024 * 1024;
const encoder = new TextEncoder();
/** The close codes an application may send (RFC 6455 section 7.4; as WebSocket.close in browsers) and the reason limit. */
export function checkClose(code: number, reason: string): void {
  if (!Number.isInteger(code) || (code !== 1000 && (code < 3000 || code > 4999))) throw new RangeError('Invalid WebSocket close code');
  if (encoder.encode(reason).byteLength > 123) throw new RangeError('WebSocket close reason longer than 123 bytes');
}

/** One socket between a runtime's transport and the plugin's handlers. It holds the plugin lease until the socket
 * ends: a lease abort (plugin removal, server stop) closes it with 1001, a throwing handler with 1011.
 * VERIFIED: tests/websocket.test.ts, the removal and stop test and the handler-error test, on both runtimes. */
export class Session implements ServeWebSocket {
  private transport?: Transport;
  private closing = false; private done = false; private failed = false; private aborted = false; private bytes = 0;
  constructor(private readonly upgrade: Upgrade, readonly remoteAddress: string | undefined,
    private readonly signal: AbortSignal, private readonly finish: Completion) {}
  get protocol(): string { return this.upgrade.protocol; }
  get bufferedAmount(): number { return this.transport?.buffered ?? 0; }
  send(data: string | Uint8Array): void {
    if (this.closing || this.done || !this.transport) return;
    this.bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    this.transport.send(data);
  }
  close(code = 1000, reason = ''): void { checkClose(code, reason); this.shut(code, reason); }
  private shut(code: number, reason: string): void {
    if (this.closing || this.done) return;
    this.closing = true; this.transport?.close(code, reason);
  }
  private abort = () => { this.aborted = true; this.shut(1001, ''); };
  private run(handler: () => void): void {
    try { handler(); } catch { this.failed = true; this.upgrade.report(); this.shut(1011, ''); }
  }
  /** The 101 is written: the plugin's open runs. */
  opened(transport: Transport): void {
    this.transport = transport;
    this.signal.addEventListener('abort', this.abort, { once: true });
    if (this.signal.aborted) { this.abort(); return; }
    this.run(() => this.upgrade.handlers.open?.(this));
  }
  received(data: string | Uint8Array): void {
    if (!this.done) this.run(() => this.upgrade.handlers.message?.(this, data));
  }
  /** The socket ended: the plugin's close runs, then the lease is released. */
  ended(code: number, reason: string): void {
    if (this.done) return;
    this.done = true; this.signal.removeEventListener('abort', this.abort);
    this.run(() => this.upgrade.handlers.close?.(this, code, reason));
    this.finish(this.failed ? 'error' : this.aborted || code === 1006 ? 'cancel' : 'complete', this.bytes);
  }
}
