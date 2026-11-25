import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { createServer, acceptWebSocket, type ServeOptions, type ServePlugin, type ServeServer, type ServeWebSocket, type WebSocketAccept } from 'defuss-serve';

// RFC 6455 section 1.3: the key dGhlIHNhbXBsZSBub25jZQ== is accepted as s3pPLMBiTxaQ9kYGzzhZRbK+xOo=.
const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
async function until(predicate: () => boolean) { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); } assert.fail('Condition did not settle'); }
async function server(t: { after(fn: () => unknown): void }, options: ServeOptions = {}) {
  const s = createServer({ port: 0, shutdownTimeoutMs: 5000, ...options }); await s.start(); t.after(() => s.stop()); return s;
}
const drained = (s: ServeServer) => s.stats.activeRequests === 0 && s.stats.activeStreams === 0 && s.stats.activeHandlers === 0;
const socketPlugin = (accept: (request: Request) => WebSocketAccept, extra: Partial<ServePlugin> = {}): ServePlugin =>
  ({ name: 'ws', routes: [{ path: '/ws', methods: ['GET'] }], fetch: request => acceptWebSocket(request, accept(request)), ...extra });
const url = (s: ServeServer, path = '/ws') => `ws://127.0.0.1:${s.port}${path}`;
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('WebSocket failed')), { once: true }); });
}
function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise(resolve => socket.addEventListener('message', e => resolve(e.data), { once: true }));
}
function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => socket.addEventListener('close', e => resolve({ code: e.code, reason: e.reason }), { once: true }));
}

interface Frame { fin: boolean; opcode: number; payload: Buffer }
/** A client of RFC 6455 over a raw socket: the handshake, masked frames out (section 5.3), the server's frames in. */
class RawClient {
  status = ''; headers = new Map<string, string>();
  private buffer = Buffer.alloc(0); private waiting?: () => void; ended = false;
  readonly socket: Socket;
  private constructor(socket: Socket) { this.socket = socket; }
  static open(port: number, lines: string[], allowHalfOpen = false): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const socket = connect({ port, host: '127.0.0.1', allowHalfOpen }); const client = new RawClient(socket);
      socket.setTimeout(5000, () => socket.destroy(new Error('Raw WebSocket timeout')));
      socket.on('connect', () => socket.write([...lines, '', ''].join('\r\n')));
      socket.on('error', reject);
      socket.on('close', () => { client.ended = true; client.waiting?.(); });
      socket.on('data', chunk => {
        client.buffer = Buffer.concat([client.buffer, chunk]);
        if (!client.status) {
          const end = client.buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const [status, ...fields] = client.buffer.subarray(0, end).toString('latin1').split('\r\n');
          client.status = status!;
          for (const field of fields) { const colon = field.indexOf(':'); client.headers.set(field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim()); }
          client.buffer = client.buffer.subarray(end + 4); resolve(client);
        }
        client.waiting?.();
      });
      socket.on('close', () => { if (!client.status) resolve(client); });
    });
  }
  static handshake(port: number, extra: string[] = [], path = '/ws', allowHalfOpen = false): Promise<RawClient> {
    return RawClient.open(port, [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${KEY}`, ...extra], allowHalfOpen);
  }
  send(opcode: number, payload: Buffer | string, { fin = true, mask = true } = {}): void {
    const data = typeof payload === 'string' ? Buffer.from(payload) : payload;
    const length = data.length < 126 ? [data.length] : data.length < 65536 ? [126, data.length >> 8, data.length & 255]
      : [127, 0, 0, 0, 0, (data.length >>> 24) & 255, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255];
    this.socket.write(RawClient.frame(opcode, data, fin, mask, length));
  }
  static frame(opcode: number, data: Buffer, fin: boolean, mask: boolean, length: number[]): Buffer {
    const key = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const body = mask ? Buffer.from(data.map((byte, i) => byte ^ key[i % 4]!)) : data;
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | length[0]!, ...length.slice(1)]), mask ? key : Buffer.alloc(0), body]);
  }
  /** One masked binary frame of data written in pieces, so the server reads its header and payload across chunks. */
  async sendInPieces(data: Buffer): Promise<void> {
    const frame = RawClient.frame(0x2, data, true, true, [127, 0, 0, 0, 0, (data.length >>> 24) & 255, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]);
    for (const [start, end] of [[0, 5], [5, 9000], [9000, frame.length]]) { this.socket.write(frame.subarray(start, end)); await delay(30); }
  }
  /** The server's next frame, or undefined once the connection ended without one. */
  async next(): Promise<Frame | undefined> {
    for (;;) {
      if (this.buffer.length >= 2) {
        const b1 = this.buffer[1]! & 0x7f; const offset = b1 === 126 ? 4 : b1 === 127 ? 10 : 2;
        const length = b1 === 126 ? this.buffer.readUInt16BE(2) : b1 === 127 ? Number(this.buffer.readBigUInt64BE(2)) : b1;
        if (this.buffer.length >= offset + length) {
          assert.equal(this.buffer[1]! & 0x80, 0, 'a server frame is never masked (RFC 6455 5.1)');
          const frame = { fin: !!(this.buffer[0]! & 0x80), opcode: this.buffer[0]! & 0x0f, payload: this.buffer.subarray(offset, offset + length) };
          this.buffer = this.buffer.subarray(offset + length); return frame;
        }
      }
      if (this.ended) return undefined;
      await new Promise<void>(resolve => { this.waiting = resolve; });
    }
  }
  /** Reads until the connection ends: the close code the server sent first, if it sent a close frame. */
  async closeCode(): Promise<number | undefined> {
    for (;;) {
      const frame = await this.next();
      if (!frame) return undefined;
      if (frame.opcode === 0x8) { const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005; this.socket.end(); await until(() => this.ended); return code; }
    }
  }
}

test('a plugin accepts a WebSocket: text and binary echo, a chosen subprotocol, its headers and the host headers on the 101, both close directions', async t => {
  const closes: [number, string][] = []; let peer: ServeWebSocket | undefined; const events: string[] = [];
  const s = await server(t, { responseHeaders: { 'X-Policy': 'host' }, onLifecycle: e => { if (e.handler === 'ws') events.push(`${e.phase}:${e.status ?? ''}:${e.phase === 'complete' ? e.bytes : ''}`); }, plugins: [socketPlugin(request => ({
    protocol: (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(p => p.trim()).includes('chat') ? 'chat' : undefined,
    headers: { 'X-Session': 'one' },
    open(socket) { peer = socket; socket.send('hello'); },
    message(socket, data) { if (data === 'close me') socket.close(4001, 'asked'); else socket.send(data); },
    close(_socket, code, reason) { closes.push([code, reason]); },
  }))] });
  const client = new WebSocket(url(s), ['other', 'chat']); client.binaryType = 'arraybuffer';
  const greeting = nextMessage(client); await opened(client);
  assert.equal(client.protocol, 'chat'); assert.equal(await greeting, 'hello');
  assert.equal(peer?.protocol, 'chat'); assert.match(peer?.remoteAddress ?? '', /127\.0\.0\.1/);
  let reply = nextMessage(client); client.send('echo'); assert.equal(await reply, 'echo');
  reply = nextMessage(client); client.send(new Uint8Array([1, 2, 3])); assert.deepEqual([...new Uint8Array(await reply as ArrayBuffer)], [1, 2, 3]);
  assert.equal(s.stats.activeStreams, 1);
  const ended = closed(client); client.send('close me');
  assert.deepEqual(await ended, { code: 4001, reason: 'asked' });
  await until(() => closes.length === 1); assert.deepEqual(closes[0], [4001, 'asked']);
  // docs/API.md: 101 at the handshake; at the end the phase of a closing handshake and the payload bytes sent ('hello', 'echo', 3 bytes)
  await until(() => events.includes('complete:101:12')); assert.equal(events[0], 'headers:101:');
  const second = new WebSocket(url(s)); await opened(second);
  assert.equal(second.protocol, '');
  second.close(1000, 'done'); await until(() => closes.length === 2); assert.deepEqual(closes[1], [1000, 'done']);
  await until(() => drained(s));
  // The handshake itself (RFC 6455 4.2.2): the accept value, no subprotocol the server did not choose, the plugin's and the host's headers.
  const raw = await RawClient.handshake(s.port!, ['Sec-WebSocket-Protocol: a, b']);
  assert.match(raw.status, /^HTTP\/1\.1 101 /);
  assert.equal(raw.headers.get('sec-websocket-accept'), ACCEPT);
  assert.equal(raw.headers.get('sec-websocket-protocol'), undefined);
  assert.equal(raw.headers.get('x-session'), 'one'); assert.equal(raw.headers.get('x-policy'), 'host');
  assert.equal((await raw.next())?.payload.toString(), 'hello');
  raw.send(0x8, Buffer.from([0x03, 0xe8])); assert.equal(await raw.closeCode(), 1000);
  await until(() => drained(s));
});

test('requests that are no WebSocket handshake are answered over HTTP, the host and the plugin refuse before a socket opens', async t => {
  let opens = 0;
  const s = await server(t, { plugins: [{ name: 'ws', routes: [{ path: '/ws', methods: ['GET'] }, { path: '/unoffered', methods: ['GET'] }], fetch: request => {
    if (request.headers.get('origin') === 'https://elsewhere.example') return new Response('Forbidden', { status: 403 });
    const path = new URL(request.url).pathname;
    return acceptWebSocket(request, { protocol: path === '/unoffered' ? 'never' : undefined, open() { opens++; } });
  } }] });
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/ws`)).status, 400);
  const version = await RawClient.open(s.port!, ['GET /ws HTTP/1.1', `Host: 127.0.0.1:${s.port}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 8', `Sec-WebSocket-Key: ${KEY}`]);
  // RFC 6455 4.4: a version the server does not speak is answered with the versions it does.
  assert.match(version.status, / 426 /); assert.equal(version.headers.get('sec-websocket-version'), '13');
  const key = await RawClient.open(s.port!, ['GET /ws HTTP/1.1', `Host: 127.0.0.1:${s.port}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: c2hvcnQ=']);
  assert.match(key.status, / 400 /);
  assert.match((await RawClient.handshake(s.port!, ['Origin: https://elsewhere.example'])).status, / 403 /);
  const host = await RawClient.open(s.port!, ['GET /ws HTTP/1.1', 'Host: rebound.example', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${KEY}`]);
  assert.match(host.status, / 403 /);
  // A subprotocol the client did not offer is the plugin's error (RFC 6455 4.2.2): no handshake.
  assert.match((await RawClient.handshake(s.port!, ['Sec-WebSocket-Protocol: chat'], '/unoffered')).status, / 500 /);
  assert.match((await RawClient.handshake(s.port!, [], '/missing')).status, / 404 /);
  assert.equal(opens, 0); await until(() => drained(s));
});

test('a request with another Upgrade, such as the h2c POST of curl --http2, is answered with its whole body', async t => {
  const s = await server(t, { plugins: [{ name: 'api', routes: [{ path: '/api', methods: ['POST'] }], fetch: async request => new Response(`${request.method} ${await request.text()}`) }] });
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = connect({ port: s.port!, host: '127.0.0.1' }); let data = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Raw HTTP timeout')));
    socket.on('data', chunk => { data += chunk; }); socket.on('close', () => resolve(data)); socket.on('error', reject);
    // Part of the body follows the head later, so the Node listener must read it from the socket, not only from `head`.
    socket.on('connect', () => {
      socket.write(['POST /api HTTP/1.1', `Host: 127.0.0.1:${s.port}`, 'Connection: Upgrade, HTTP2-Settings, close', 'Upgrade: h2c', 'HTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA', 'Content-Length: 11', '', 'hello'].join('\r\n'));
      setTimeout(() => socket.write(' world'), 50);
    });
  });
  assert.match(reply, /^HTTP\/1\.1 200 /); assert.ok(reply.includes('POST hello world'), reply);
  await until(() => drained(s));
});

test('the frames of RFC 6455: a fragmented message with a ping between its fragments, binary data and the closing handshake', async t => {
  const s = await server(t, { plugins: [socketPlugin(() => ({ message(socket, data) { socket.send(data); } }))] });
  const client = await RawClient.handshake(s.port!);
  assert.match(client.status, / 101 /);
  client.send(0x1, 'hel', { fin: false });
  client.send(0x9, 'are you there');                       // a control frame may come between fragments (5.4)
  client.send(0x0, 'lo');
  const pong = await client.next();
  assert.deepEqual([pong?.opcode, pong?.payload.toString()], [0xA, 'are you there']);   // 5.5.3: the same payload
  const text = await client.next();
  assert.deepEqual([text?.fin, text?.opcode, text?.payload.toString()], [true, 0x1, 'hello']);
  client.send(0x2, Buffer.from([0, 255, 7]));
  const binary = await client.next();
  assert.deepEqual([binary?.opcode, [...binary!.payload]], [0x2, [0, 255, 7]]);
  const long = 'x'.repeat(300);                              // a 16-bit payload length (5.2)
  client.send(0x1, long); assert.equal((await client.next())?.payload.toString(), long);
  client.send(0x8, Buffer.concat([Buffer.from([0x0f, 0xa0]), Buffer.from('bye')]));   // 4000 "bye"
  assert.equal(await client.closeCode(), 4000);              // 5.5.1: the close is answered with the code it got
  await until(() => drained(s));
});

test('a frame the protocol forbids fails the connection', async t => {
  const s = await server(t, { maxWebSocketMessageBytes: 1024, plugins: [socketPlugin(() => ({ message(socket, data) { socket.send(data); } }))] });
  const cases: [string, (client: RawClient) => void, number][] = [
    ['an unmasked client frame (5.1)', client => client.send(0x1, 'plain', { mask: false }), 1002],
    ['a message over maxWebSocketMessageBytes (7.4.1, 1009)', client => client.send(0x2, Buffer.alloc(2000)), 1009],
    ['text that is no UTF-8 (8.1)', client => client.send(0x1, Buffer.from([0xc3, 0x28])), 1007],
    ['a reserved opcode (5.2)', client => client.send(0x3, 'x'), 1002],
    ['a continuation without a message (5.4)', client => client.send(0x0, 'x'), 1002],
    ['many empty fragments that add up to more than the limit with their next fragment', client => { client.send(0x2, '', { fin: false }); for (let i = 0; i < 50; i++) client.send(0x0, '', { fin: false }); client.send(0x0, Buffer.alloc(2000)); }, 1009],
  ];
  for (const [name, act, code] of cases) {
    const client = await RawClient.handshake(s.port!);
    assert.match(client.status, / 101 /, name);
    act(client);
    const sent = await client.closeCode();
    // The server must close the connection; a close frame it sends first names the reason.
    assert.ok(sent === undefined || sent === code, `${name}: ${sent}`);
    assert.ok(client.ended, name);
  }
  await until(() => drained(s));
});

test('removing the plugin and stopping the server close open WebSockets with 1001 at once and release their leases', async t => {
  let plugins = 0; const codes: number[] = [];
  const plugin = socketPlugin(() => ({ close(_socket, code) { codes.push(code); } }), { close() { plugins++; } });
  const s = await server(t, { plugins: [plugin] });
  const client = new WebSocket(url(s)); await opened(client);
  assert.equal(s.stats.activeStreams, 1); assert.equal(s.stats.activeRequests, 1);
  const ended = closed(client); const started = performance.now();
  assert.equal(await s.removePlugin('ws'), true);
  assert.equal((await ended).code, 1001);
  assert.ok(performance.now() - started < 2000, 'removal does not wait for the drain deadline');
  assert.equal(plugins, 1); assert.deepEqual(codes, [1001]); await until(() => drained(s));
  const other = createServer({ port: 0, shutdownTimeoutMs: 5000, plugins: [socketPlugin(() => ({}))] }); await other.start();
  const second = new WebSocket(url(other)); await opened(second);
  const stopping = closed(second); const stopped = performance.now();
  await other.stop();
  assert.equal((await stopping).code, 1001); assert.ok(performance.now() - stopped < 2000);
});

test('a handler that throws closes its socket with 1011 and reports a diagnostic; the stream budget admits WebSockets', async t => {
  const diagnostics: string[] = [];
  const s = await server(t, { maxConcurrentStreams: 1, onDiagnostic: d => diagnostics.push(d.code), plugins: [socketPlugin(() => ({ message() { throw new Error('handler bug'); } }))] });
  const client = new WebSocket(url(s)); await opened(client);
  const refused = await RawClient.handshake(s.port!);
  assert.match(refused.status, / 503 /);                      // the one stream slot is the open socket's
  const ended = closed(client); client.send('boom');
  assert.equal((await ended).code, 1011);
  assert.ok(diagnostics.includes('request-error')); await until(() => drained(s));
});

test('WebSocket options and arguments are checked', async t => {
  assert.throws(() => createServer({ maxWebSocketMessageBytes: 0 }), RangeError);
  assert.throws(() => createServer({ maxWebSocketMessageBytes: 1.5 }), RangeError);
  const errors: unknown[] = [];
  const s = await server(t, { plugins: [{ name: 'ws', routes: [{ path: '/ws' }, { path: '/framing' }], fetch: request => new URL(request.url).pathname === '/framing'
    ? acceptWebSocket(request, { headers: { Connection: 'close' } })
    : acceptWebSocket(request, { open(socket) {
      for (const [code, reason] of [[1005, ''], [2999, ''], [1000, 'x'.repeat(124)]] as const) { try { socket.close(code, reason); } catch (error) { errors.push(error); } }
      socket.close();
    } }) }] });
  assert.match((await RawClient.handshake(s.port!, [], '/framing')).status, / 500 /);   // the listener owns the handshake's fields
  const client = new WebSocket(url(s)); await opened(client);
  assert.equal((await closed(client)).code, 1000);
  assert.equal(errors.length, 3); assert.ok(errors.every(error => error instanceof RangeError));
  await until(() => drained(s));
});

test('an acceptance from the CommonJS copy opens a socket on a server of the ESM copy', async t => {
  const cjs = createRequire(import.meta.url)('defuss-serve') as typeof import('defuss-serve');
  const s = await server(t, { plugins: [{ name: 'ws', routes: [{ path: '/ws' }], fetch: request => cjs.acceptWebSocket(request, { open(socket) { socket.send('from cjs'); } }) }] });
  const client = new WebSocket(url(s)); const first = nextMessage(client); await opened(client);
  assert.equal(await first, 'from cjs'); client.close(); await until(() => drained(s));
});

test('a message of 100 KiB written in pieces comes back whole, with the 64-bit payload length of RFC 6455 5.2', async t => {
  const buffered: number[] = [];
  const s = await server(t, { plugins: [socketPlugin(() => ({ message(socket, data) { socket.send(data); buffered.push(socket.bufferedAmount); } }))] });
  const client = await RawClient.handshake(s.port!);
  const data = Buffer.from(Array.from({ length: 100 * 1024 }, (_, i) => i % 251));
  await client.sendInPieces(data);
  const echo = await client.next();
  assert.equal(echo?.opcode, 0x2); assert.ok(echo?.payload.equals(data));
  assert.equal(buffered.length, 1); assert.ok(Number.isInteger(buffered[0]) && buffered[0]! >= 0);
  client.send(0x8, Buffer.from([0x03, 0xe8])); assert.equal(await client.closeCode(), 1000);
  await until(() => drained(s));
});

test('a peer that sends its close frame but keeps its side of TCP open is disconnected, and its lease released', async t => {
  // RFC 6455 7.1.1: after the closing handshake the server closes the TCP connection first; a peer that never closes its
  // half must not hold the socket and its plugin lease.
  const codes: number[] = [];
  const s = await server(t, { plugins: [socketPlugin(() => ({ close(_socket, code) { codes.push(code); } }))] });
  const client = await RawClient.handshake(s.port!, [], '/ws', true);
  client.send(0x8, Buffer.from([0x03, 0xe8]));
  assert.equal((await client.next())?.opcode, 0x8);
  await until(() => codes.length === 1 && drained(s));     // within the 3 s of until, the client still holding its half
  assert.deepEqual(codes, [1000]);
  client.socket.destroy();
});
