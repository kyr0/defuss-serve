import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, open, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { createServer as createHttpServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { createServer, type RequestEvent, type ServeOptions, type ServePlugin, type ServeServer } from 'defuss-serve';
import { endpointPlugin } from 'defuss-serve/plugins';
import { parseRange } from '../src/static/range.ts';
import { safeSegments } from '../src/static/resolve.ts';
import { precondition, allowsRange } from '../src/static/cache.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise, resolve}; };
async function until(predicate: () => boolean) { for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(10); } assert.fail('Condition did not settle'); }
async function server(t: {after(fn: () => unknown): void}, options: ServeOptions = {}) { const s = createServer({port:0,...options}); await s.start(); t.after(()=>s.stop()); return s; }
async function fixture(t: {after(fn: () => unknown): void}) { const root = await mkdtemp(join(tmpdir(),'serve-v3-')); t.after(()=>rm(root,{recursive:true,force:true})); const publicDir = join(root,'public'); await mkdir(publicDir); return {root,publicDir}; }
const call = (s: ServeServer, path: string, init?: RequestInit) => fetch(new URL(path,s.url!),init);
const drained = (s: ServeServer) => s.stats.activeRequests === 0 && s.stats.activeStreams === 0 && s.stats.activeHandlers === 0 && s.stats.activeUploads === 0 && s.stats.openStaticFiles === 0;
const route = (name: string, fetch: ServePlugin['fetch'], path = '/' + name, methods = ['GET']): ServePlugin => ({name, routes:[{path,methods}],fetch});
function raw(s: ServeServer, payload: string): Promise<string> {
  return new Promise((resolve,reject)=>{
    const socket = connect(s.port!, '127.0.0.1'); const chunks: Buffer[] = [];
    socket.setTimeout(3000,()=>socket.destroy(new Error('Raw socket timeout')));
    socket.on('connect',()=>socket.write(payload)); socket.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
    socket.on('error',reject); socket.on('close',()=>resolve(Buffer.concat(chunks).toString('latin1')));
  });
}

test('invalid response headers and forbidden framing cancel the body and release every lease', async t=>{
  let cancelled=0; const diagnostics: string[]=[];
  const s=await server(t,{plugins:[route('bad',()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'x-bad':'a\u0001b'}})),route('hop',()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'transfer-encoding':'gzip, chunked'}})),route('length',()=>new Response(null,{headers:{'content-length':'9'}})),route('ok',()=>new Response('ok'))],onDiagnostic:e=>diagnostics.push(e.code)});
  for (const path of ['/bad','/hop','/length']) { const r=await call(s,path);assert.equal(r.status,500);await r.text();await until(()=>drained(s)); }
  assert.equal(cancelled,2);assert.equal(diagnostics.filter(x=>x==='response-framing-error').length,3);
  assert.equal(await(await call(s,'/ok')).text(),'ok');
});

test('hop-by-hop headers from plugins and fetch() proxies are dropped, other transfer codings still fail', async t=>{
  // defuss-mcp and defuss-rpc send Connection: keep-alive on SSE; a fetch() proxy returns immutable headers carrying
  // Connection, Keep-Alive and, for a streamed upstream reply, Transfer-Encoding: chunked.
  const diagnostics: string[]=[]; const sse='data: 1\n\n';
  const upstream=createHttpServer((req,res)=>{ res.setHeader('content-type','text/event-stream'); res.setHeader('x-end','1'); res.setHeader('set-cookie',['a=1','b=2']); if (req.url==='/stream') { res.write(sse.slice(0,4)); res.end(sse.slice(4)); } else res.end(sse); }).listen(0,'127.0.0.1');
  await new Promise(resolve=>upstream.once('listening',resolve)); t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const s=await server(t,{plugins:[
    route('sse',()=>{ const headers=new Headers({'content-type':'text/event-stream',connection:'keep-alive, x-hop, upgrade','keep-alive':'timeout=5','x-hop':'1','x-end':'1',upgrade:'h2c',te:'trailers',trailer:'x-sum','transfer-encoding':'Chunked'}); headers.append('set-cookie','a=1'); headers.append('set-cookie','b=2'); return new Response(sse,{headers}); }),
    route('proxy',()=>fetch(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/`)),
    route('stream',()=>fetch(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/stream`)),
    route('nominated',()=>new Response('x',{headers:{connection:'transfer-encoding','transfer-encoding':'gzip, chunked'}})),
  ],onDiagnostic:e=>diagnostics.push(e.code)});
  for (const path of ['/sse','/proxy','/stream']) {
    const r=await call(s,path); assert.equal(r.status,200,path); assert.equal(await r.text(),sse,path);
    for (const name of ['x-hop','upgrade','te','trailer']) assert.equal(r.headers.get(name),null,`${path} ${name}`); assert.equal(r.headers.get('x-end'),'1',path); assert.deepEqual(r.headers.getSetCookie(),['a=1','b=2'],path);
  }
  const nominated=await call(s,'/nominated'); assert.equal(nominated.status,500); await nominated.text();
  assert.deepEqual(diagnostics,['response-framing-error']); await until(()=>drained(s));
});

test('raw HTTP framing: no overflow bytes, no reused connection after short body, exact framing survives keep-alive', async t=>{
  // Real node:http framing, also exercises the Node adapter when run on Bun.
  const s=await server(t,{runtime:'node',plugins:[route('over',()=>new Response('abcdef',{headers:{'content-length':'2'}})),route('short',()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('a'));},async pull(c){await delay(50);c.close();}}),{headers:{'content-length':'6'}})),route('ok',()=>new Response('OK',{headers:{'content-length':'2'}}))]});
  const get=(path:string,close=false)=>`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n${close?'Connection: close\r\n':''}\r\n`;
  const overflow=await raw(s,get('/over')+get('/ok',true)); assert.match(overflow,/^HTTP\/1\.1 500/);assert.ok(!overflow.includes('abcdef'));assert.equal((overflow.match(/HTTP\/1\.1 /g)??[]).length,1);
  const short=await raw(s,get('/short')+get('/ok',true)); assert.match(short,/^HTTP\/1\.1 200/);assert.equal((short.match(/HTTP\/1\.1 /g)??[]).length,1);assert.ok(short.endsWith('\r\n\r\na'));
  const malformed=await raw(s,`POST /ok HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\na`);assert.match(malformed,/^HTTP\/1\.1 400/);
  const good=await raw(s,get('/ok')+get('/ok',true));assert.equal((good.match(/HTTP\/1\.1 200/g)??[]).length,2);assert.ok(good.endsWith('\r\n\r\nOK'));await until(()=>drained(s));
});

test('exclusive endpoint ownership across wrappers, servers and CJS/ESM', async t=>{
  const endpoint={fetch:()=>new Response('ok'),close(){}};
  const p=endpointPlugin('first',endpoint,[{path:'/x'}]);
  const s=await server(t,{plugins:[p]});
  assert.throws(()=>createServer({plugins:[p]}),/already owned/);
  assert.throws(()=>createServer({plugins:[endpointPlugin('other',endpoint,[{path:'/y'}])]}),/already owned/);
  const cjs=createRequire(import.meta.url)('defuss-serve') as typeof import('defuss-serve');
  assert.throws(()=>cjs.createServer({plugins:[p]}),/already owned/);
  const other=await server(t);await assert.rejects(other.addPlugin(p),/already owned/);
  assert.equal(await(await call(s,'/x')).text(),'ok');await s.removePlugin('first');
  await other.addPlugin(endpointPlugin('second',endpoint,[{path:'/y'}]));assert.equal(await(await call(other,'/y')).text(),'ok');
});

test('matcher-only static shadow policy checks manifest and real request predicates',async t=>{
  const {publicDir}=await fixture(t);await writeFile(join(publicDir,'health'),'static');
  const plugin=():ServePlugin=>({name:'health',matches:r=>new URL(r.url).pathname==='/health',fetch:()=>new Response('api')});
  await assert.rejects(createServer({port:0,publicDir,staticMode:'immutable',staticShadow:'error',plugins:[plugin()]}).start(),/Static\/API shadow/);
  const s=await server(t,{publicDir,staticMode:'immutable',staticShadow:'error'});await assert.rejects(s.addPlugin(plugin()),/shadow/);
  const contextual:ServePlugin={name:'context',matches:r=>r.headers.has('x-api'),fetch:()=>new Response('api')};await s.addPlugin(contextual);
  const conflict=await call(s,'/health',{headers:{'x-api':'1'}});assert.equal(conflict.status,503);await conflict.text();await until(()=>drained(s));
  const live=await server(t,{publicDir,staticShadow:'error',plugins:[plugin()]});assert.equal((await call(live,'/health')).status,503);await until(()=>drained(live));
});

test('build-time SHA-256 manifests yield representation-specific strong validators and If-Range',async t=>{
  const {root,publicDir}=await fixture(t);const content='0123456789';await writeFile(join(publicDir,'movie.mp4'),content);await writeFile(join(publicDir,'movie.mp4.gz'),gzipSync(content));
  const manifest=join(root,'assets.json');execFileSync(process.execPath,[...(process.versions.bun?[]:['--experimental-strip-types']),'scripts/asset-manifest.ts',publicDir,manifest],{stdio:'pipe'});
  const s=await server(t,{publicDir,staticMode:'immutable',assetManifest:manifest});
  const tag=`"sha256-${createHash('sha256').update(content).digest('hex')}-identity"`;
  const full=await call(s,'/movie.mp4',{headers:{'accept-encoding':'identity'}});assert.equal(full.headers.get('etag'),tag);assert.equal(await full.text(),content);
  const part=await call(s,'/movie.mp4',{headers:{range:'bytes=3-5','if-range':tag}});assert.equal(part.status,206);assert.equal(await part.text(),'345');
  const weak=await call(s,'/movie.mp4',{headers:{range:'bytes=3-5','if-range':'W/'+tag,'accept-encoding':'identity'}});assert.equal(weak.status,200);assert.equal(await weak.text(),content);
  const gz=await call(s,'/movie.mp4',{headers:{'accept-encoding':'gzip'}});assert.notEqual(gz.headers.get('etag'),tag);assert.equal(await gz.text(),content);
  assert.equal((await call(s,'/movie.mp4',{headers:{'if-none-match':tag,'accept-encoding':'identity'}})).status,304);
  assert.equal(s.stats.openStaticFiles,0);await writeFile(join(publicDir,'movie.mp4'),'longer than original');
  await assert.rejects(createServer({port:0,publicDir,staticMode:'immutable',assetManifest:manifest}).start(),/invalid asset digest/);
});

test('independent handler and plugin budgets and execution deadline retain uncooperative work',async t=>{
  const entered=deferred(), release=deferred();let closed=false, aborted=false;
  const plugin:ServePlugin={...route('slow',async r=>{r.signal.addEventListener('abort',()=>aborted=true);entered.resolve();await release.promise;return new Response('late');}),maxConcurrentRequests:1,executionTimeoutMs:30,close(){closed=true;}};
  const s=await server(t,{plugins:[plugin,route('health',()=>new Response(null,{status:204}))],maxConcurrentHandlers:2,shutdownTimeoutMs:15});
  const pending=call(s,'/slow');await entered.promise;assert.equal(s.stats.activeHandlers,1);assert.equal((await call(s,'/health')).status,204);
  const timeout=await pending;assert.equal(timeout.status,504);await timeout.text();assert.equal(aborted,true);assert.equal(s.stats.activeHandlers,1);assert.equal((await call(s,'/slow')).status,503);
  await s.removePlugin('slow');assert.equal(closed,false);assert.equal(s.stats.pendingCleanup,1);release.resolve();await until(()=>closed&&drained(s));
});

test('client disconnect aborts a running handler signal and releases its lease', async t=>{
  const entered=deferred();let reason:unknown;
  const s=await server(t,{plugins:[route('wait',r=>new Promise<Response>(resolve=>{r.signal.addEventListener('abort',()=>{reason=r.signal.reason;resolve(new Response('late'));},{once:true});entered.resolve();}))]});
  const controller=new AbortController();const pending=call(s,'/wait',{signal:controller.signal}).catch(()=>{});
  await entered.promise;controller.abort();await pending;
  await until(()=>reason!==undefined&&drained(s));assert.ok(reason instanceof Error);
});

test('a request without a usable Host gets 400 on both runtimes, never 500', async t=>{
  // VERIFIED: (Bun 1.4.3 and 1.4.5 probes) Bun hands fetch() the raw target as request.url when the Host is missing, empty
  // or malformed, which no URL parses; 0.4.0 answered 500 there. Node's adapter refuses such a request itself.
  const diagnostics: string[]=[];
  const s=await server(t,{plugins:[route('relay-probe',()=>new Response('ok'))],onDiagnostic:e=>diagnostics.push(e.code)});
  for (const host of ['','Host: \r\n','Host: a b\r\n']) assert.match(await raw(s,`GET /relay-probe HTTP/1.0\r\n${host}\r\n`),/^HTTP\/1\.1 400 /,JSON.stringify(host));
  // A WebSocket handshake without a Host takes Node's upgrade path.
  assert.match(await raw(s,'GET /relay-probe HTTP/1.0\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'),/^HTTP\/1\.1 400 /);
  assert.match(await raw(s,'GET /relay-probe HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'),/^HTTP\/1\.1 200 /);
  assert.deepEqual(diagnostics,[]); assert.equal(s.stats.rejected,4); await until(()=>drained(s));
});

test('onRequest reports the path of every request and whether the host refused it before any handler', async t=>{
  const events: RequestEvent[]=[];
  const s=await server(t,{plugins:[{...route('relay-probe',()=>new Response('ok'),'/relay-probe',['GET','POST']),maxBodyBytes:4}],onRequest:e=>events.push(e)});
  const seen=()=>events.splice(0).map(({durationMs,...rest})=>{ assert.ok(durationMs>=0); return rest; });
  const host=`Host: 127.0.0.1:${s.port}\r\nConnection: close\r\n`;
  assert.match(await raw(s,`GET /relay-probe?x=1 HTTP/1.1\r\n${host}\r\n`),/^HTTP\/1\.1 200 /);
  assert.deepEqual(seen(),[{method:'GET',handler:'relay-probe',status:200,path:'/relay-probe?x=1',rejected:false}]);
  assert.match(await raw(s,`GET /missing HTTP/1.1\r\n${host}\r\n`),/^HTTP\/1\.1 404 /);
  assert.deepEqual(seen(),[{method:'GET',handler:'http',status:404,path:'/missing',rejected:false}]);
  assert.match(await raw(s,'GET /relay-probe HTTP/1.0\r\n\r\n'),/^HTTP\/1\.1 400 /);
  assert.deepEqual(seen(),[{method:'GET',handler:'http',status:400,path:'/relay-probe',rejected:true}]);
  assert.match(await raw(s,'POST /relay-probe?a=b HTTP/1.1\r\nHost: rebound.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'),/^HTTP\/1\.1 403 /);
  assert.deepEqual(seen(),[{method:'POST',handler:'http',status:403,path:'/relay-probe?a=b',rejected:true}]);
  assert.match(await raw(s,`POST /relay-probe HTTP/1.1\r\n${host}Content-Length: 5\r\n\r\n12345`),/^HTTP\/1\.1 413 /);
  assert.deepEqual(seen(),[{method:'POST',handler:'relay-probe',status:413,path:'/relay-probe',rejected:true}]);
  assert.match(await raw(s,`GET /a%2Fb HTTP/1.1\r\n${host}\r\n`),/^HTTP\/1\.1 400 /);
  assert.deepEqual(seen(),[{method:'GET',handler:'http',status:400,path:'/a%2Fb',rejected:true}]);
  if (s.runtime==='node') {
    // Node's adapter refuses an absolute-form target before dispatch and reports the raw target.
    assert.match(await raw(s,`GET http://example.org/x HTTP/1.1\r\n${host}\r\n`),/^HTTP\/1\.1 400 /);
    assert.deepEqual(seen(),[{method:'GET',handler:'http',status:400,path:'http://example.org/x',rejected:true}]);
  }
});

test('actual stream and descriptor budgets do not block bodyless health checks', async t=>{
  const {publicDir}=await fixture(t);const handle=await open(join(publicDir,'media.bin'),'w');await handle.truncate(64*1024*1024);await handle.close();
  const s=await server(t,{publicDir,staticMode:'immutable',maxOpenStaticFiles:1,maxConcurrentStreams:1,plugins:[route('health',()=>new Response(null,{status:204})),route('body',()=>new Response('data'))]});
  const req=request(new URL('/media.bin',s.url!));req.on('error',()=>{});
  await new Promise<void>((resolve,reject)=>{req.on('error',reject);req.on('response',res=>{res.on('error',()=>{});res.once('data',()=>{res.pause();resolve();});});req.end();});
  assert.equal(s.stats.openStaticFiles,1);assert.equal(s.stats.activeStreams,1);assert.equal((await call(s,'/health')).status,204);
  const rejected=await call(s,'/media.bin');assert.equal(rejected.status,503);await rejected.text();const body=await call(s,'/body');assert.equal(body.status,503);await body.text();
  req.destroy();await until(()=>drained(s));const next=await call(s,'/media.bin',{headers:{range:'bytes=0-3'}});assert.equal(next.status,206);assert.equal((await next.arrayBuffer()).byteLength,4);await until(()=>drained(s));
});

test('body-bearing upload admission is independent of bodyless calls',async t=>{
  const entered=deferred(), release=deferred();const p=route('upload',async r=>{entered.resolve();await release.promise;return new Response(await r.text());},'/upload',['POST']);
  const s=await server(t,{maxConcurrentUploads:1,plugins:[p,route('health',()=>new Response(null,{status:204}))]});
  const first=call(s,'/upload',{method:'POST',body:'first'});await entered.promise;assert.equal(s.stats.activeUploads,1);assert.equal((await call(s,'/health')).status,204);assert.equal((await call(s,'/upload',{method:'POST',body:'second'})).status,503);release.resolve();assert.equal(await(await first).text(),'first');await until(()=>drained(s));
});

test('deterministic generated range, path and validator invariants',()=>{
  let state=0x9e3779b9;const random=(n:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;};
  for(let i=0;i<10000;i++){
    const size=random(65536),a=random(100000),b=a+random(100000),suffix=random(100000);
    const expected=a>=size?{kind:'unsatisfiable'}:{kind:'partial',start:a,end:Math.min(b,size-1)};
    assert.deepEqual(parseRange(`bytes=${a}-${b}`,size),expected);
    assert.deepEqual(parseRange(`bytes=-${suffix}`,size),!size||!suffix?{kind:'unsatisfiable'}:{kind:'partial',start:Math.max(0,size-suffix),end:size-1});
    assert.deepEqual(parseRange(`bytes=${a}-`,size),a>=size?{kind:'unsatisfiable'}:{kind:'partial',start:a,end:size-1});
    const tag=`"${random(100000)}"`;const mtime=random(1e9);
    assert.equal(precondition(new Headers({'if-none-match':'W/'+tag}),tag,mtime),304);
    assert.equal(precondition(new Headers({'if-match':'W/'+tag,'if-none-match':'*'}),tag,mtime),412);
    assert.equal(allowsRange(tag,tag,mtime),true);assert.equal(allowsRange('W/'+tag,tag,mtime),false);
    const segment=`file-${random(100000)}-ü %`;
    assert.deepEqual(safeSegments('/'+encodeURIComponent(segment),false),[segment]);
  }
  for(const value of ['/%2f','/%5c','/%00','/%2e%2e','/%','/a%3ab','/.secret'])assert.throws(()=>safeSegments(value,false));
  assert.deepEqual(parseRange('bytes=999999999999999999999999999999-',100),{kind:'unsatisfiable'});
  assert.deepEqual(parseRange('bytes=0-1,3-4',100),{kind:'full'});
});

test('resource endurance: repeated file reads, disconnects, plugin replacements, bounded counters and descriptors',async t=>{
  const {publicDir}=await fixture(t);await writeFile(join(publicDir,'data.bin'),Buffer.alloc(65536,42));
  const s=await server(t,{publicDir,staticMode:'immutable',maxConcurrentRequests:64,maxOpenStaticFiles:32});
  const descriptors=async()=>process.platform==='linux'?(await readdir('/proc/self/fd')).length:undefined;
  const sample=()=>({heap:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss});
  async function batch(){await Promise.all(Array.from({length:16},async()=>{const r=await call(s,'/data.bin',{headers:{range:'bytes=0-1023'}});assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,1024);}));await until(()=>drained(s));}
  await batch();await batch();const before=await descriptors();const memoryBefore=sample();
  for(let i=0;i<40;i++){await s.addPlugin(route('version',()=>new Response(String(i))));assert.equal(await(await call(s,'/version')).text(),String(i));await batch();await s.removePlugin('version');}
  // Exercise mid-response disconnects against an open-ended response, not just clean EOF.
  for(let i=0;i<20;i++) {
    await s.addPlugin(route('disconnect',()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(4096));}}))));
    const req=request(new URL('/disconnect',s.url!));req.on('error',()=>{});
    await new Promise<void>((resolve,reject)=>{req.once('error',reject);req.once('response',res=>{res.on('error',()=>{});res.once('data',()=>{req.destroy();resolve();});});req.end();});
    await until(()=>drained(s));await s.removePlugin('disconnect');
  }
  await until(()=>drained(s));const after=await descriptors();const memoryAfter=sample();assert.equal(s.stats.pendingCleanup,0);if(before!==undefined&&after!==undefined)assert.ok(after<=before+16,`Descriptor growth ${before} -> ${after}`);
  // Report memory rather than an unstable GC-dependent exact threshold.
  console.log(JSON.stringify({endurance:{requests:732,fdsBefore:before,fdsAfter:after,memoryBefore,memoryAfter}}));
});


const ipv6Loopback = Object.entries(networkInterfaces()).find(([, list]) => list?.some(a => a.internal && a.family === 'IPv6' && a.address === '::1'))?.[0];
const listen = (port: number) => new Promise<ReturnType<typeof createNetServer>>((resolve, reject) => { const n = createNetServer(); n.once('error', reject); n.listen(port, '::1', () => resolve(n)); });
test('failed post-bind startup closes the listener; an empty wildcard host is rejected', {skip: !ipv6Loopback}, async () => {
  assert.throws(() => createServer({host: ''}), /Invalid host/);
  const probe = await listen(0); const port = (probe.address() as AddressInfo).port; await new Promise(r => probe.close(r));
  // A bindable zone host that a URL cannot represent: start fails after binding and must release the port.
  const s = createServer({runtime: 'node', host: `::1%${ipv6Loopback}`, port, allowedHosts: ['localhost']});
  await assert.rejects(s.start()); assert.equal(s.state, 'stopped');
  const again = await listen(port); await new Promise(r => again.close(r));
});

test('Node connection admission rejects excess sockets and releases capacity on close',async t=>{
  const s=await server(t,{runtime:'node',maxConnections:1,plugins:[route('ok',()=>new Response('OK'))]});
  const socket=connect(s.port!,'127.0.0.1');socket.on('error',()=>{});
  await new Promise<void>(resolve=>socket.once('connect',resolve));await delay(20);
  const payload=`GET /ok HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`;
  try { assert.equal(await raw(s,payload),''); } catch(error) { assert.equal((error as NodeJS.ErrnoException).code,'ECONNRESET'); }
  socket.destroy();await delay(30);assert.match(await raw(s,payload),/^HTTP\/1\.1 200/);
});


test('native Bun file path returns the same range and conditional bytes when opted in', {skip: !process.versions.bun}, async t=>{
  const {publicDir}=await fixture(t);await writeFile(join(publicDir,'video.mp4'),'0123456789');
  const s=await server(t,{runtime:'bun',publicDir,staticMode:'immutable',nativeStaticFastPath:true,maxConcurrentRequests:0,maxConcurrentStreams:0,maxOpenStaticFiles:0});
  const full=await call(s,'/video.mp4');const tag=full.headers.get('etag')!;assert.equal(await full.text(),'0123456789');
  const range=await call(s,'/video.mp4',{headers:{range:'bytes=2-4'}});assert.equal(range.status,206);assert.equal(await range.text(),'234');
  const ignored=await call(s,'/video.mp4',{headers:{range:'bytes=2-4','if-range':'"wrong"'}});assert.equal(ignored.status,200);assert.equal(await ignored.text(),'0123456789');
  assert.equal((await call(s,'/video.mp4',{headers:{'if-none-match':tag}})).status,304);
  await until(()=>drained(s));
});
