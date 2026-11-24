import type { StaticFilePlan } from '../static/plan.js';
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
}
export type Dispatch = (request: Request, peer?: string) => Promise<DispatchResult>;
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
