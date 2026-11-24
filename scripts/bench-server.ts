/** Child server for the matched process-isolated benchmark. */
import { createServer as nativeServer } from 'node:http';
import { Readable } from 'node:stream';
import { reference } from './bench-reference.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createServer, type ServeServer } from 'defuss-serve';
import { endpointPlugin } from 'defuss-serve/plugins';
const [mode, root, baseline] = process.argv.slice(2);
const file = join(root, 'media.bin');
let service: ServeServer | undefined;
let close: () => Promise<void>;
let url: string;
const encoder = new TextEncoder();
const sse = 'data: one\n\ndata: two\n\n';
if (mode === 'native-bun') {
  const bun = (globalThis as typeof globalThis & { Bun?: { file(path: string): Blob; serve(options: { hostname: string; port: number; routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>; fetch(request: Request): Response }): { url: URL; stop(force?: boolean): void | Promise<void> } } }).Bun;
  if (!bun) throw Error('Native Bun benchmark requires Bun');
  const routes = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`/route${i}`, new Response('OK')])) as Record<string, Response | ((request: Request) => Response | Promise<Response>)>;
  routes['/media.bin'] = () => new Response(bun.file(file));
  routes['/events'] = () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
  routes['/asset.js'] = request => reference(root, '/asset.js', request.method, request.headers);
  const server = bun.serve({hostname:'127.0.0.1',port:0,routes,fetch:()=>new Response('Not Found',{status:404})});
  url = server.url.origin; close = async () => { await server.stop(true); };
} else if (['native','express','fastify','hono'].includes(mode)) {
  // Optional comparison dependencies are loaded only when requested; no core dependencies.
  const headers = (req: IncomingMessage) => new Headers(Object.entries(req.headers).flatMap<[string,string]>(([key,value]) => value === undefined ? [] : Array.isArray(value) ? value.map(v=>[key,v] as [string,string]) : [[key,value]]));
  async function handler(req: IncomingMessage, res: ServerResponse) {
    try {
      const response=await reference(root,new URL(req.url??'/', 'http://localhost').pathname,req.method??'GET',headers(req));
      res.statusCode=response.status;for(const [name,value] of response.headers)res.setHeader(name,value);
      if(response.body) { const stream=Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);res.once('close',()=>stream.destroy());stream.once('error',()=>res.destroy());stream.pipe(res); }
      else res.end();
    } catch {res.destroy();}
  }
  if (mode==='fastify') {
    const moduleName='fastify';const {default:Fastify}=await import(moduleName);const app=Fastify({logger:false});
    // Explicit route registration to match the declared-route workload.
    for (const path of [...Array.from({length:64},(_,i)=>`/route${i}`),'/events','/asset.js','/media.bin']) app.get(path,async(req:{raw:IncomingMessage},reply:{raw:ServerResponse;hijack():void})=>{reply.hijack();await handler(req.raw,reply.raw);});
    await app.listen({port:0,host:'127.0.0.1'});const address=app.server.address();url=`http://127.0.0.1:${address.port}`;close=()=>app.close();
  } else if (mode==='hono') {
    const honoName='hono',adapterName='@hono/node-server';const {Hono}=await import(honoName);const {serve}=await import(adapterName);const app=new Hono();
    for (const path of [...Array.from({length:64},(_,i)=>`/route${i}`),'/events','/asset.js','/media.bin']) app.get(path,(c:{req:{raw:Request}})=>reference(root,new URL(c.req.raw.url).pathname,c.req.raw.method,c.req.raw.headers));
    const native=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'});if(!native.listening)await once(native,'listening');url=`http://127.0.0.1:${native.address().port}`;close=()=>new Promise<void>(resolve=>{native.close(()=>resolve());native.closeAllConnections?.();});
  } else {
    let native;
    if(mode==='express') {const moduleName='express';const {default:express}=await import(moduleName);const app=express();app.disable('x-powered-by');for(const path of [...Array.from({length:64},(_,i)=>`/route${i}`),'/events','/asset.js','/media.bin'])app.get(path,handler);native=nativeServer(app);}
    else native=nativeServer((req,res)=>{void handler(req,res);});
    native.listen(0,'127.0.0.1');await once(native,'listening');const address=native.address();if(!address||typeof address==='string')throw Error('Invalid native address');url=`http://127.0.0.1:${address.port}`;close=()=>new Promise<void>(resolve=>{native.close(()=>resolve());native.closeAllConnections();});
  }
} else {
  const old = mode.startsWith('baseline');
  const factory: typeof createServer = old ? (await import(pathToFileURL(join(baseline, 'dist/index.mjs')).href)).createServer : createServer;
  const pluginFactory: typeof endpointPlugin = old ? (await import(pathToFileURL(join(baseline, 'dist/plugins.mjs')).href)).endpointPlugin : endpointPlugin;
  const routes = Array.from({ length: 64 }, (_, i) => pluginFactory(`route${i}`, { fetch: () => new Response('OK') }, [{ path: `/route${i}`, methods: ['GET'] }]));
  routes.push(pluginFactory('events', { fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(sse.slice(0, 11))); c.enqueue(encoder.encode(sse.slice(11))); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }) }, [{ path: '/events', methods: ['GET'] }]));
  service = factory({ port: 0, ...(mode === 'api' ? {} : { publicDir: root }), staticMode: mode.endsWith('immutable') ? 'immutable' : 'live', plugins: routes });
  await service.start(); url = service.url!.origin; close = () => service!.stop();
}
const snapshot = () => {
  const cpu = process.cpuUsage();
  let fds: number | null = null; try { fds = readdirSync('/proc/self/fd').length; } catch { /* non-Linux */ }
  return { cpuUs: cpu.user + cpu.system, rss: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024, fds };
};
process.send?.({ url, ...snapshot() });
process.on('message', async (message: string) => {
  if (message === 'snapshot') process.send?.(snapshot());
  else if (message === 'stop') { await close(); process.disconnect?.(); }
});
