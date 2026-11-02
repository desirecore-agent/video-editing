"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),vm=require("node:vm");
const {createRequire}=require("node:module");
const filename=require.resolve("../desirecore/runtime-resolver"),source=fs.readFileSync(filename,"utf8"),realRequire=createRequire(filename);
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
// Only the process launcher is mocked: exercise the actual resolver on every host without native downloads.
// Expose the private extraction boundary inside this isolated module, without adding a production API.
function loadResolver(spawnSync,env={SystemRoot:"C:\\Windows",PATH:"C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32"}) {
 const module={exports:{}};
 vm.runInNewContext(source+"\nmodule.exports.extractForTest=extract;",{module,exports:module.exports,__dirname:path.dirname(filename),require:id=>id==="child_process"?{spawnSync}:realRequire(id),process:{env,pid:process.pid,execPath:process.execPath,platform:process.platform,arch:process.arch},setTimeout,clearTimeout,AbortController,fetch},{filename});
 return module.exports;
}
function fixture() {
 const blobs=new Map(),assets=["ffmpeg","ffprobe","chromium"].map(id=>{
  const bytes=Buffer.from("pinned archive "+id),url="https://assets.invalid/"+id;blobs.set(url,bytes);
  return{id,url,sha256:sha(bytes),maxBytes:bytes.length,format:"zip",executable:id+"/"+id+".exe",license:"test-only",source:"https://source.invalid/fixed"};
 });
 return{manifest:{schemaVersion:1,revision:"windows-extract-test",targets:{"win32-x64":{assets}}},platform:"win32",arch:"x64",fetch:async url=>new Response(blobs.get(url))};
}
test("Windows ZIP bypasses a PATH-shadowed tar and preserves drive paths as argv",async()=>{
 const calls=[],archive="D:\\a\\_temp\\video editing & (runtime)\\chromium.zip",stage="D:\\a\\_temp\\video editing & (runtime)\\stage";
 const resolver=loadResolver((command,args,options)=>{
  calls.push({command,args:[...args],options});
  // Reproduce the observed GNU tar failure if the old unqualified command is ever used.
  if(command==="tar.exe")return{status:1,stderr:"tar: Cannot connect to D: resolve failed"};
  assert.equal(command,"C:\\Windows\\System32\\tar.exe");
  return{status:0,stderr:""};
 });
 await resolver.extractForTest({format:"zip"},archive,stage,"win32");
 assert.equal(calls.length,1);assert.deepEqual(calls[0].args,["-xf",archive,"-C",stage]);
 assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.windowsHide,true);assert.equal(calls[0].options.timeout,120_000);
});
test("Windows ZIP uses the configured system drive rather than a hardcoded C drive",async()=>{
 const resolver=loadResolver((command,args)=>{assert.equal(command,"E:\\Windows Custom\\System32\\tar.exe");assert.deepEqual([...args],["-xf","D:\\archive.zip","-C","F:\\stage"]);return{status:0};},{SystemRoot:"E:\\Windows Custom",PATH:"C:\\shadow"});
 await resolver.extractForTest({format:"zip"},"D:\\archive.zip","F:\\stage","win32");
});
test("Windows ZIP refuses missing or drive-relative SystemRoot without consulting PATH",async()=>{
 for(const root of [undefined,"","Windows","C:Windows","\\Windows"]) {
  let calls=0;const resolver=loadResolver(()=>{calls++;return{status:0};},{SystemRoot:root,PATH:"C:\\shadow"});
  await assert.rejects(resolver.extractForTest({format:"zip"},"D:\\archive.zip","D:\\stage","win32"),/drive-absolute SystemRoot/);
  assert.equal(calls,0);
 }
});
test("missing or failing native Windows tar does not fall back or publish runtime",async()=>{
 for(const result of [{status:null,error:Object.assign(Error("native tar missing"),{code:"ENOENT"})},{status:2,stderr:"native tar could not extract archive"}]) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"ve-win-extract-fail-"));let calls=0;
  const resolver=loadResolver(command=>{calls++;assert.equal(command,"C:\\Windows\\System32\\tar.exe");return result;});
  try {
   await assert.rejects(resolver.setupRuntime(home,fixture()),/Runtime extraction failed: C:\\Windows\\System32\\tar.exe: (native tar missing|native tar could not extract archive)/);
   assert.equal(calls,1);assert.deepEqual(fs.readdirSync(path.join(home,"runtime")),[]);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 }
});
test("Windows ZIP hash mismatch is rejected before invoking the native extractor",async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"ve-win-extract-hash-")),options=fixture();let calls=0;
 options.manifest.targets["win32-x64"].assets[0].sha256="0".repeat(64);
 const resolver=loadResolver(()=>{calls++;return{status:0};});
 try {
  await assert.rejects(resolver.setupRuntime(home,options),/Runtime SHA-256 mismatch/);
  assert.equal(calls,0);assert.deepEqual(fs.readdirSync(path.join(home,"runtime")),[]);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
