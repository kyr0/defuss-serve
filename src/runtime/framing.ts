import { validateHeaderName, validateHeaderValue } from 'node:http';

/** The listener owns every hop-by-hop field: it frames the body and manages the connection. A Fetch body is the
 * decoded payload, so these fields on a plugin or fetch() proxy response describe some other hop. Like a gateway
 * (RFC 9110 section 7.6.1), drop them and the fields Connection nominates. A Transfer-Encoding other than plain
 * chunked stays an error: fetch() removes only chunked framing, so the body would still carry the other coding.
 * VERIFIED: defuss-mcp 0.6.0 and defuss-rpc 4.0.0 upload progress send `Connection: keep-alive`, and a Node fetch() of
 * a streamed reply carries `Transfer-Encoding: chunked`; rejecting either answered 500. */
const hopByHop = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
const token = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
function without(response: Response, names: readonly string[]): Response {
  const drop = (headers: Headers) => { for (const name of names) headers.delete(name); };
  try { drop(response.headers); return response; }
  catch { const headers = new Headers(response.headers); drop(headers); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
}

/** Validate status, header syntax and Content-Length in the one header pass the request already pays for, so
 * dropping hop-by-hop fields adds no lookups. VERIFIED: three Headers.has calls cost about 0.3 us per response on
 * Node 22.16, about 1 % of a small API request. */
export function validateResponse(response: Response, hasBody: boolean, method: string): { response: Response; length?: number } {
  if (response.status < 200 || response.status > 599) throw new Error('Invalid final response status');
  let drop: string[] | undefined, length: string | undefined;
  for (const [name, value] of response.headers) {
    if (hopByHop.has(name)) {
      if (name === 'transfer-encoding' && value.trim().toLowerCase() !== 'chunked') throw new Error('Unsupported transfer coding');
      (drop ??= []).push(name);
      if (name === 'connection') for (const part of value.split(',')) { const field = part.trim().toLowerCase(); if (token.test(field) && field !== 'transfer-encoding') drop.push(field); }
      continue;
    }
    validateHeaderName(name); validateHeaderValue(name, value);
    if (name === 'content-length') length = value;
  }
  if (drop) { response = without(response, drop); if (drop.includes('content-length')) length = undefined; }
  if (length === undefined) return { response };
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new Error('Invalid Content-Length');
  const n = Number(length);
  if (response.status === 204 || (response.status === 205 && n !== 0)) throw new Error('Invalid no-content framing');
  if (!hasBody && method !== 'HEAD' && response.status !== 304 && n !== 0) throw new Error('Content-Length without body');
  return { response, length: n };
}
export function checkChunk(bytes: number, length: number | undefined): void {
  if (length !== undefined && bytes > length) throw new Error('Response exceeds declared Content-Length');
}
export function checkEnd(bytes: number, length: number | undefined): void {
  if (length !== undefined && bytes !== length) throw new Error('Response shorter than declared Content-Length');
}
