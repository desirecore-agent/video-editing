"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("fs"),os=require("os"),path=require("path"),crypto=require("crypto"),zlib=require("zlib");
const {setupRuntime,checkedRuntime,dataRoot,assetsFor,runtimeRoot}=require("../desirecore/runtime-resolver");
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(){const blobs=new Map();const assets=["ffmpeg","ffprobe","chromium"].map(id=>{const bytes=zlib.gzipSync(Buffer.from("verified "+id));const url="https://assets.invalid/"+id;blobs.set(url,bytes);return{id,url,sha256:sha(bytes),maxBytes:bytes.length,format:"gzip",executable:id+"/"+id,license:"test-only",source:"https://source.invalid/fixed"};});return{manifest:{schemaVersion:1,revision:"test-only",node:{minimumMajor:22,supply:"desirecore-managed-path"},targets:{"linux-x64":{assets}}},fetch:async url=>new Response(blobs.get(url)),blobs,platform:"linux",arch:"x64"};}
test("owner data root wins over standalone argv and environment",()=>{assert.equal(dataRoot(["--data-dir","/ignored"],{APP_DATA_DIR:"/owner",FABLECUT_DATA_DIR:"/old"}),path.resolve("/owner"));assert.throws(()=>dataRoot([],{}),/owned data root/);});
test("native cache publishes only after all archive hashes match, then detects changed bytes",async()=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),"ve-runtime-")),opts=fixture();try{const runtime=await setupRuntime(home,opts);assert.equal(fs.readFileSync(runtime.ffmpeg,"utf8"),"verified ffmpeg");assert.equal(runtime.receipt.target,"linux-x64");assert.equal((await setupRuntime(home,opts)).root,runtime.root);fs.writeFileSync(runtime.chrome,"changed");assert.throws(()=>checkedRuntime(home,opts),/content changed/);}finally{fs.rmSync(home,{recursive:true,force:true});}});
test("mismatched download hash leaves no published runtime or owned staging lock",async()=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),"ve-runtime-fail-")),opts=fixture();opts.manifest.targets['linux-x64'].assets[1].sha256="0".repeat(64);try{await assert.rejects(setupRuntime(home,opts),/SHA-256 mismatch/);assert.deepEqual(fs.readdirSync(path.join(home,"runtime")),[]);}finally{fs.rmSync(home,{recursive:true,force:true});}});
test("all declared native OS/architecture targets are pinned and unknown targets fail",()=>{for(const [platform,arch]of [["darwin","arm64"],["darwin","x64"],["win32","x64"],["linux","x64"],["linux","arm64"]])assert.equal(assetsFor(platform,arch).key,platform+"-"+arch);assert.throws(()=>assetsFor("win32","arm64"),/not a supported/);});
test("the pinned browser fits Chromium startup buffers under the observed managed data-root length",()=>{
 const {manifest,target}=assetsFor("win32","x64"),home="C:\\"+"d".repeat(170);
 const executable=target.assets.find(a=>a.id==="chromium").executable;
 const browser=m=>path.win32.toNamespacedPath(path.win32.join(runtimeRoot(home,m),executable));
 const current=browser(manifest),icu=path.win32.join(path.win32.dirname(current),"icudtl.dat");
 assert.ok(current.length<260,current);assert.ok(icu.length<260,icu);
 // This is the original cache layout that reproduced the native initialization crash.
 const previous=browser({...manifest,revision:"20261030-cft156-ffmpeg-b6.1.1"});
 assert.ok(previous.length>=260);assert.ok(path.win32.join(path.win32.dirname(previous),"icudtl.dat").length>=260);
});
test("overlong Windows browser paths fail before download, directory creation or receipt access",async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),"ve-runtime-path-limit-"));
 try{
  for(const name of ["x".repeat(240),"🎬".repeat(120)]){
   const home=path.join(base,name),opts=fixture();let downloads=0;
   opts.manifest.targets["win32-x64"]=opts.manifest.targets["linux-x64"];opts.platform="win32";
   opts.fetch=async()=>{downloads++;throw Error("download must not begin");};
   await assert.rejects(setupRuntime(home,opts),/Chromium's startup limit/);
   assert.throws(()=>checkedRuntime(home,opts),/Chromium's startup limit/);
   assert.equal(downloads,0);assert.equal(fs.existsSync(home),false);
  }
  assert.deepEqual(fs.readdirSync(base),[]);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
