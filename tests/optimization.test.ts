import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, type ServeOptions, type LifecycleEvent, type ServePlugin } from 'defuss-serve';
import { endpointPlugin } from 'defuss-serve/plugins';
const encoder = new TextEncoder();
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  assert.fail('Condition did not settle');
}
async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'serve-v2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<h1>App</h1>');
  return dir;
}
async function start(t: { after(fn: () => unknown): void }, opts: ServeOptions) {
  const s = createServer({ port: 0, ...opts }); await s.start(); t.after(() => s.stop()); return s;
}
const endpoint = (name: string, path: string, text = 'OK') => endpointPlugin(name, { fetch: () => new Response(text) }, [{ path, methods: ['GET'] }]);
const raw = (url: URL, options: { method?: string; headers?: Record<string,string> }, write?: (req: ReturnType<typeof request>) => void) => new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
  const req = request(url, options, res => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers })); res.on('error', reject); });
  req.on('error', reject); if (write) write(req); else req.end();
});

test('immutable manifest: misses, conditional requests, immutable cache contract, aliases, deployment mutation', async t => {
  const dir = await fixture(t);
  await mkdir(join(dir, 'docs')); await writeFile(join(dir, 'docs/index.html'), 'docs');
  await writeFile(join(dir, 'app.12345678.js'), 'asset');
  await writeFile(join(dir, 'movie.mp4'), '0123456789');
  if (process.platform !== 'win32') await symlink(join(dir, 'docs'), join(dir, 'alias'));
  const s = await start(t, { publicDir: dir, staticMode: 'immutable', immutableAssetPattern: /\.[a-f0-9]{8}\.js$/, spaFallback: true, plugins: [endpoint('api','/api')] });
  const get = (path: string, init?: RequestInit) => fetch(new URL(path,s.url!),init);
  assert.equal(await (await get('/api')).text(), 'OK');
  const asset = await get('/app.12345678.js'); assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable'); assert.equal(await asset.text(), 'asset');
  const media = await get('/movie.mp4'); const etag = media.headers.get('etag')!; assert.equal(await media.text(),'0123456789');
  assert.equal((await get('/movie.mp4',{headers:{'if-none-match':etag}})).status,304);
  const part = await get('/movie.mp4',{headers:{range:'bytes=2-4'}}); assert.equal(part.status,206); assert.equal(await part.text(),'234');
  assert.equal((await get('/docs',{redirect:'manual'})).status,308); assert.equal(await (await get('/docs/')).text(),'docs');
  if (process.platform !== 'win32') assert.equal((await get('/alias/index.html')).status,403);
  await writeFile(join(dir,'added.txt'),'added'); assert.equal((await get('/added.txt')).status,404);
  await writeFile(join(dir,'movie.mp4'),'changed length'); assert.equal((await get('/movie.mp4')).status,503);
  assert.equal(await (await get('/nav',{headers:{accept:'text/html'}})).text(),'<h1>App</h1>');
  await assert.rejects(createServer({port:0, publicDir:dir, staticMode:'immutable',maxManifestEntries:1}).start(),/manifest entry limit/);
});

test('live bounded negative cache expiry and static-shadow policy on startup and registration', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir,'health'),'static');
  await assert.rejects(createServer({port:0,publicDir:dir,staticMode:'immutable',staticShadow:'error',plugins:[endpoint('health','/health')]}).start(),/Static\/API shadow/);
  const s = await start(t,{publicDir:dir,staticMode:'immutable',staticShadow:'error'});
  await assert.rejects(s.addPlugin(endpoint('health','/health')), /shadow/);
  const live = await start(t,{publicDir:dir,staticCacheTtlMs:80,staticCacheEntries:1,staticShadow:'error',plugins:[endpoint('health','/health')]});
  const get = (path:string) => fetch(new URL(path,live.url!));
  assert.equal((await get('/health')).status,503);
  assert.equal((await get('/new.txt')).status,404); await writeFile(join(dir,'new.txt'),'new');
  assert.equal((await get('/new.txt')).status,404); await delay(100); assert.equal(await (await get('/new.txt')).text(),'new');
  await get('/a.txt'); await get('/b.txt'); await writeFile(join(dir,'a.txt'),'a'); assert.equal(await (await get('/a.txt')).text(),'a');
});

test('uncooperative handler stays quarantined after drain deadline; no premature close or replacement', async t => {
  const entered = deferred(), release = deferred(); let closed = false; let abort = false;
  const events: string[] = [];
  const plugin: ServePlugin = { name:'slow',matches:()=>true,async fetch(r) { r.signal.addEventListener('abort',()=>{abort=true;}); entered.resolve(); await release.promise; return new Response('late'); },close(){closed=true;} };
  const s = await start(t,{shutdownTimeoutMs:20,plugins:[plugin],onDiagnostic:e=>events.push(e.code)});
  const call = fetch(s.url!).then(async r=>{await r.text();},()=>{}); await entered.promise;
  const begin = performance.now(); await s.removePlugin('slow'); assert.ok(performance.now()-begin<150); assert.equal(closed,false); assert.equal(abort,true); assert.equal(s.stats.pendingCleanup,1);
  assert.equal((await fetch(s.url!)).status,404); await assert.rejects(s.addPlugin(plugin),/cleanup pending/);
  assert.ok(events.includes('plugin-drain-timeout')); assert.ok(events.includes('plugin-close-timeout'));
  release.resolve(); await call; await until(()=>closed); assert.equal(s.stats.pendingCleanup,0); assert.equal(s.stats.activeRequests,0);
});

test('slow cleanup is bounded by one stop deadline; late rejections diagnosed', async t => {
  const release = deferred(); const events: string[]=[];
  const p = {...endpoint('slow','/slow'), async close(){await release.promise; throw Error('late cleanup');}};
  const s = await start(t,{shutdownTimeoutMs:20,plugins:[p],onDiagnostic:e=>events.push(e.code)});
  const begin=performance.now(); await s.stop(); assert.ok(performance.now()-begin<150); assert.equal(s.state,'stopped'); assert.equal(s.stats.pendingCleanup,1);
  release.resolve(); await until(()=>s.stats.pendingCleanup===0); assert.ok(events.includes('plugin-close-error'));
});

test('cancel hook completion is part of drain; resource cleanup never races cancellation', async t => {
  const cancelling=deferred(), release=deferred(); let closed=false;
  const p:ServePlugin={name:'stream',matches:()=>true,fetch:()=>new Response(new ReadableStream({start(c){c.enqueue(encoder.encode('chunk'));},async cancel(){cancelling.resolve();await release.promise;}})),close(){closed=true;}};
  const s=await start(t,{shutdownTimeoutMs:20,plugins:[p]}); const res=await fetch(s.url!); const reader=res.body!.getReader(); await reader.read();
  await s.removePlugin('stream'); await cancelling.promise; assert.equal(closed,false); assert.equal(s.stats.pendingCleanup,1);
  release.resolve(); await until(()=>closed); await assert.rejects(reader.read());
});

test('admission limits reject before side effects and lifecycle bytes count source production', async t => {
  const entered=deferred(), release=deferred(); const events:LifecycleEvent[]=[]; let calls=0;
  const p=endpointPlugin('stream',{async fetch(){calls++;entered.resolve();await release.promise;return new Response('hello');}},[{path:'/work',methods:['GET']}]);
  const s=await start(t,{maxConcurrentRequests:3,maxConcurrentHandlers:1,maxConcurrentStreams:1,plugins:[p],onLifecycle:e=>events.push(e)});
  const work=fetch(new URL('/work',s.url!)); await entered.promise; assert.equal(s.stats.activeRequests,1);
  assert.equal((await fetch(new URL('/work',s.url!))).status,503); assert.equal(calls,1); assert.equal(s.stats.rejected,1);
  release.resolve(); assert.equal(await (await work).text(),'hello'); await until(()=>s.stats.activeRequests===0);
  const complete=events.find(e=>e.phase==='complete' && e.route==='/work' && e.status===200); assert.equal(complete?.bytes,5); assert.equal(complete?.route,'/work'); assert.equal(complete?.activeStreams,0);
});

test('per-plugin body limits, absolute body-read deadline, host and forwarding trust', async t => {
  const p={...endpointPlugin('echo',{async fetch(r){return Response.json({body:await r.text(),forwarded:r.headers.get('x-forwarded-for')});}},[{path:'/echo',methods:['POST']}]),maxBodyBytes:4,bodyTimeoutMs:35};
  const s=await start(t,{plugins:[p],maxBodyBytes:16}); const url=new URL('/echo',s.url!);
  const ok=await raw(url,{method:'POST',headers:{'x-forwarded-for':'spoof'}},r=>r.end('1234')); assert.equal(ok.status,200); assert.deepEqual(JSON.parse(ok.body),{body:'1234',forwarded:null});
  assert.equal((await raw(url,{method:'POST'},r=>r.end('12345'))).status,413);
  assert.equal((await raw(url,{method:'POST',headers:{host:'example.invalid'}},r=>r.end('1'))).status,403);
  const slow=await raw(url,{method:'POST',headers:{'transfer-encoding':'chunked'}},r=>{r.write('1');r.flushHeaders();const timer=setTimeout(()=>{if(!r.destroyed)r.end('2');},120);r.once('close',()=>clearTimeout(timer));}); assert.equal(slow.status,408);
  await s.stop();
  const trusted=await start(t,{plugins:[p],trustedProxies:['127.0.0.1','::ffff:127.0.0.1']});
  const result=await raw(new URL('/echo',trusted.url!),{method:'POST',headers:{'x-forwarded-for':'203.0.113.10'}},r=>r.end('1')); assert.equal(JSON.parse(result.body).forwarded,'203.0.113.10');
});

test('compiled dispatch supports method overlap, prefix boundaries, and dynamic fallback collision',async t=>{
  const get=endpoint('get','/x');
  const post=endpointPlugin('post',{fetch:()=>new Response('post')},[{path:'/x',methods:['POST']}]);
  const prefix=endpointPlugin('prefix',{fetch:()=>new Response('prefix')},[{path:'/tree',prefix:true,methods:['GET']}]);
  const s=await start(t,{plugins:[get,post,prefix]});
  const call=(path:string,method='GET')=>fetch(new URL(path,s.url!),{method});
  assert.equal(await(await call('/x/')).text(),'OK'); assert.equal(await(await call('/x','POST')).text(),'post');
  const wrong=await call('/x','DELETE'); assert.equal(wrong.status,405); assert.equal(wrong.headers.get('allow'),'GET, POST');
  assert.equal(await(await call('/tree/branch')).text(),'prefix'); assert.equal((await call('/treehouse')).status,404);
  await s.addPlugin({name:'dynamic',matches:r=>new URL(r.url).pathname==='/x',fetch:()=>new Response('dynamic')}); assert.equal((await call('/x')).status,500);
  await s.removePlugin('dynamic'); assert.equal(await(await call('/x')).text(),'OK');
});

test('startup deadline quarantines pending initialization until it settles', async t => {
  const entered=deferred(), release=deferred();let closed=false;
  const p={...endpoint('starting','/starting'),async start(){entered.resolve();await release.promise;},close(){closed=true;}};
  const s=await start(t,{pluginStartTimeoutMs:20,shutdownTimeoutMs:20});
  const adding=s.addPlugin(p);await entered.promise;await assert.rejects(adding,/startup deadline/);
  assert.equal(closed,false);assert.equal(s.stats.pendingCleanup,1);await assert.rejects(s.addPlugin(p),/cleanup pending/);
  assert.equal((await fetch(new URL('/starting',s.url!))).status,404);release.resolve();await until(()=>closed);assert.equal(s.stats.pendingCleanup,0);
});

test('slow static consumer does not eagerly produce a complete large file and cancellation releases budget',async t=>{
  const dir=await fixture(t);const {open}=await import('node:fs/promises');const f=await open(join(dir,'large.bin'),'w');const size=32*1024*1024;await f.truncate(size);await f.close();
  const events:LifecycleEvent[]=[];const s=await start(t,{publicDir:dir,staticMode:'immutable',onLifecycle:e=>events.push(e)});
  const req=request(new URL('/large.bin',s.url!));
  await new Promise<void>((resolve,reject)=>{req.on('error',reject);req.on('response',res=>{res.once('data',()=>{res.pause();resolve();});res.on('error',()=>{});});req.end();});
  await delay(80);assert.equal(s.stats.activeRequests,1);assert.equal(s.stats.activeStreams,1);assert.equal(events.some(e=>e.phase==='complete'),false);
  req.destroy();await until(()=>s.stats.activeRequests===0);const end=events.find(e=>e.phase==='cancel'||e.phase==='error');assert.ok(end);assert.ok(end.bytes<size);assert.equal(s.stats.activeStreams,0);
});

test('repeated atomic plugin changes, stable error telemetry and no leaked leases',async t=>{
  const events:LifecycleEvent[]=[];const s=await start(t,{onLifecycle:e=>events.push(e)});
  for(let i=0;i<15;i++){await s.addPlugin(endpoint('version','/version',String(i)));assert.equal(await(await fetch(new URL('/version',s.url!))).text(),String(i));await s.removePlugin('version');}
  await s.addPlugin({...endpoint('throwing','/error'),fetch(){throw Error('private');}});
  const response=await fetch(new URL('/error',s.url!));assert.equal(response.status,500);assert.equal(await response.text(),'Internal Server Error');await until(()=>s.stats.activeRequests===0);assert.ok(events.some(e=>e.phase==='error'&&e.route==='/error'));assert.equal(s.stats.pendingCleanup,0);
});
