import type { StaticFilePlan } from '../static/plan.js';
import type { Upgrade } from '../websocket/session.js';
import type { ServeOptions } from '../types.js';
export interface Listener {
  readonly url: URL;
  readonly port: number;
  stop(timeoutMs: number): Promise<void>;
}
export type Completion = (phase: 'complete' | 'error' | 'cancel', bytes: number) => void;
export interface DispatchResult {
  response: Response;
  file?: StaticFilePlan;
  signal: AbortSignal;
  length?: number;
  finish: Completion;
  untracked?: boolean;
  /** A plugin accepted a WebSocket: the adapter sends 101 with `response`'s fields and runs the socket, calling `finish`
   * when it ends. VERIFIED: tests/websocket.test.ts on the Node and the Bun adapter. */
  upgrade?: Upgrade;
}
/** Transport facts for one request. `client` aborts only on disconnect. An adapter that supplies `scope`
 * has built `request.signal` from it and aborts it on disconnect too, so a plugin lease can reuse that
 * Request instead of cloning it. VERIFIED: dropping the clone and AbortSignal.any cut Node 22.16 server CPU
 * per small API request from 48 to 37 us in an alternating A/B on macOS arm64. Bun builds its own Request. */
export interface Incoming { peer?: string; client: AbortSignal; scope?: AbortController; url?: URL }
export type Dispatch = (request: Request, incoming: Incoming) => Promise<DispatchResult>;
export function hostUrl(host: string, port: number, secure: boolean): URL {
  return new URL(`${secure ? 'https' : 'http'}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/`);
}
export async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
export type Listen = (options: ServeOptions, dispatch: Dispatch) => Promise<Listener>;
