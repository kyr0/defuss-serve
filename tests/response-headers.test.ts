import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { createServer, type ServeOptions, type ServeServer } from 'defuss-serve';

const policy = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store', 'X-Served-By': 'host' };
async function served(t: { after(fn: () => unknown): void }, options: ServeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'serve-headers-')); t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = join(root, 'public'); await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<h1>home</h1>'); await writeFile(join(publicDir, 'data.bin'), '0123456789');
  // The plugin's narrower body limit answers through the dispatcher; a body over the global maxBodyBytes is refused by
  // Bun's own listener before dispatch, a transport refusal without the host's fields (docs/API.md).
  const s = createServer({ port: 0, publicDir, responseHeaders: policy, plugins: [
    { name: 'api', maxBodyBytes: 8, routes: [{ path: '/api', methods: ['GET', 'POST'] }, { path: '/fail', methods: ['GET'] }], fetch: async request => {
      if (new URL(request.url).pathname === '/fail') throw new Error('plugin bug');
      if (request.method === 'POST') await request.text();
      return new Response('api', { headers: { 'Cache-Control': 'public, max-age=60', 'X-Plugin': 'kept' } });
    } },
  ], ...options });
  await s.start(); t.after(() => s.stop()); return s;
}
function hasPolicy(headers: Headers, label: string) {
  for (const [name, value] of Object.entries(policy)) assert.equal(headers.get(name), value, `${label}: ${name}`);
}
/** One raw HTTP/1.1 request, for a target or a Host header fetch() would not send: its status line and headers. */
function raw(s: ServeServer, head: string): Promise<{ status: string; headers: Headers }> {
  return new Promise((resolve, reject) => {
    const socket = connect(s.port!, '127.0.0.1'); let text = '';
    socket.on('connect', () => socket.write(head));
    socket.on('data', chunk => { text += chunk.toString('latin1'); const end = text.indexOf('\r\n\r\n'); if (end >= 0) { socket.destroy(); const [status, ...lines] = text.slice(0, end).split('\r\n'); const headers = new Headers(); for (const line of lines) { const colon = line.indexOf(':'); headers.append(line.slice(0, colon), line.slice(colon + 1).trim()); } resolve({ status: status!, headers }); } });
    socket.on('error', reject);
  });
}

test('responseHeaders reach every response: static files, ranges, conditionals, plugin answers, refusals and errors', async t => {
  const s = await served(t);
  const at = (path: string, init?: RequestInit) => fetch(new URL(path, s.url!), init);
  const home = await at('/'); assert.equal(await home.text(), '<h1>home</h1>'); hasPolicy(home.headers, 'static');
  const head = await at('/', { method: 'HEAD' }); hasPolicy(head.headers, 'HEAD');
  const part = await at('/data.bin', { headers: { Range: 'bytes=2-4' } }); assert.equal(part.status, 206); assert.equal(await part.text(), '234'); hasPolicy(part.headers, 'range');
  const unsatisfiable = await at('/data.bin', { headers: { Range: 'bytes=20-' } }); assert.equal(unsatisfiable.status, 416); hasPolicy(unsatisfiable.headers, '416');
  const etag = part.headers.get('etag')!;
  const unchanged = await at('/data.bin', { headers: { 'If-None-Match': etag } }); assert.equal(unchanged.status, 304); hasPolicy(unchanged.headers, '304');
  const api = await at('/api'); assert.equal(await api.text(), 'api'); hasPolicy(api.headers, 'plugin');
  assert.equal(api.headers.get('x-plugin'), 'kept');         // the host replaces only the fields it names
  hasPolicy((await at('/missing')).headers, '404');
  const method = await at('/api', { method: 'DELETE' }); assert.equal(method.status, 405); hasPolicy(method.headers, '405');
  const large = await at('/api', { method: 'POST', body: '0123456789' }); assert.equal(large.status, 413); hasPolicy(large.headers, '413');
  const failing = await at('/fail'); assert.equal(failing.status, 500); hasPolicy(failing.headers, '500');
  const host = await raw(s, 'GET / HTTP/1.1\r\nHost: rebound.example\r\n\r\n'); assert.match(host.status, / 403 /); hasPolicy(host.headers, 'Forbidden Host');
  const target = await raw(s, `GET //double HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`); assert.match(target.status, / 400 /); hasPolicy(target.headers, 'bad target');
});

test('responseHeaders reach a native Bun file response', { skip: !process.versions.bun }, async t => {
  const s = await served(t, { nativeStaticFastPath: true, maxConcurrentRequests: 0, maxConcurrentStreams: 0, maxOpenStaticFiles: 0 });
  const response = await fetch(new URL('/data.bin', s.url!)); assert.equal(await response.text(), '0123456789'); hasPolicy(response.headers, 'native');
});

test('responseHeaders that would change framing, the representation or cookies are refused when the server is made', () => {
  for (const name of ['Content-Length', 'Transfer-Encoding', 'Connection', 'Keep-Alive', 'Upgrade', 'TE', 'Trailer', 'Content-Type', 'Content-Encoding', 'Content-Range', 'Set-Cookie', 'Sec-WebSocket-Accept', 'bad name']) {
    assert.throws(() => createServer({ responseHeaders: { [name]: 'x' } }), TypeError, name);
  }
  assert.throws(() => createServer({ responseHeaders: { 'X-Value': 'a\nb' } }), TypeError);
  assert.throws(() => createServer({ responseHeaders: { 'X-Twice': 'a', 'x-twice': 'b' } }), TypeError);
  createServer({ responseHeaders: { 'X-Fine': 'yes' } });
});
