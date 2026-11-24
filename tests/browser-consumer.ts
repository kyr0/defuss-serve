/** Runs against the installed package, not source files. Local system Chromium via CDP, CI via Playwright. */
import assert from 'node:assert/strict';
import { createServer } from 'defuss-serve';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
async function probe() {
  const video = document.createElement('video');
  video.preload = 'metadata'; video.muted = true; document.body.append(video);
  const file = video.canPlayType('video/mp4; codecs="avc1.42E01E"') ? '/seek.mp4' : '/seek.webm';
  const event = (name: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Media event timeout: ${name}`)), 12000);
    video.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(Error(video.error?.message ?? 'Media error')); }, { once: true });
  });
  const loaded = event('loadedmetadata'); video.src = file; await loaded;
  const duration = video.duration;
  const seeking = event('seeked'); video.currentTime = Math.min(9, duration - 0.5); await seeking;
  const position = video.currentTime;
  const range = await fetch(file, { headers: { Range: 'bytes=128-255' } });
  return { file, duration, position, seeking: video.seeking, status: range.status, contentRange: range.headers.get('content-range'), bytes: (await range.arrayBuffer()).byteLength };
}
interface Result { file: string; duration: number; position: number; seeking: boolean; status: number; contentRange: string; bytes: number }
function verify(result: Result, responses: number[]) {
  assert.ok(result.duration > 10 && result.duration < 13); assert.ok(Math.abs(result.position - 9) < 0.1); assert.equal(result.seeking, false);
  assert.equal(result.status,206); assert.match(result.contentRange,/^bytes 128-255\/\d+$/); assert.equal(result.bytes,128);
  assert.ok(responses.includes(206), 'Browser must receive a partial media response');
}
const dir = await mkdtemp(join(tmpdir(),'serve-browser-'));
const publicDir = join(dir,'public'); await import('node:fs/promises').then(fs=>fs.mkdir(publicDir));
await writeFile(join(publicDir,'index.html'),'<!doctype html><title>defuss-serve media test</title><body><h1>Media seek</h1></body>');
for(const name of ['seek.mp4','seek.webm']) await copyFile(fileURLToPath(new URL(`./fixtures/${name}`,import.meta.url)),join(publicDir,name));
const service=createServer({port:0,publicDir,staticMode:'immutable'});
async function systemChromium(executable: string) {
  const child=spawn(executable,['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--no-proxy-server','--remote-debugging-port=0',`--user-data-dir=${join(dir,'chromium')}`,'about:blank'],{stdio:'ignore'});
  let ws: WebSocket | undefined;
  try {
    let port='';
    for(let i=0;i<100;i++){try{port=(await readFile(join(dir,'chromium','DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{if(child.exitCode!==null)throw Error('Chromium exited');await delay(100);}}
    assert.ok(port,'Chromium debugging port');
    const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{type:string;webSocketDebuggerUrl:string}>;
    const target=targets.find(t=>t.type==='page');assert.ok(target);
    ws=new WebSocket(target.webSocketDebuggerUrl);const socket=ws;
    await new Promise<void>((resolve,reject)=>{socket.addEventListener('open',()=>resolve(),{once:true});socket.addEventListener('error',reject,{once:true});});
    const responses:number[]=[];let next=0;
    const pending=new Map<number,{resolve:(value:any)=>void;reject:(reason:unknown)=>void}>();
    socket.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(m.error);else p?.resolve(m.result);}else if(m.method==='Network.responseReceived'&&/\/seek\.(mp4|webm)$/.test(m.params.response.url))responses.push(m.params.response.status);});
    const call=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    await call('Page.enable');await call('Network.enable');const navigation=await call('Page.navigate',{url:service.url!.href});if(navigation.errorText)throw Error(navigation.errorText);
    let ready=false;for(let i=0;i<100;i++){const r=await call('Runtime.evaluate',{expression:'location.href + " " + document.readyState + " " + document.title',returnByValue:true});if(String(r.result.value).startsWith(service.url!.href)&&String(r.result.value).includes('complete defuss-serve media test')){ready=true;break;}await delay(50);}assert.ok(ready,'Browser navigated to served document');
    const r=await call('Runtime.evaluate',{expression:`(${probe.toString()})()`,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));
    const result=r.result.value as Result;verify(result,responses);console.log(`System Chromium ${service.runtime} browser seek PASS ${JSON.stringify({result,responses})}`);
  }finally{ws?.close();child.kill();if(child.exitCode===null)await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}
}
try{
  await service.start();
  if(process.env.SYSTEM_CHROMIUM)await systemChromium(process.env.SYSTEM_CHROMIUM);
  else{
    const name='playwright';const pw=await import(name);
    for(const engine of ['chromium','webkit']){
      const browser=await pw[engine].launch({headless:true});
      try{const page=await browser.newPage();const responses:number[]=[];page.on('response',(res:{url():string;status():number})=>{if(/\/seek\.(mp4|webm)$/.test(res.url()))responses.push(res.status());});await page.goto(service.url!.href);const result=await page.evaluate(probe) as Result;verify(result,responses);console.log(`${engine} ${service.runtime} browser seek PASS ${JSON.stringify({result,responses})}`);}finally{await browser.close();}
    }
  }
}finally{await service.stop();await rm(dir,{recursive:true,force:true});}
