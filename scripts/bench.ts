/** Separate server process, verified payloads, warmup, latency distribution and server-only resources. */
import { fork, type ChildProcess } from 'node:child_process';
import { Agent, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
const count = Number(process.env.BENCH_REQUESTS ?? 4000);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 32);
const rounds = Number(process.env.BENCH_ROUNDS ?? 3);
for (const n of [count, concurrency, rounds]) if (!Number.isSafeInteger(n) || n < 1) throw Error('Invalid benchmark configuration');
const root = await mkdtemp(join(tmpdir(), 'serve-bench-'));
await writeFile(join(root, 'media.bin'), Buffer.alloc(4 * 1024 * 1024, 42));
await writeFile(join(root, 'asset.js'), 'export const value = 42;');
const base = process.env.BASELINE_PACKAGE_DIR ? resolve(process.env.BASELINE_PACKAGE_DIR) : '';
const modes = (process.env.BENCH_MODES ?? `${base ? 'baseline-live,baseline-immutable,' : ''}native,${process.versions.bun ? 'native-bun,' : ''}live,immutable,api`).split(',');
interface Metrics { cpuUs: number; rss: number; peakRss: number; fds: number | null }
const snap = async (child: ChildProcess): Promise<Metrics> => { const result = once(child, 'message'); child.send('snapshot'); return (await result)[0] as Metrics; };
const percentile = (a: number[], p: number) => a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)];
const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
async function get(url: string, path: string, headers: Record<string,string>, expected: number, size: number, value?: string): Promise<{ elapsed: number; bytes: number; etag?: string }> {
  const begin = performance.now();
  return new Promise((resolve, reject) => {
    const req = request(url + path, { agent, headers }, res => {
      let bytes = 0; const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { bytes += c.length; if (value !== undefined) chunks.push(c); else if (size && (c[0] !== 42 || c[c.length-1] !== 42)) reject(Error('Media integrity')); });
      res.on('error', reject);
      res.on('end', () => { try { assert.equal(res.statusCode, expected); assert.equal(bytes, size); if (value !== undefined) assert.equal(Buffer.concat(chunks).toString(), value); resolve({ elapsed: performance.now()-begin, bytes, etag: res.headers.etag }); } catch (error) { reject(error); } });
    });
    req.on('error',reject); req.setTimeout(30000, () => req.destroy(Error('Client timeout'))); req.end();
  });
}
interface Case { name: string; path: string; size: number; status: number; n: number; value?: string; headers?: Record<string,string> }
const results: Array<Record<string, unknown>> = [];
const require = createRequire(import.meta.url);
const installed: Record<string,string> = {};
for(const name of ['express','fastify','hono','@hono/node-server']) {
  try {
    let directory=dirname(require.resolve(name));
    for(;;){
      try{const pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));if(pkg.name===name){installed[name]=pkg.version;break;}}catch{/* ascend */}
      const parent=dirname(directory);if(parent===directory)break;directory=parent;
    }
  }catch{/* optional comparator not installed */}
}
try {
  for (let round=0; round<rounds; round++) {
    const order = [...modes.slice(round % modes.length), ...modes.slice(0, round % modes.length)];
    for (const mode of order) {
      const child = fork('scripts/bench-server.ts', [mode, root, base], { execArgv: process.versions.bun ? [] : ['--experimental-strip-types'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      const exited = once(child, 'exit');
      try {
        const init = await Promise.race([once(child,'message').then(x=>x[0] as Metrics & {url:string}), exited.then(()=>{throw Error('Server exited during startup');})]);
        const cases: Case[] = [{ name:'small-64-routes',path:'/route63',size:2,status:200,n:count,value:'OK' }, { name:'sse',path:'/events',size:22,status:200,n:Math.min(500,count),value:'data: one\n\ndata: two\n\n' }];
        if (mode !== 'api') {
          const conditional = (await get(init.url,'/asset.js',{},200,24,'export const value = 42;')).etag!;
          assert.ok(conditional, 'Missing representation validator');
          cases.push({name:'conditional',path:'/asset.js',size:0,status:304,n:count,headers:{'if-none-match':conditional}}, {name:'range-64KiB',path:'/media.bin',size:65536,status:206,n:Math.min(400,count),headers:{range:'bytes=65536-131071'}}, {name:'media-4MiB',path:'/media.bin',size:4194304,status:200,n:Math.min(48,count)});
        }
        for (const c of cases) {
          async function batch(n: number) {
            let next=0, bytes=0; const latencies:number[]=[];
            await Promise.all(Array.from({length:Math.min(concurrency,n)},async()=>{for(;;){if(next++>=n)return; const r=await get(init.url,c.path,c.headers??{},c.status,c.size,c.value); bytes+=r.bytes; latencies.push(r.elapsed);}}));
            return {bytes,latencies};
          }
          await batch(Math.min(c.n, c.name==='media-4MiB'?8:256));
          const before=await snap(child); const begin=performance.now(); const {bytes,latencies}=await batch(c.n); const elapsed=(performance.now()-begin)/1000; const after=await snap(child);
          latencies.sort((a,b)=>a-b);
          const result={mode,round:round+1,case:c.name,requests:c.n,concurrency,requestsPerSecond:Math.round(c.n/elapsed),mibPerSecond:bytes/elapsed/1048576,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95),p99Ms:percentile(latencies,.99),cpuUsPerRequest:(after.cpuUs-before.cpuUs)/c.n,rssMiB:after.rss/1048576,peakRssMiB:after.peakRss/1048576,fds:after.fds};
          results.push(result); console.log(JSON.stringify(result));
        }
      } finally { agent.destroy(); if(child.connected)child.send('stop'); else child.kill(); await exited; }
    }
  }
  await mkdir('output/bench',{recursive:true}); await writeFile('output/bench/results.json',JSON.stringify({node:process.versions.node,bun:process.versions.bun??null,platform:process.platform,rounds,frameworkVersions:installed,results},null,2));
} finally {agent.destroy();await rm(root,{recursive:true,force:true});}
