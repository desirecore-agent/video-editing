#!/usr/bin/env node
// Explicit owned blank-page heap observation; no editor, project or movie.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createBrowserProcess}=require('../../browser-process.js'),{checkedRuntime}=require('../../desirecore/runtime-resolver.js');
const option=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];},data=option('--data-dir'),destination=option('--out');assert(data&&destination);
const runtime=checkedRuntime(path.resolve(data)),out=path.resolve(destination),profileDir=out+'/profile';await fs.mkdir(out);await fs.mkdir(profileDir);
const browser=createBrowserProcess(runtime.chrome,['--headless=new','--enable-gpu','--user-data-dir='+profileDir,'--no-first-run','--no-default-browser-check','--disable-extensions','--mute-audio','--window-size=800,600','about:blank'],{profileDir,onTargetCrash(){},observePageMemory:'about:blank'});
const closed=new Promise(resolve=>browser.proc.once('close',(code,signal)=>resolve({code,signal})));let sequence=1000000000,buffer='';const pending=new Map();
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},20000);pending.set(id,{resolve,reject,timer});browser.proc.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});
browser.proc.stdio[4].on('data',bytes=>{buffer+=bytes;let end;while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;const event=JSON.parse(raw),p=pending.get(event.id);if(!p)continue;clearTimeout(p.timer);pending.delete(event.id);event.error?p.reject(Error(JSON.stringify(event.error))):p.resolve(event.result);}});
async function until(check){for(let n=0;n<600;n++){if(check())return;await new Promise(r=>setTimeout(r,25));}throw Error('bounded native observation did not arrive');}
let report;
try{
 await until(()=>browser.diagnostics().memory.sampleCount>=1);const {targetInfos}=await send('Target.getTargets'),target=targetInfos.find(t=>t.type==='page'&&t.url==='about:blank');assert(target);
 const {sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 const result=await send('Runtime.evaluate',{expression:'globalThis.retained = new Uint8Array(8*1024*1024); retained.fill(17); retained.byteLength',returnByValue:true},sessionId);assert.equal(result.result.value,8388608);
 await until(()=>browser.diagnostics().memory.sampleCount>=2&&browser.diagnostics().memory.samples.at(-1).backingStorageSize>=8388608);
 const beforeClose=browser.diagnostics();assert.equal(beforeClose.memory.status,'sampled');assert.equal(beforeClose.memory.stopReason,null);
 report={at:new Date().toISOString(),platform:process.platform,explicitAllocationBytes:8388608,beforeClose,scope:'Real owned blank page and numeric heap capture only. No video/failure cause/whole-process memory claim.',appExportVerified:false};
}finally{
 for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('owned fixture closed'));}pending.clear();browser.close();
 const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned browser did not close')),7000);closed.then(v=>{clearTimeout(timer);resolve(v);});});
 if(report){report.close=result;report.afterClose=browser.diagnostics();assert.equal(report.afterClose.memory.stopReason,'owner_closed');assert.equal(report.afterClose.memory.sampleCount,report.beforeClose.memory.sampleCount);assert.equal(report.afterClose.exit.ownerClosing,true);}
}
await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({report:out+'/report.json',samples:report.beforeClose.memory.sampleCount,peak:report.beforeClose.memory.peak,close:report.close,appExportVerified:false}));
