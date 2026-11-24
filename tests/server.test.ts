import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createServer, type ServeOptions, type ServeServer, type ServePlugin } from 'defuss-serve';
import { rpcPlugin, mcpPlugin, o11yPlugin, endpointPlugin } from 'defuss-serve/plugins';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const encoder = new TextEncoder();
const media = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const parent = await mkdtemp(join(tmpdir(), 'defuss-serve-'));
  const root = join(parent, 'public');
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'empty-dir'));
  await mkdir(join(root, 'rpc'));
  await writeFile(join(root, 'index.html'), '<h1>Home</h1>');
  await writeFile(join(root, 'docs/index.html'), '<h1>Docs</h1>');
  await writeFile(join(root, 'movie.mp4'), media);
  await writeFile(join(root, 'empty.txt'), '');
  await writeFile(join(root, 'app.js'), 'export const value = 1;');
  await writeFile(join(root, 'app.js.br'), brotliCompressSync('export const value = 1;'));
  await writeFile(join(root, 'app.js.gz'), gzipSync('export const value = 1;'));
  await writeFile(join(root, 'weird.unknown'), 'binary');
  await writeFile(join(root, 'sp ace.txt'), 'space');
  await writeFile(join(root, 'rpc/schema'), 'static schema');
  await writeFile(join(root, '.secret'), 'hidden');
  await writeFile(join(parent, 'private.txt'), 'private');
  if (process.platform !== 'win32') {
    await symlink(join(parent, 'private.txt'), join(root, 'escape.txt'));
    await symlink(join(root, '.secret'), join(root, 'hidden-link.txt'));
    await symlink(join(root, 'movie.mp4'), join(root, 'inside.mp4'));
  }
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { root, parent };
}
async function run(t: { after(fn: () => Promise<void>): void }, options: ServeOptions = {}) {
  const server = createServer({ port: 0, shutdownTimeoutMs: 100, ...options });
  await server.start();
  t.after(() => server.stop());
  return server;
}
function get(server: ServeServer, path: string, init?: RequestInit) { return fetch(new URL(path, server.url!), init); }
async function status(server: ServeServer, path: string, expected: number, init?: RequestInit) {
  const response = await get(server, path, init);
  assert.equal(response.status, expected, `${init?.method ?? 'GET'} ${path}`);
  return response;
}
// VERIFIED (Bun 1.4.5): Bun frames a streamed body of 256 bytes or more as chunked and drops its declared Content-Length.
// The tracked Bun path must never send a wrong length; Node always sends the declared one.
function declaredLength(response: Response, bytes: number) {
  const length = response.headers.get('content-length');
  if ('Bun' in globalThis && length === null) return;
  assert.equal(length, String(bytes));
}
function textEndpoint(path: string, value: string, name = path) {
  return endpointPlugin(name, { fetch: () => new Response(value) }, [{ path, methods: ['GET'] }]);
}

test('static content, directory redirects, MIME, HEAD, hidden and escaping files, live updates', async t => {
  const { root } = await fixture(t);
  const server = await run(t, { publicDir: root });
  assert.equal(await (await status(server, '/', 200)).text(), '<h1>Home</h1>');
  const redirect = await status(server, '/docs?x=1', 308, { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), '/docs/?x=1');
  assert.equal(await (await status(server, '/docs/', 200)).text(), '<h1>Docs</h1>');
  await status(server, '/empty-dir/', 404);
  await status(server, '/nope', 404);
  await status(server, '/app.js/missing', 404);
  await status(server, '/app.js', 404, { method: 'POST' });
  const head = await status(server, '/movie.mp4', 200, { method: 'HEAD', headers: { range: 'bytes=0-1' } });
  assert.equal(head.headers.get('content-length'), '256');
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(await head.text(), '');
  assert.equal((await status(server, '/weird.unknown', 200)).headers.get('content-type'), 'application/octet-stream');
  assert.equal(await (await status(server, '/sp%20ace.txt', 200)).text(), 'space');
  await status(server, '/.secret', 403);
  await status(server, '/%2esecret', 403);
  await status(server, '/%FF', 400);
  await status(server, '/x%2fy', 400);
  await status(server, '/x%5cy', 400);
  await status(server, '/x%00y', 400);
  if (process.platform !== 'win32') {
    await status(server, '/escape.txt', 403); await status(server, '/hidden-link.txt', 403);
    assert.deepEqual(Buffer.from(await (await status(server, '/inside.mp4', 200)).arrayBuffer()), media);
  }
  await writeFile(join(root, 'new.txt'), 'new');
  assert.equal(await (await status(server, '/new.txt', 200)).text(), 'new');
  await rm(join(root, 'new.txt'));
  await status(server, '/new.txt', 404);
  const visible = await run(t, { publicDir: root, allowDotfiles: true });
  assert.equal(await (await status(visible, '/.secret', 200)).text(), 'hidden');
});

test('single, open, suffix, clipped, empty and unsatisfiable byte ranges; malformed and multi-range ignored', async t => {
  const { root } = await fixture(t);
  const server = await run(t, { publicDir: root });
  const cases = [ ['bytes=0-9', 0, 9], ['bytes=10-', 10, 255], ['bytes=-8', 248, 255], ['bytes=255-99999', 255, 255], ['bytes=-999999999999999999999999', 0, 255], ['bytes=7-999999999999999999999999', 7, 255] ] as const;
  for (const [range, start, end] of cases) {
    const res = await status(server, '/movie.mp4', 206, { headers: { range } });
    assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/256`);
    declaredLength(res, end - start + 1);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), media.subarray(start, end + 1));
  }
  for (const range of ['bytes=256-', 'bytes=999999999999999999999999-', 'bytes=-0']) {
    const res = await status(server, '/movie.mp4', 416, { headers: { range } });
    assert.equal(res.headers.get('content-range'), 'bytes */256');
    assert.equal(await res.text(), '');
  }
  for (const range of ['items=0-1', 'bytes=0-1,3-4', 'bytes=-', 'bytes=3-2', 'bytes=a-b', `bytes=${'1'.repeat(300)}-`]) {
    const res = await status(server, '/movie.mp4', 200, { headers: { range } });
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), media);
  }
  const whole = await status(server, '/movie.mp4', 200);
  declaredLength(whole, 256); assert.deepEqual(Buffer.from(await whole.arrayBuffer()), media);
  await status(server, '/empty.txt', 416, { headers: { range: 'bytes=0-' } });
  assert.equal(await (await status(server, '/empty.txt', 200)).text(), '');
});

test('conditional requests and representation-specific caching', async t => {
  const { root } = await fixture(t);
  const old = new Date('2024-01-01T01:00:00Z');
  await utimes(join(root, 'movie.mp4'), old, old);
  const server = await run(t, { publicDir: root, cacheControl: 'public, max-age=60' });
  const first = await status(server, '/movie.mp4', 200);
  const etag = first.headers.get('etag')!;
  const last = first.headers.get('last-modified')!;
  assert.match(etag, /^W\/"/); assert.equal(last, old.toUTCString());
  assert.equal(first.headers.get('cache-control'), 'public, max-age=60'); await first.arrayBuffer();
  for (const val of [etag, etag.slice(2), `"other", ${etag}`, '*']) await status(server, '/movie.mp4', 304, { headers: { 'if-none-match': val } });
  await status(server, '/movie.mp4', 304, { headers: { 'if-modified-since': last } });
  await status(server, '/movie.mp4', 200, { headers: { 'if-none-match': '"other"', 'if-modified-since': last } });
  await status(server, '/movie.mp4', 412, { headers: { 'if-match': etag } });
  await status(server, '/movie.mp4', 412, { headers: { 'if-unmodified-since': 'Mon, 01 Jan 2020 00:00:00 GMT' } });
  await status(server, '/movie.mp4', 200, { headers: { 'if-match': '*', 'if-unmodified-since': 'Mon, 01 Jan 2020 00:00:00 GMT' } });
  for (const value of [etag, '"other"', 'invalid', 'Mon, 01 Jan 2020 00:00:00 GMT']) await status(server, '/movie.mp4', 200, { headers: { range: 'bytes=1-3', 'if-range': value } });
  await status(server, '/movie.mp4', 206, { headers: { range: 'bytes=1-3', 'if-range': last } });
  const identity = await status(server, '/app.js', 200, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(identity.headers.get('content-encoding'), null);
  for (const encoding of ['br', 'gzip']) {
    const compressed = await status(server, '/app.js', 200, { headers: { 'accept-encoding': encoding } });
    assert.equal(compressed.headers.get('content-encoding'), encoding);
    assert.notEqual(compressed.headers.get('etag'), identity.headers.get('etag'));
    assert.equal(await compressed.text(), 'export const value = 1;');
    assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
    await status(server, '/app.js', 304, { headers: { 'accept-encoding': encoding, 'if-none-match': compressed.headers.get('etag')! } });
  }
  const preferGzip = await status(server, '/app.js', 200, { headers: { 'accept-encoding': 'br;q=0.1, gzip;q=1, identity;q=0' } });
  assert.equal(preferGzip.headers.get('content-encoding'), 'gzip');
  await status(server, '/movie.mp4', 406, { headers: { 'accept-encoding': 'identity;q=0, *;q=0' } });
  await status(server, '/movie.mp4', 406, { headers: { 'accept-encoding': 'identity;q=bogus' } });
  const partial = await status(server, '/app.js', 206, { headers: { 'accept-encoding': 'br', range: 'bytes=0-5' } });
  assert.equal(partial.headers.get('content-encoding'), null);
  assert.equal(await partial.text(), 'export');
  const disabled = await run(t, { publicDir: root, precompressed: false });
  assert.equal((await status(disabled, '/app.js', 200, { headers: { 'accept-encoding': 'br' } })).headers.get('content-encoding'), null);
});

test('static-first dispatch, real HTTP Fetch endpoints, SPA last, method ownership and diagnostics', async t => {
  const { root } = await fixture(t);
  const observed: string[] = [];
  const diagnostics: string[] = [];
  let calls = 0;
  const rpc = rpcPlugin(async ({ request }) => { calls++; return Response.json({ method: request.method, value: await request.text() }); });
  const mcp = mcpPlugin({ fetch: request => Response.json({ protocol: 'mcp', method: request.method }) });
  const o11y = o11yPlugin({ fetch: () => new Response('healthy') });
  const server = await run(t, { publicDir: root, spaFallback: true, plugins: [rpc, mcp, o11y], onRequest: event => observed.push(`${event.handler}:${event.status}`), onDiagnostic: event => diagnostics.push(`${event.code}:${event.plugin}`) });
  assert.equal(await (await status(server, '/rpc/schema', 200)).text(), 'static schema');
  assert.equal(calls, 0);
  assert.deepEqual(diagnostics, ['static-shadow:rpc']);
  const response = await status(server, '/rpc', 200, { method: 'POST', body: 'rpc body', headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await response.json(), { method: 'POST', value: 'rpc body' });
  await status(server, '/rpc/upload', 200, { method: 'POST', body: 'upload' });
  await status(server, '/rpc/upload/id', 200, { method: 'HEAD' });
  await status(server, '/rpc/upload/progress/id', 200);
  await status(server, '/rpc/download', 200);
  assert.equal((await (await status(server, '/mcp', 200, { method: 'POST', body: '{}' })).json()).protocol, 'mcp');
  await status(server, '/mcp/', 200, { method: 'DELETE' });
  assert.equal(await (await status(server, '/healthz', 200)).text(), 'healthy');
  assert.equal(await (await status(server, '/metrics', 200)).text(), 'healthy');
  const wrongMethod = await status(server, '/mcp', 405, { method: 'PUT', headers: { accept: 'text/html' } });
  assert.equal(wrongMethod.headers.get('allow'), 'DELETE, GET, POST');
  assert.equal(await (await status(server, '/client/route', 200, { headers: { accept: 'text/html' } })).text(), '<h1>Home</h1>');
  await status(server, '/missing.js', 404, { headers: { accept: 'text/html' } });
  await status(server, '/client/route', 404);
  await status(server, '/rpc-other', 404);
  assert.ok(observed.includes('static:200')); assert.ok(observed.includes('rpc:200')); assert.ok(observed.includes('mcp:200')); assert.ok(observed.includes('spa:200'));
});

test('live plugin registration, collision validation, rollback, shutdown and independent listeners', async t => {
  const lifecycle: string[] = [];
  const p = { ...textEndpoint('/x', 'one', 'first'), start() { lifecycle.push('start'); }, close() { lifecycle.push('close'); } };
  const server = createServer({ port: 0, plugins: [p] });
  assert.equal(server.state, 'idle'); assert.equal(server.port, undefined); assert.equal(server.url, undefined);
  await Promise.all([server.start(), server.start()]); t.after(() => server.stop());
  const port = server.port;
  assert.equal(server.state, 'running');
  assert.equal(await (await status(server, '/x', 200)).text(), 'one');
  const second = await run(t, { plugins: [textEndpoint('/x', 'two', 'first')] });
  assert.equal(await (await status(second, '/x', 200)).text(), 'two');
  await assert.rejects(server.addPlugin(textEndpoint('/x', 'collision', 'second')), /collision/);
  await assert.rejects(server.addPlugin(textEndpoint('/y', 'collision', 'first')), /Duplicate/);
  const failed = { ...textEndpoint('/y', 'no'), start() { throw new Error('start failure'); }, close() { lifecycle.push('rollback'); } };
  await assert.rejects(server.addPlugin(failed), /start failure/);
  await status(server, '/y', 404);
  await server.addPlugin(textEndpoint('/y', 'yes'));
  assert.equal(server.port, port); assert.deepEqual(server.plugins, ['first', '/y']);
  assert.equal(await (await status(server, '/y', 200)).text(), 'yes');
  assert.equal(await server.removePlugin('first'), true);
  assert.equal(await server.removePlugin('first'), false);
  await status(server, '/x', 404);
  await Promise.all([server.stop(), server.stop()]);
  assert.equal(server.state, 'stopped'); assert.deepEqual(lifecycle, ['start', 'rollback', 'close']);
  await assert.rejects(server.start(), /restart/);
  await assert.rejects(server.addPlugin(textEndpoint('/z', 'no')), /closed/);
  assert.equal(await (await status(second, '/x', 200)).text(), 'two');
});

test('streaming responses drain on removal and cancel on timeout or client disconnect', async t => {
  let cancelled = 0;
  let closed = 0;
  let finish!: () => void;
  const stream: ServePlugin = {
    name: 'stream', matches: r => new URL(r.url).pathname === '/stream',
    fetch: () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode('first\n')); finish = () => c.close(); }, cancel() { cancelled++; } }), { headers: { 'Content-Type': 'text/event-stream' } }),
    close: () => { closed++; },
  };
  const server = await run(t, { plugins: [stream], shutdownTimeoutMs: 250 });
  const first = await status(server, '/stream', 200); const reader = first.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first\n');
  const removal = server.removePlugin('stream');
  await delay(20); await status(server, '/stream', 404); assert.equal(closed, 0);
  finish(); assert.equal((await reader.read()).done, true); await removal; assert.equal(closed, 1);
  await server.addPlugin(stream);
  const second = await status(server, '/stream', 200); const reader2 = second.body!.getReader(); await reader2.read();
  await server.removePlugin('stream'); await assert.rejects(reader2.read()); assert.equal(cancelled, 1); assert.equal(closed, 2);
  await server.addPlugin(stream);
  const controller = new AbortController(); const third = await status(server, '/stream', 200, { signal: controller.signal });
  await third.body!.getReader().read(); controller.abort();
  for (let i = 0; i < 50 && cancelled < 2; i++) await delay(10);
  assert.equal(cancelled, 2);
});

test('CORS, cookies, streamed body bounds, opaque errors and observer isolation', async t => {
  const server = await run(t, { maxBodyBytes: 8, cors: { origins: ['https://app.example'], credentials: true }, onRequest() { throw Error('observer'); }, onDiagnostic() { throw Error('observer'); }, plugins: [endpointPlugin('echo', { async fetch(request) {
    if (request.method === 'POST') return new Response(await request.text());
    if (new URL(request.url).pathname === '/error') throw Error('sensitive internal details');
    const headers = new Headers(); headers.append('Set-Cookie', 'a=1; Path=/'); headers.append('Set-Cookie', 'b=2; Path=/');
    return new Response('cookies', { headers });
  } }, [{ path: '/echo', methods: ['GET', 'POST'] }, { path: '/error' }])] });
  const origin = 'https://app.example';
  const pre = await status(server, '/echo', 204, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), origin);
  assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
  await status(server, '/echo', 403, { method: 'OPTIONS', headers: { origin: 'https://other.example', 'access-control-request-method': 'POST' } });
  await status(server, '/echo', 403, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PATCH' } });
  await status(server, '/echo', 403, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-denied' } });
  const res = await status(server, '/echo', 200, { headers: { origin } });
  assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  assert.equal((await status(server, '/echo', 200, { headers: { origin: 'https://other.example' } })).headers.get('access-control-allow-origin'), null);
  assert.equal(await (await status(server, '/echo', 200, { method: 'POST', body: '12345678' })).text(), '12345678');
  await status(server, '/echo', 413, { method: 'POST', body: '123456789' });
  // Real chunked HTTP, not Fetch's synthesized Content-Length.
  const chunked = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(new URL('/echo', server.url!), { method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.write('1234'); req.end('56789');
  });
  assert.equal(chunked, 413);
  assert.equal(await (await status(server, '/error', 500)).text(), 'Internal Server Error');
});

test('invalid configuration, route declarations, startup and close failures', async t => {
  for (const options of [{ port: -1 }, { idleTimeout: 256 }, { maxBodyBytes: 0 }, { shutdownTimeoutMs: -1 }, { spaFallback: true }, { publicDir: '' }, { cacheControl: '\nX' }, { cors: { origins: ['*'], credentials: true } }, { cors: { origins: ['https://app.example/path'] } }, { cors: { origins: [], maxAge: -1 } }] as ServeOptions[]) assert.throws(() => createServer(options));
  assert.throws(() => createServer({ plugins: [{ ...textEndpoint('/x', ''), name: '' }] }));
  assert.throws(() => createServer({ plugins: [textEndpoint('x', '')] }));
  assert.throws(() => createServer({ plugins: [endpointPlugin('bad', { fetch: () => new Response() }, [{ path: '/x', methods: ['bad'] }])] }));
  const a = endpointPlugin('a', { fetch: () => new Response() }, [{ path: '/x', prefix: true }]);
  assert.throws(() => createServer({ plugins: [a, textEndpoint('/x/y', '')] }), /collision/);
  const { root, parent } = await fixture(t);
  await assert.rejects(createServer({ port: 0, publicDir: join(parent, 'missing') }).start());
  await assert.rejects(createServer({ port: 0, publicDir: join(root, 'movie.mp4') }).start(), /directory/);
  await assert.rejects(createServer({ port: 0, publicDir: root, spaFallback: 'missing.html' }).start(), /fallback/);
  let closed = 0;
  const failing = { ...textEndpoint('/fail', ''), start() { throw new Error('failure'); }, close() { closed++; } };
  const failed = createServer({ port: 0, plugins: [failing] });
  await assert.rejects(failed.start(), /failure/); assert.equal(closed, 1); assert.equal(failed.state, 'stopped');
  const closeFailure = createServer({ plugins: [{ ...textEndpoint('/fail', ''), close() { throw Error('close failure'); } }] });
  await assert.rejects(closeFailure.stop(), /shutdown failed/); assert.equal(closeFailure.state, 'stopped');
  const owner = await run(t);
  const collision = createServer({ port: owner.port });
  await assert.rejects(collision.start()); assert.equal(collision.state, 'stopped');
  if (!('Bun' in globalThis)) await assert.rejects(createServer({ port: 0, runtime: 'bun' }).start(), /unavailable/);
});

test('undeclared runtime collisions fail closed; malformed targets are rejected on Node', async t => {
  const diag: string[] = [];
  const p = (name: string): ServePlugin => ({ name, matches: () => true, fetch: () => new Response(name) });
  const server = await run(t, { plugins: [p('a'), p('b')], onDiagnostic: e => diag.push(e.code) });
  await status(server, '/anything', 500); assert.deepEqual(diag, ['plugin-collision']);
  if (server.runtime === 'node') {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port!, '127.0.0.1'); let output = '';
      socket.on('connect', () => socket.write('GET http://example.org/x HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      socket.on('data', chunk => { output += chunk.toString(); }); socket.on('end', () => resolve(output)); socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
  }
  const broken = await run(t, { plugins: [{ name: 'broken', matches: () => true, fetch: () => undefined as unknown as Response }] });
  await status(broken, '/', 500);
});

test('legacy RPC call guard, compressed size limits and untouched upload bytes', async t => {
  let calls = 0;
  const rpc = rpcPlugin({ async fetch(request) { calls++; return new Response(await request.text()); } }, { maxCallBytes: 12 });
  const server = await run(t, { plugins: [rpc] });
  const headers = { 'content-type': 'application/json' };
  assert.equal(await (await status(server, '/rpc', 200, { method: 'POST', headers, body: '{"ok":true}' })).text(), '{"ok":true}');
  await status(server, '/rpc', 415, { method: 'POST', body: '{"ok":true}' });
  await status(server, '/rpc', 415, { method: 'POST', headers: { ...headers, 'content-encoding': 'br' }, body: 'x' });
  await status(server, '/rpc', 413, { method: 'POST', headers, body: 'x'.repeat(13) });
  const compressed = new Uint8Array(gzipSync('{"ok":true}'));
  assert.equal(await (await status(server, '/rpc', 200, { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: compressed })).text(), '{"ok":true}');
  await status(server, '/rpc', 413, { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: new Uint8Array(gzipSync('x'.repeat(10000))) });
  await status(server, '/rpc', 400, { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: 'not gzip' });
  assert.equal(calls, 2);
  assert.equal(await (await status(server, '/rpc/upload', 200, { method: 'POST', body: 'x'.repeat(100) })).text(), 'x'.repeat(100));
  await status(server, '/rpc/upload/progress', 404);
  await status(server, '/rpc/upload/progress/a/b', 404);
  assert.throws(() => rpcPlugin({ fetch: () => new Response() }, { maxCallBytes: 0 }));
});

test('large sparse media supports precise bounded seeking without whole-file reads', async t => {
  const { root } = await fixture(t);
  const file = await open(join(root, 'large.mp4'), 'w');
  const size = 128 * 1024 * 1024;
  await file.truncate(size); await file.write(Buffer.from('last'), 0, 4, size - 4); await file.close();
  const server = await run(t, { publicDir: root });
  const res = await status(server, '/large.mp4', 206, { headers: { range: 'bytes=-4' } });
  assert.equal(res.headers.get('content-range'), `bytes ${size - 4}-${size - 1}/${size}`);
  assert.equal(await res.text(), 'last');
});

test('listener shutdown forces an open response to cancel after its grace period', async t => {
  let cancelled = false;
  const server = await run(t, { shutdownTimeoutMs: 30, plugins: [textEndpoint('/ok', 'ok'), {
    name: 'endless', matches: r => new URL(r.url).pathname === '/endless', fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode('start')); }, cancel() { cancelled = true; } })),
  }] });
  const response = await status(server, '/endless', 200);
  const reader = response.body!.getReader(); await reader.read();
  await server.stop();
  assert.equal(server.state, 'stopped'); await assert.rejects(reader.read());
  assert.equal(cancelled, true);
});

test('TLS listener serves an actual certificate-validated HTTPS request', async t => {
  const { root, parent } = await fixture(t);
  const key = join(parent, 'key.pem'); const cert = join(parent, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const certificate = await readFile(cert, 'utf8');
  const server = await run(t, { publicDir: root, tls: { key: await readFile(key, 'utf8'), cert: certificate } });
  assert.equal(server.url!.protocol, 'https:');
  const result = await new Promise<string>((resolve, reject) => {
    const req = httpsRequest(server.url!, { ca: certificate }, res => {
      assert.equal(res.statusCode, 200); const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(Buffer.concat(chunks).toString())); res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(result, '<h1>Home</h1>');
});
