import type { FileHandle } from 'node:fs/promises';
import { fileBody } from './body.js';

/** Header-only response plus an owned descriptor. Node reads directly; Bun uses a Web stream. */
export interface StaticFilePlan {
  readonly response: Response;
  readonly handle: FileHandle;
  readonly start: number;
  readonly end: number;
  close(): Promise<void>;
}
export type StaticResult = Response | StaticFilePlan;
export function asResponse(plan: StaticFilePlan, signal: AbortSignal): Response {
  return new Response(fileBody(plan.handle, plan.start, plan.end, signal, plan.close), {
    status: plan.response.status, headers: plan.response.headers,
  });
}
