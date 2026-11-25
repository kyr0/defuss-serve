import { validateHeaderName, validateHeaderValue } from 'node:http';

/** Fields that only the listener or the representation may set: framing and connection control (RFC 9110 section
 * 7.6.1), the representation's own metadata, cookies, and the WebSocket handshake. A host-wide value for any of them
 * would corrupt some response, so neither responseHeaders nor a WebSocket's extra 101 fields may name one.
 * VERIFIED: tests/response-headers.test.ts refuses each of them when the server is made. */
const owned = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'content-length', 'content-type', 'content-encoding', 'content-range', 'set-cookie']);
export type FieldList = readonly (readonly [string, string])[];

/** Validate a record of fields once, at construction: syntax, no owned name, no name twice in another case. */
export function fieldList(fields: Readonly<Record<string, string>> | undefined, label: string): FieldList {
  if (!fields) return [];
  const seen = new Set<string>(); const list: [string, string][] = [];
  for (const [name, value] of Object.entries(fields)) {
    const lower = name.toLowerCase();
    let valid = typeof value === 'string' && !owned.has(lower) && !lower.startsWith('sec-websocket-') && !seen.has(lower);
    if (valid) try { validateHeaderName(name); validateHeaderValue(name, value); } catch { valid = false; }
    if (!valid) throw new TypeError(`Invalid ${label} field: ${name}`);
    seen.add(lower); list.push([lower, value]);
  }
  return list;
}

/** Set the host's fields on a response, replacing its own of the same name. In place where the headers are mutable,
 * as every static plan's are: the Bun adapter builds the file body from the plan's own response. */
export function withFields(response: Response, list: FieldList): Response {
  if (!list.length) return response;
  const set = (headers: Headers) => { for (const [name, value] of list) headers.set(name, value); };
  try { set(response.headers); return response; }
  catch { const headers = new Headers(response.headers); set(headers); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
}
