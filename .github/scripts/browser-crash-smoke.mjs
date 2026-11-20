#!/usr/bin/env node
// Explicit native browser observation only. No editor server or video export.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createBrowserProcess}=require('../../browser-process.js');
const {checkedRuntime}=require('../../desirecore/runtime-resolver.js');
const option=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const data=option('--data-dir'),destination=option('--out');
assert(data&&destination,'--data-dir <prepared data> --out <new observation directory> required');
const runtime=checkedRuntime(path.resolve(data)),out=path.resolve(destination),profileDir=path.join(out,'profile');
await fs.mkdir(out);await fs.mkdir(profileDir);
const crashes=[];
const browser=createBrowserProcess(runtime.chrome,[
 '--headless=new','--enable-gpu','--user-data-dir='+profileDir,'--no-first-run','--no-default-browser-check',
 '--disable-extensions','--mute-audio','--window-size=800,600',
 ...(process.platform==='win32'?['--disable-accelerated-video-decode']:[]),'about:blank',
],{profileDir,onTargetCrash:crash=>crashes.push(crash)});
const closed=new Promise(resolve=>browser.proc.once('close',(code,signal)=>resolve({code,signal})));
let sequence=1000,buffer='';const pending=new Map();
const send=(method,params={})=>new Promise((resolve,reject)=>{
 const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},20000);
 pending.set(id,{resolve,reject,timer});browser.proc.stdio[3].write(JSON.stringify({id,method,params})+'\0');
});
browser.proc.stdio[4].on('data',bytes=>{
 buffer+=bytes;let end;while((end=buffer.indexOf('\0'))!==-1){
  const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;
  const event=JSON.parse(raw),call=pending.get(event.id);if(!call)continue;
  pending.delete(event.id);clearTimeout(call.timer);event.error?call.reject(Error(JSON.stringify(event.error))):call.resolve(event.result);
 }
});
async function until(check){for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,25));}throw Error('original browser observation timed out');}
let report;
try{
 await until(()=>browser.diagnostics().discovery==='enabled');
 const {targetInfos}=await send('Target.getTargets'),target=targetInfos.find(t=>t.type==='page'&&t.url==='about:blank');assert(target);
 const {sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 // Deliberately crash this owned blank page. A crashed target may never reply
 // to Page.crash; the independently observed Target event is the assertion.
 browser.proc.stdio[3].write(JSON.stringify({id:++sequence,method:'Page.crash',params:{},sessionId})+'\0');
 await until(()=>crashes.some(c=>c.targetId===target.targetId));
 const observed=crashes.find(c=>c.targetId===target.targetId);assert.equal(observed.type,'page');assert.equal(observed.ownerClosing,false);
 assert.equal(browser.proc.exitCode,null,'page crash must be observable while its browser root is still live');
 report={at:new Date().toISOString(),platform:process.platform,browser:runtime.chrome,explicitInjection:'Page.crash on owned about:blank only',observed,diagnostics:browser.diagnostics(),browserRootStillLive:true,appExportVerified:false,naturalVideoFailureReproduced:false};
}finally{
 for(const call of pending.values()){clearTimeout(call.timer);call.reject(Error('fixture closed'));}pending.clear();
 browser.close();const result=await closed;
 if(report){report.close=result;report.afterClose=browser.diagnostics();assert.equal(report.afterClose.exit.ownerClosing,true);}
}
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({platform:report.platform,observed:report.observed,close:report.close,appExportVerified:false}));
