import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import * as zlib from 'node:zlib';
import { createServer, remoteAddress, type ServeOptions } from 'defuss-serve';
import { proxyPlugin, type ProxyPluginOptions } from 'defuss-serve/plugins';

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; bytes: number };
/** A real upstream: records each request and answers by path. */
async function upstream(t: { after(fn: () => unknown): void }, release?: Promise<void>) {
  const seen: Seen[] = [];
  // An object, because a promise resolved with a promise would wait for that one.
  let held!: (h: { closed: Promise<void> }) => void; const hold = new Promise<{ closed: Promise<void> }>(resolve => { held = resolve; });
  const server = createHttpServer((req, res: ServerResponse) => {
    let bytes = 0; req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', async () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, bytes });
      const path = req.url!.split('?')[0];
      if (path === '/base/gzip') { const body = zlib.gzipSync('compressed'); res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.length }); res.end(body); }
      else if (path === '/base/zstd') { const zstd = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync; const body = zstd ? zstd(Buffer.from('zstd')) : Buffer.from('zstd'); res.writeHead(200, { 'content-encoding': 'zstd', 'content-length': body.length }); res.end(body); }
      else if (path === '/base/cookies') { res.setHeader('set-cookie', ['a=1; Path=/auth', 'b=2; Path=/auth']); res.end('cookies'); }
      else if (path === '/base/redirect') { res.writeHead(302, { location: `http://127.0.0.1:${port}/base/next?step=2` }); res.end(); }
      else if (path === '/base/relative') { res.writeHead(303, { location: '/base/done' }); res.end(); }
      else if (path === '/base/away') { res.writeHead(302, { location: 'https://elsewhere.test/x' }); res.end(); }
      else if (path === '/base/empty') { res.writeHead(204); res.end(); }
      else if (path === '/base/hold') { res.writeHead(200); res.write('open'); held({ closed: new Promise(resolve => res.on('close', () => resolve())) }); }
      else if (path === '/base/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('first\n'); await release; res.end('last\n'); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url, bytes })); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { seen, url: `http://127.0.0.1:${port}`, port, hold };
}
async function proxied(t: { after(fn: () => unknown): void }, target: string, options?: ProxyPluginOptions, serve: ServeOptions = {}) {
  const s = createServer({ port: 0, plugins: [proxyPlugin('/auth', target, options)], ...serve });
  await s.start(); t.after(() => s.stop());
  const at = (path: string, init?: RequestInit) => fetch(new URL(path, s.url!), { redirect: 'manual', ...init });
  /** The status line of one raw request, for a target fetch() would normalize before sending. */
  const raw = (target: string, fields = '') => new Promise<string>((resolve, reject) => {
    const socket = connect(s.port!, '127.0.0.1'); let text = '';
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n${fields}Connection: close\r\n\r\n`));
    socket.on('data', chunk => { text += chunk.toString('latin1'); }); socket.on('close', () => resolve(text.split('\r\n')[0]!)); socket.on('error', reject);
  });
  return Object.assign(at, { raw });
}

test('proxyPlugin maps the subtree, keeps the query and leaves sibling paths alone', async t => {
  const up = await upstream(t); const at = await proxied(t, up.url + '/base/');
  assert.deepEqual(await (await at('/auth/login/step?x=1&y=%20')).json(), { path: '/base/login/step?x=1&y=%20', bytes: 0 });
  assert.deepEqual(await (await at('/auth')).json(), { path: '/base', bytes: 0 });
  assert.equal((await at('/authx')).status, 404);
  // Dot segments resolve before routing: one that leaves /auth reaches no proxy, one inside stays in the target's subtree.
  assert.match(await at.raw('/auth/../secret'), / 404 /); assert.match(await at.raw('/auth/%2e%2e/secret'), / 404 /);
  assert.match(await at.raw('/auth/x/../y'), / 200 /); assert.equal(up.seen.at(-1)!.url, '/base/y');
  assert.match(await at.raw('/auth/a%2fb'), / 400 /);                         // the host refuses an encoded slash
});

test('proxyPlugin forwards end-to-end fields, drops hop-by-hop ones and sets forwarding and injected fields', async t => {
  const up = await upstream(t); const at = await proxied(t, up.url + '/base', { headers: { 'X-Service-Key': 'secret' } });
  await at('/auth/me', { headers: { Authorization: 'Bearer user', Cookie: 'sid=1', Origin: 'http://127.0.0.1', 'X-Service-Key': 'forged', 'X-Forwarded-For': '203.0.113.9', 'Accept-Encoding': 'gzip, br' } });
  const h = up.seen.at(-1)!.headers;
  // fetch() refuses to send a Connection field, so a raw request names one.
  assert.match(await at.raw('/auth/raw', 'Connection: x-drop\r\nX-Drop: 1\r\nKeep-Alive: timeout=5\r\nX-Kept: 1\r\n'), / 200 /);
  const r = up.seen.at(-1)!.headers; assert.equal(r['x-drop'], undefined); assert.equal(r['keep-alive'], undefined); assert.equal(r['x-kept'], '1');
  assert.equal(h.host, `127.0.0.1:${up.port}`);
  assert.equal(h.authorization, 'Bearer user'); assert.equal(h.cookie, 'sid=1'); assert.equal(h.origin, 'http://127.0.0.1');
  assert.equal(h['x-service-key'], 'secret');                                  // the configured field replaces the client's
  assert.equal(h['accept-encoding'], 'identity');
  assert.equal(h['x-forwarded-for'], '127.0.0.1');                             // the untrusted client's own field is gone
  assert.match(h['x-forwarded-host'] as string, /^127\.0\.0\.1:\d+$/); assert.equal(h['x-forwarded-proto'], 'http');
});

test('proxyPlugin extends a trusted proxy chain and can omit forwarding fields', async t => {
  const up = await upstream(t);
  const trusted = await proxied(t, up.url + '/base', {}, { trustedProxies: ['127.0.0.1'] });
  await trusted('/auth', { headers: { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'app.example' } });
  let h = up.seen.at(-1)!.headers;
  assert.deepEqual([h['x-forwarded-for'], h['x-forwarded-proto'], h['x-forwarded-host']], ['203.0.113.9, 127.0.0.1', 'https', 'app.example']);
  const bare = await proxied(t, up.url + '/base', { forwarded: false });
  await bare('/auth'); h = up.seen.at(-1)!.headers;
  assert.equal(h['x-forwarded-for'], undefined); assert.equal(h['x-forwarded-host'], undefined);
});

test('proxyPlugin streams request bodies, including empty and large ones', async t => {
  const up = await upstream(t); const at = await proxied(t, up.url + '/base');
  assert.deepEqual(await (await at('/auth/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })).json(), { path: '/base/echo', bytes: 7 });
  assert.deepEqual(await (await at('/auth/item', { method: 'DELETE' })).json(), { path: '/base/item', bytes: 0 });
  const large = new Uint8Array(3 * 1024 * 1024).fill(7);
  assert.deepEqual(await (await at('/auth/upload', { method: 'PUT', body: large })).json(), { path: '/base/upload', bytes: large.length });
});

test('proxyPlugin relays answers: cookies, decoded bodies, redirects in the subtree, empty answers', async t => {
  const up = await upstream(t); const at = await proxied(t, up.url + '/base');
  assert.deepEqual((await at('/auth/cookies')).headers.getSetCookie(), ['a=1; Path=/auth', 'b=2; Path=/auth']);
  const zipped = await at('/auth/gzip');
  assert.equal(zipped.headers.get('content-encoding'), null); assert.equal(await zipped.text(), 'compressed');
  assert.equal((await at('/auth/zstd')).status, 502);                          // fetch decodes zstd on some runtimes only
  const redirect = await at('/auth/redirect'); assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/auth/next?step=2');
  assert.equal((await at('/auth/relative')).headers.get('location'), '/auth/done');
  assert.equal((await at('/auth/away')).headers.get('location'), 'https://elsewhere.test/x');
  const empty = await at('/auth/empty'); assert.equal(empty.status, 204); assert.equal(await empty.text(), '');
  const head = await at('/auth/x', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('proxyPlugin streams an answer before the upstream finishes it', async t => {
  let open!: () => void; const release = new Promise<void>(resolve => { open = resolve; });
  const up = await upstream(t, release); const at = await proxied(t, up.url + '/base');
  const reader = (await at('/auth/stream')).body!.getReader();
  const first = await reader.read(); assert.equal(new TextDecoder().decode(first.value), 'first\n');
  open(); let rest = ''; for (let c = await reader.read(); !c.done; c = await reader.read()) rest += new TextDecoder().decode(c.value);
  assert.equal(rest, 'last\n');
});

test('proxyPlugin cancels the upstream request when the client disconnects', async t => {
  const up = await upstream(t); const at = await proxied(t, up.url + '/base');
  const client = new AbortController(); const answer = await at('/auth/hold', { signal: client.signal });
  const reader = answer.body!.getReader(); await reader.read();
  const { closed } = await up.hold; client.abort(); await reader.read().catch(() => {});
  await closed;                                                               // the upstream saw its connection end
});

test('proxyPlugin answers 502 when the upstream is down and honors its method list', async t => {
  const up = await upstream(t); const down = await proxied(t, 'http://127.0.0.1:9/base');
  assert.equal((await down('/auth/x')).status, 502);
  const only = await proxied(t, up.url, { methods: ['post'] });
  const refused = await only('/auth/x'); assert.equal(refused.status, 405); assert.equal(refused.headers.get('allow'), 'POST');
});

test('proxyPlugin refuses invalid paths, targets and injected fields when it is made', () => {
  for (const path of ['auth', '/auth/', '/a/../b', '/a%2fb', '/a b']) assert.throws(() => proxyPlugin(path, 'http://127.0.0.1:1'), TypeError, path);
  for (const target of ['ftp://127.0.0.1/', 'http://u:p@127.0.0.1/', 'http://127.0.0.1/?q', 'http://127.0.0.1/#h']) assert.throws(() => proxyPlugin('/p', target), TypeError, target);
  for (const field of ['Content-Length', 'Transfer-Encoding', 'Connection']) assert.throws(() => proxyPlugin('/p', 'http://127.0.0.1:1', { headers: { [field]: '1' } }), TypeError, field);
  assert.equal(proxyPlugin('/', 'http://127.0.0.1:1').routes![0]!.path, '/');
});

test('remoteAddress names the socket peer of the request a plugin receives, and nothing a client sends forges it', async t => {
  const s = createServer({ port: 0, plugins: [{ name: 'peer', routes: [{ path: '/peer' }], fetch: request => Response.json({ peer: remoteAddress(request) ?? null, copy: remoteAddress(new Request(request)) ?? null }) }] });
  await s.start(); t.after(() => s.stop());
  assert.deepEqual(await (await fetch(new URL('/peer', s.url!), { headers: { 'X-Forwarded-For': '203.0.113.9' } })).json(), { peer: '127.0.0.1', copy: null });
  assert.equal(remoteAddress(new Request('http://127.0.0.1/')), undefined);
});
