import { validateHeaderName, validateHeaderValue } from 'node:http';

/** Protocol plugins cannot control connection framing; the listener owns it. */
const forbidden = new Set(['connection', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade', 'trailer', 'te']);
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
