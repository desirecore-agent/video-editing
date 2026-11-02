"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process"),{EventEmitter}=require("node:events"),{PassThrough}=require("node:stream");
test("profile preflight retains its default cleanup but leaves caller-owned registered artifacts to the original job",async()=>{
 const original=cp.spawn,load=require.resolve("../encode-profiles");let spawned;
 cp.spawn=(command,args)=>{assert.equal(command,"ffmpeg");const proc=new EventEmitter();proc.stderr=new PassThrough();proc.kill=()=>{};spawned={proc,args,out:args[args.length-1]};fs.writeFileSync(spawned.out,"unit preflight bytes; never encoded");setImmediate(()=>proc.emit("close",0));return proc;};
 delete require.cache[load];
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"fablecut-profile-owner-"));
 try{
  const {dryRunProfile}=require("../encode-profiles"),profile={extension:".mp4",args:[]};
  assert.equal((await dryRunProfile(profile,{hasAudio:false})).ok,true);const defaultDir=path.dirname(spawned.out);assert.equal(fs.existsSync(defaultDir),false,"default helper still cleans its own generated directory");
  const out=path.join(root,"probe.mp4");fs.writeFileSync(out,"");let observed;
  assert.equal((await dryRunProfile(profile,{hasAudio:false,directory:root,outPath:out,onProcess:proc=>observed=proc})).ok,true);
  assert.equal(observed,spawned.proc);assert.equal(spawned.out,out);assert.equal(fs.readFileSync(out,"utf8"),"unit preflight bytes; never encoded");assert.equal(fs.existsSync(root),true,"only the original job cleanup owns the caller directory");
 }finally{cp.spawn=original;delete require.cache[load];fs.rmSync(root,{recursive:true,force:true});}
});
