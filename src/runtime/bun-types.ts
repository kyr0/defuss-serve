/** Only the Bun APIs used by this package. Avoid a runtime import or mandatory Bun types on Node. */
export interface BunListener {
  readonly port: number;
  readonly url: URL;
  stop(force?: boolean): void | Promise<void>;
  requestIP(request: Request): { address: string } | null;
  timeout(request: Request, seconds: number): void;
  /** Must receive the Request object Bun passed to fetch. VERIFIED: (Bun 1.4.5 probe) a copy is refused with 400. */
  upgrade(request: Request, options: { data: unknown; headers?: Record<string, string> }): boolean;
}
export interface BunWebSocket {
  readonly data: unknown;
  binaryType: string;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}
export interface BunRuntime {
  file(path: string): Blob;
  serve(options: {
    hostname: string; port: number; development?: boolean; reusePort?: boolean; idleTimeout: number; maxRequestBodySize?: number;
    tls?: { key: string; cert: string };
    fetch(request: Request, server: BunListener): Promise<Response | undefined>;
    websocket: {
      maxPayloadLength: number; idleTimeout: number; sendPings: boolean; perMessageDeflate: boolean; backpressureLimit: number; closeOnBackpressureLimit: boolean;
      open(socket: BunWebSocket): void;
      message(socket: BunWebSocket, data: string | Uint8Array): void;
      close(socket: BunWebSocket, code: number, reason: string): void;
    };
  }): BunListener;
}
export function bunRuntime(): BunRuntime | undefined {
  return (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
}
