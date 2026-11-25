/** A listener-independent endpoint. Declared routes permit validation before publication. */
export interface ServeRoute {
  readonly path: string;
  readonly prefix?: boolean;
  readonly methods?: readonly string[];
}

/** Plugins own protocol semantics and authentication; the host owns transport. */
export interface TransportLimits {
  readonly maxBodyBytes?: number;
  readonly bodyTimeoutMs?: number;
  /** Maximum active calls, including response production and cancellation. 0 disables. */
  readonly maxConcurrentRequests?: number;
  /** Cooperative deadline from admission until the handler returns headers; 0 disables. */
  readonly executionTimeoutMs?: number;
}
export interface ServePlugin extends TransportLimits {
  readonly name: string;
  readonly routes?: readonly ServeRoute[];
  /** Optional predicate for declared routes; required when no routes are declared. */
  matches?(request: Request): boolean;
  fetch(request: Request): Response | Promise<Response>;
  start?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

/** One accepted WebSocket, the same on Bun and Node. VERIFIED: tests/websocket.test.ts runs every member on both runtimes. */
export interface ServeWebSocket {
  /** The subprotocol the plugin chose from the client's offer, or ''. */
  readonly protocol: string;
  /** The peer's address as the listener saw it. */
  readonly remoteAddress: string | undefined;
  /** Bytes queued for the peer and not yet written to the socket. */
  readonly bufferedAmount: number;
  /** Sends a text (string) or binary (bytes) message; ignored once the socket is closing. */
  send(data: string | Uint8Array): void;
  /** Starts the closing handshake: code 1000 (default) or 3000-4999, a reason of at most 123 UTF-8 bytes; RangeError otherwise. */
  close(code?: number, reason?: string): void;
}
/** A socket's events. A handler that throws closes its socket with 1011. */
export interface WebSocketHandlers {
  open?(socket: ServeWebSocket): void;
  message?(socket: ServeWebSocket, data: string | Uint8Array): void;
  /** The close code and reason the closing frame carried (1005 without a code, 1006 without a closing frame). */
  close?(socket: ServeWebSocket, code: number, reason: string): void;
}
/** What acceptWebSocket takes: the handlers, a subprotocol the client offered, and extra fields of the 101 response. */
export interface WebSocketAccept extends WebSocketHandlers {
  readonly protocol?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FetchEndpoint {
  fetch(request: Request): Response | Promise<Response>;
  start?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface RequestEvent {
  readonly method: string;
  readonly status: number;
  readonly handler: string;
  /** Time until response headers, excluding transfer time. */
  readonly durationMs: number;
}

export interface Diagnostic {
  readonly code: 'static-shadow' | 'plugin-collision' | 'request-error' | 'plugin-close-error' | 'plugin-drain-timeout' | 'plugin-close-timeout' | 'plugin-execution-timeout' | 'response-framing-error';
  readonly plugin?: string;
}

export interface CorsOptions {
  /** Exact origins; '*' is permitted only without credentials. */
  readonly origins: readonly string[];
  readonly credentials?: boolean;
  readonly methods?: readonly string[];
  readonly headers?: readonly string[];
  readonly exposeHeaders?: readonly string[];
  readonly maxAge?: number;
}

export interface TlsOptions {
  /** PEM contents, not paths. */
  readonly key: string;
  readonly cert: string;
}

/** Body production, not network delivery or client acknowledgement. */
export interface LifecycleEvent {
  readonly phase: 'start' | 'headers' | 'complete' | 'error' | 'cancel';
  readonly method: string;
  readonly handler: string;
  readonly route: string;
  readonly status?: number;
  readonly durationMs: number;
  readonly bytes: number;
  readonly activeRequests: number;
  readonly activeStreams: number;
}
export interface ServeStats {
  readonly activeRequests: number;
  readonly activeStreams: number;
  readonly activeHandlers: number;
  readonly activeUploads: number;
  readonly openStaticFiles: number;
  readonly pendingCleanup: number;
  readonly rejected: number;
}
export interface ServeOptions {
  readonly host?: string;
  readonly port?: number;
  readonly runtime?: 'auto' | 'bun' | 'node';
  readonly publicDir?: string;
  readonly plugins?: readonly ServePlugin[];
  /** Optional HTML navigation fallback, relative to publicDir. */
  readonly spaFallback?: boolean | string;
  readonly precompressed?: boolean;
  /** Immutable assumes a deployment-owned tree that is never modified in place. */
  readonly staticMode?: 'live' | 'immutable';
  /** Live metadata cache: 0 (default) disables it. */
  readonly staticCacheTtlMs?: number;
  readonly staticCacheEntries?: number;
  readonly maxManifestEntries?: number;
  /** Explicit build-system naming contract for immutable cache headers. */
  readonly immutableAssetPattern?: RegExp;
  readonly staticShadow?: 'allow' | 'warn' | 'error';
  /** Exact hostname allowlist, without ports. Defaults to configured bind host. */
  readonly allowedHosts?: readonly string[];
  /** Only these exact peer IPs may supply forwarding headers. No URL rewriting. */
  readonly trustedProxies?: readonly string[];
  /** Maximum admitted requests; 0 disables. */
  readonly maxConcurrentRequests?: number;
  /** Maximum actual active response bodies; checked after handler returns, 0 disables. */
  readonly maxConcurrentStreams?: number;
  /** Node-only connection limit; 0 disables. Explicit nonzero values rejected on Bun. */
  readonly maxConnections?: number;
  readonly maxConcurrentHandlers?: number;
  readonly maxConcurrentUploads?: number;
  readonly maxOpenStaticFiles?: number;
  /** Trusted, build-generated SHA-256 manifest outside publicDir; immutable mode only. */
  readonly assetManifest?: string;
  /** Absolute body-read deadline; 0 disables. */
  readonly bodyTimeoutMs?: number;
  /** Node header deadline. Bun uses native idle timeout instead. */
  readonly headersTimeoutMs?: number;
  /** Bun-only opt-in: bypass body tracking for static files. Requires disabled admission and file limits and no lifecycle observer. */
  readonly nativeStaticFastPath?: boolean;
  readonly cacheControl?: string;
  /** Fields the host sets on every response it sends, replacing a response's field of the same name. */
  readonly responseHeaders?: Readonly<Record<string, string>>;
  /** The largest WebSocket message a peer may send, in bytes; 1 MiB by default. */
  readonly maxWebSocketMessageBytes?: number;
  readonly allowDotfiles?: boolean;
  readonly cors?: CorsOptions;
  readonly tls?: TlsOptions;
  /** Optional maximum streaming request bytes. Protocols should also set their own limits. */
  readonly maxBodyBytes?: number;
  /** Socket inactivity in seconds. 0 disables. SSE disables the Bun per-request timer. */
  readonly idleTimeout?: number;
  /** Maximum time to await each plugin startup hook. */
  readonly pluginStartTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onLifecycle?: (event: LifecycleEvent) => void;
  readonly onRequest?: (event: RequestEvent) => void;
  readonly onDiagnostic?: (event: Diagnostic) => void;
}

export type ServerState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface ServeServer {
  readonly state: ServerState;
  readonly url: URL | undefined;
  readonly port: number | undefined;
  readonly runtime: 'bun' | 'node';
  readonly plugins: readonly string[];
  readonly stats: ServeStats;
  start(): Promise<ServeServer>;
  stop(): Promise<void>;
  addPlugin(plugin: ServePlugin): Promise<void>;
  removePlugin(name: string): Promise<boolean>;
}
