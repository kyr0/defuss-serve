/** This file runs from a fresh consumer directory after installing the tarball. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServePlugin } from 'defuss-serve';
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
const other = cjs.createServer({ port: 0, plugins: [endpoint('esm-plugin', '/esm')] });
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
  assert.equal(await (await fetch(new URL('/esm', other.url!))).text(), 'esm-plugin');
  await server.addPlugin(endpoint('live', '/live')); assert.equal(await (await request('/live')).text(), 'live');
  await server.removePlugin('live'); assert.equal((await request('/live')).status, 404);
  console.log(`Packed consumer PASS: ${server.runtime}, ESM and CommonJS, HTTP static/range, protocol adapters, live registration, independent listeners`);
} finally { await Promise.all([server.stop(), other.stop()]); await rm(root, { recursive: true, force: true }); }
