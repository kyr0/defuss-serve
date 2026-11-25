/** This file runs from a fresh consumer directory after installing the tarball. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { createServer, acceptWebSocket, type ServePlugin } from 'defuss-serve';
import { rpcPlugin, mcpPlugin, o11yPlugin } from 'defuss-serve/plugins';
const require = createRequire(import.meta.url);
const cjs = require('defuss-serve') as typeof import('defuss-serve');
const cjsPlugins = require('defuss-serve/plugins') as typeof import('defuss-serve/plugins');
const root = await mkdtemp(join(tmpdir(), 'serve-consumer-'));
await writeFile(join(root, 'index.html'), '<h1>consumer</h1>');
await writeFile(join(root, 'movie.mp4'), '0123456789');
// A real listener-independent Fetch service, not a mock of an upstream library.
const endpoint = (name: string, path: string): ServePlugin => ({ name, matches: r => new URL(r.url).pathname === path, fetch: () => new Response(name) });
const server = createServer({ publicDir: root, port: 0, plugins: [
  rpcPlugin(async ({ request }) => Response.json({ received: await request.json() })),
  mcpPlugin({ fetch: () => Response.json({ mode: 'fetch' }) }),
  o11yPlugin({ fetch: () => new Response('healthy') }),
  cjsPlugins.endpointPlugin('commonjs-plugin', { fetch: () => new Response('cjs') }, [{ path: '/cjs' }]),
] });
const socket: ServePlugin = { name: 'socket', routes: [{ path: '/socket', methods: ['GET'] }], fetch: r => acceptWebSocket(r, { message(ws, data) { ws.send(data); } }) };
const requests: string[] = [];
const other = cjs.createServer({ port: 0, responseHeaders: { 'Cross-Origin-Opener-Policy': 'same-origin' }, plugins: [endpoint('esm-plugin', '/esm'), socket], onRequest: e => requests.push(`${e.method} ${e.path} -> ${e.status}${e.rejected ? ' rejected' : ''}`) });
try {
  await server.start(); await other.start();
  const request = (path: string, init?: RequestInit) => fetch(new URL(path, server.url!), init);
  assert.equal(await (await request('/')).text(), '<h1>consumer</h1>');
  const part = await request('/movie.mp4', { headers: { range: 'bytes=2-4' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 2-4/10'); assert.equal(await part.text(), '234');
  assert.deepEqual(await (await request('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' })).json(), { received: { x: 1 } });
  assert.deepEqual(await (await request('/mcp', { method: 'POST', body: '{}' })).json(), { mode: 'fetch' });
  assert.equal(await (await request('/health')).text(), 'healthy');
  assert.equal(await (await request('/cjs')).text(), 'cjs');
  const esm = await fetch(new URL('/esm', other.url!)); assert.equal(await esm.text(), 'esm-plugin');
  assert.equal(esm.headers.get('cross-origin-opener-policy'), 'same-origin');
  // An HTTP/1.0 request without a Host is refused with 400, and onRequest names it.
  const hostless = await new Promise<string>((resolve, reject) => { const s = connect(other.port!, '127.0.0.1'); let text = ''; s.on('data', d => { text += d; }); s.on('close', () => resolve(text)); s.on('error', reject); s.write('GET /relay-probe HTTP/1.0\r\n\r\n'); });
  assert.match(hostless, /^HTTP\/1\.1 400 /); assert.deepEqual(requests, ['GET /esm -> 200', 'GET /relay-probe -> 400 rejected']);
  const ws = new WebSocket(`ws://127.0.0.1:${other.port}/socket`);
  const echoed = await new Promise<unknown>((resolve, reject) => { ws.onopen = () => ws.send('ping'); ws.onmessage = e => resolve(e.data); ws.onerror = () => reject(new Error('WebSocket failed')); });
  assert.equal(echoed, 'ping'); ws.close();
  await server.addPlugin(endpoint('live', '/live')); assert.equal(await (await request('/live')).text(), 'live');
  await server.removePlugin('live'); assert.equal((await request('/live')).status, 404);
  console.log(`Packed consumer PASS: ${server.runtime}, ESM and CommonJS, HTTP static/range, protocol adapters, live registration, independent listeners, a WebSocket echo, host response fields, a host-less request in onRequest`);
} finally { await Promise.all([server.stop(), other.stop()]); await rm(root, { recursive: true, force: true }); }
