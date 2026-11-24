/** Only the Bun APIs used by this package. Avoid a runtime import or mandatory Bun types on Node. */
export interface BunListener {
  readonly port: number;
  readonly url: URL;
  stop(force?: boolean): void | Promise<void>;
  requestIP(request: Request): { address: string } | null;
  timeout(request: Request, seconds: number): void;
}
export interface BunRuntime {
  file(path: string): Blob;
  serve(options: {
    hostname: string; port: number; development?: boolean; reusePort?: boolean; idleTimeout: number; maxRequestBodySize?: number;
    tls?: { key: string; cert: string };
    fetch(request: Request, server: BunListener): Promise<Response>;
  }): BunListener;
}
export function bunRuntime(): BunRuntime | undefined {
  return (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
}
