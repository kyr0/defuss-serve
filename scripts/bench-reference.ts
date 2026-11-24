/** A common, explicit fixture contract for comparing framework transport overhead.
 * Not a replacement for each framework's production static middleware. */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRange } from '../src/static/range.ts';
import { precondition, allowsRange, validator } from '../src/static/cache.ts';
export async function reference(root: string, pathname: string, method: string, headers: Headers): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
  if (/^\/route(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(pathname)) return new Response(method==='HEAD'?null:'OK',{headers:{'Content-Type':'text/plain;charset=UTF-8'}});
  if (pathname==='/events') return new Response(method==='HEAD'?null:'data: one\n\ndata: two\n\n',{headers:{'Content-Type':'text/event-stream'}});
  if (pathname!=='/asset.js'&&pathname!=='/media.bin')return new Response('Not Found',{status:404});
  const file=join(root,pathname.slice(1));const meta=await stat(file);const etag=validator(meta,'identity');
  const out=new Headers({'ETag':etag,'Last-Modified':new Date(meta.mtimeMs).toUTCString(),'Content-Type':pathname.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'public, max-age=0, must-revalidate'});
  const conditional=precondition(headers,etag,meta.mtimeMs);if(conditional)return new Response(null,{status:conditional,headers:out});
  const range=parseRange(method==='GET'&&allowsRange(headers.get('if-range'),etag,meta.mtimeMs)?headers.get('range'):null,meta.size);
  if(range.kind==='unsatisfiable'){out.set('Content-Range',`bytes */${meta.size}`);return new Response(null,{status:416,headers:out});}
  const start=range.kind==='partial'?range.start:0,end=range.kind==='partial'?range.end:meta.size-1;
  out.set('Content-Length',String(end-start+1));if(range.kind==='partial')out.set('Content-Range',`bytes ${start}-${end}/${meta.size}`);
  return new Response(method==='HEAD'||!meta.size?null:Readable.toWeb(createReadStream(file,{start,end})) as ReadableStream<Uint8Array>,{status:range.kind==='partial'?206:200,headers:out});
}
