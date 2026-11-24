import { validateHeaderName, validateHeaderValue } from 'node:http';

/** Protocol plugins cannot control body framing; the listener owns it. */
const forbidden = new Set(['transfer-encoding', 'upgrade', 'trailer', 'te']);
const token = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/** Connection management also belongs to the listener. Like a gateway (RFC 9110 section 7.6.1), drop Connection,
 * the fields it nominates, Keep-Alive and Proxy-Connection instead of failing the response. Body framing fields
 * stay errors even when nominated, because removing them would change how the body is read.
 * VERIFIED: defuss-mcp 0.6.0 and the defuss-rpc 4.0.0 upload progress stream send `Connection: keep-alive` on SSE. */
export function dropConnectionFields(response: Response): Response {
  const connection = response.headers.get('connection');
  if (connection === null && !response.headers.has('keep-alive') && !response.headers.has('proxy-connection')) return response;
  const names = ['connection', 'keep-alive', 'proxy-connection'];
  for (const part of connection?.split(',') ?? []) { const name = part.trim().toLowerCase(); if (token.test(name) && !forbidden.has(name)) names.push(name); }
  const drop = (headers: Headers) => { for (const name of names) headers.delete(name); };
  try { drop(response.headers); return response; }
  catch { const headers = new Headers(response.headers); drop(headers); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
}
export function validateResponse(response: Response, hasBody: boolean, method: string): number | undefined {
  if (response.status < 200 || response.status > 599) throw new Error('Invalid final response status');
  for (const [name, value] of response.headers) {
    if (forbidden.has(name)) throw new Error('Hop-by-hop response header');
    validateHeaderName(name); validateHeaderValue(name, value);
  }
  const length = response.headers.get('content-length');
  if (length === null) return undefined;
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new Error('Invalid Content-Length');
  const n = Number(length);
  if (response.status === 204 || (response.status === 205 && n !== 0)) throw new Error('Invalid no-content framing');
  if (!hasBody && method !== 'HEAD' && response.status !== 304 && n !== 0) throw new Error('Content-Length without body');
  return n;
}
export function checkChunk(bytes: number, length: number | undefined): void {
  if (length !== undefined && bytes > length) throw new Error('Response exceeds declared Content-Length');
}
export function checkEnd(bytes: number, length: number | undefined): void {
  if (length !== undefined && bytes !== length) throw new Error('Response shorter than declared Content-Length');
}
