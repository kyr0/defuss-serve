import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { BACKPRESSURE_LIMIT } from '../websocket/session.js';
import type { Session, Transport } from '../websocket/session.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Sec-WebSocket-Accept of a client key (RFC 6455 section 4.2.2). */
export function acceptValue(key: string): string { return createHash('sha1').update(key + GUID).digest('base64'); }
const CLOSE_WAIT_MS = 1000;
const decoder = new TextDecoder('utf-8', { fatal: true });
const empty = Buffer.alloc(0);
// Close codes a peer may send (7.4.1, 7.4.2 and IANA's registry): 1004-1006 and 1015 never appear on the wire.
const wireCode = (code: number) => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
const codeBytes = (code: number, reason = '') => { const payload = Buffer.alloc(2 + Buffer.byteLength(reason)); payload.writeUInt16BE(code, 0); payload.write(reason, 2); return payload; };

/** Write the 101 response for an accepted handshake and run the session's frames on the socket. */
export function openNodeWebSocket(socket: Socket, head: Buffer, session: Session, key: string, protocol: string, fields: Headers, maxMessage: number): void {
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptValue(key)}`];
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  for (const [name, value] of fields) lines.push(`${name}: ${value}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  new NodeWebSocket(socket, session, maxMessage).start(head);
}

/** The server side of RFC 6455's framing: masked client frames in (5.3), unmasked frames out, fragmented messages
 * (5.4), ping and pong (5.5.2-3), the closing handshake (5.5.1, 7.1) and the failures of 7.1.7 with their codes.
 * VERIFIED: tests/websocket.test.ts: fragments with a ping between, split 64-bit frames, each forbidden frame, a half-open peer. */
class NodeWebSocket implements Transport {
  private chunks: Buffer[] = []; private queued = 0;
  private parts: Buffer[] = []; private partBytes = 0; private kind = 0;
  private closeSent = false; private stopped = false; private reported = false;
  private code = 1006; private reason = '';
  private timer?: ReturnType<typeof setTimeout>;
  private readonly socket: Socket; private readonly session: Session; private readonly max: number;
  constructor(socket: Socket, session: Session, max: number) { this.socket = socket; this.session = session; this.max = max; }
  get buffered(): number { return this.socket.writableLength; }
  start(head: Buffer): void {
    const socket = this.socket;
    socket.setTimeout(0); socket.setNoDelay(true);
    socket.on('data', chunk => this.feed(chunk));
    socket.on('end', () => socket.end());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.report());
    this.session.opened(this);
    if (head.length) this.feed(head);
  }
  send(data: string | Uint8Array): void {
    if (this.closeSent) return;
    this.write(typeof data === 'string' ? 0x1 : 0x2, typeof data === 'string' ? Buffer.from(data) : Buffer.from(data));
  }
  close(code: number, reason: string): void {
    if (this.closeSent) return;
    this.code = code; this.reason = reason;
    this.write(0x8, codeBytes(code, reason)); this.closeSent = true;
    this.timer = setTimeout(() => this.socket.destroy(), CLOSE_WAIT_MS); this.timer.unref?.();
  }
  private write(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const length = payload.length;
    let header: Buffer;
    if (length < 126) header = Buffer.from([0x80 | opcode, length]);
    else if (length < 65536) header = Buffer.from([0x80 | opcode, 126, length >> 8, length & 255]);
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeUInt32BE(Math.floor(length / 2 ** 32), 2); header.writeUInt32BE(length >>> 0, 6); }
    this.socket.write(length ? Buffer.concat([header, payload]) : header);
    if (this.socket.writableLength > BACKPRESSURE_LIMIT) this.socket.destroy();
  }
  /** The first n queued bytes, copied only when they span chunks; n is small (a frame header). */
  private peek(n: number): Buffer {
    const first = this.chunks[0]!;
    return first.length >= n ? first.subarray(0, n) : Buffer.concat(this.chunks, Math.min(this.queued, Math.max(n, 14))).subarray(0, n);
  }
  private take(n: number): Buffer {
    const first = this.chunks[0]!;
    this.queued -= n;
    if (first.length >= n) { if (first.length === n) this.chunks.shift(); else this.chunks[0] = first.subarray(n); return first.subarray(0, n); }
    const out = Buffer.allocUnsafe(n);
    for (let at = 0; at < n;) {
      const chunk = this.chunks[0]!; const count = Math.min(chunk.length, n - at);
      chunk.copy(out, at, 0, count); at += count;
      if (count === chunk.length) this.chunks.shift(); else this.chunks[0] = chunk.subarray(count);
    }
    return out;
  }
  private feed(chunk: Buffer): void {
    if (this.stopped) return;
    this.chunks.push(chunk); this.queued += chunk.length;
    while (!this.stopped && this.queued >= 2) {
      const start = this.peek(2);
      const fin = (start[0]! & 0x80) !== 0, opcode = start[0]! & 0x0f;
      if (start[0]! & 0x70 || !(start[1]! & 0x80)) return this.fail(1002);   // no extension was negotiated; a client masks
      let size = start[1]! & 0x7f;
      const headerBytes = 2 + (size === 126 ? 2 : size === 127 ? 8 : 0) + 4;
      if (this.queued < headerBytes) return;
      const header = this.peek(headerBytes);
      if (size === 126) size = header.readUInt16BE(2);
      else if (size === 127) { const high = header.readUInt32BE(2); if (high > 0x1fffff) return this.fail(1009); size = high * 2 ** 32 + header.readUInt32BE(6); }
      if (opcode >= 0x8 ? !fin || size > 125 || opcode > 0xA : opcode > 0x2) return this.fail(1002);
      if (opcode < 0x8) {
        if (opcode === 0 ? !this.kind : this.kind) return this.fail(1002);   // a continuation needs a message, a new one none
        if (this.partBytes + size > this.max) return this.fail(1009);         // before buffering the payload
      }
      if (this.queued < headerBytes + size) return;
      const mask = Buffer.from(header.subarray(headerBytes - 4, headerBytes));
      this.take(headerBytes);
      const payload = size ? this.take(size) : empty;
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]!;
      this.frame(fin, opcode, payload);
    }
  }
  private frame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) return this.closing(payload);
    if (opcode === 0x9) { if (!this.closeSent) this.write(0xA, payload); return; }
    if (opcode === 0xA) return;
    if (opcode) this.kind = opcode;
    if (payload.length) { this.parts.push(payload); this.partBytes += payload.length; }   // empty fragments would grow the list unbounded
    if (!fin) return;
    const data = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.partBytes);   // [] gives an empty message
    const kind = this.kind; this.parts = []; this.partBytes = 0; this.kind = 0;
    if (kind === 0x2) { this.session.received(new Uint8Array(data)); return; }
    let text: string;
    try { text = decoder.decode(data); } catch { return this.fail(1007); }
    this.session.received(text);
  }
  /** The peer's close frame: answered with its code unless this side closed first, then the TCP connection ends. */
  private closing(payload: Buffer): void {
    let code = 1005, reason = '';
    if (payload.length === 1) return this.fail(1002);
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!wireCode(code)) return this.fail(1002);
      try { reason = decoder.decode(payload.subarray(2)); } catch { return this.fail(1007); }
    }
    this.stopped = true;
    if (!this.closeSent) { this.code = code; this.reason = reason; this.write(0x8, code === 1005 ? empty : codeBytes(code)); this.closeSent = true; }
    this.endSoon();
  }
  /** End this side, and drop the socket when the peer keeps its side open: after the closing handshake the server
   * closes the TCP connection (7.1.1), and the session's lease must not wait on a peer that never does. */
  private endSoon(): void {
    this.socket.end();
    this.timer ??= setTimeout(() => this.socket.destroy(), CLOSE_WAIT_MS); this.timer.unref?.();
  }
  /** Fail the connection (7.1.7): a close frame with the reason's code, then the end of the TCP connection. */
  private fail(code: number): void {
    this.stopped = true;
    if (!this.closeSent) { this.code = code; this.reason = ''; this.write(0x8, codeBytes(code)); this.closeSent = true; }
    this.endSoon();
  }
  private report(): void {
    if (this.reported) return;
    this.reported = true;
    if (this.timer) clearTimeout(this.timer);
    this.session.ended(this.code, this.reason);
  }
}
