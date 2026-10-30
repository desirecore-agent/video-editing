"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("fs"),os=require("os"),path=require("path"),{spawnSync}=require("child_process");
const {readPayload,manifestFor,verifyFixedRelease}=require("../desirecore/release");
function fixedMaterial(root,payload=readPayload()){
 fs.mkdirSync(root,{recursive:true});
 for(const file of payload){const output=path.join(root,file.path);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,file.bytes);}
 const manifest=manifestFor(payload);fs.writeFileSync(path.join(root,"app-release.json"),JSON.stringify(manifest,null,2));return manifest;
}
test("no CLI command and status without a runtime file never start a service",()=>{
 const root=path.resolve(__dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"ve-cli-empty-"));
 try{
  const r=spawnSync(process.execPath,[path.join(root,"desirecore/cli.mjs")],{cwd:tmp,encoding:"utf8"});assert.equal(r.status,0);assert.match(r.stdout,/never install or start/);assert.deepEqual(fs.readdirSync(tmp),[]);
  const bad=spawnSync(process.execPath,[path.join(root,"desirecore/cli.mjs"),"status"],{cwd:tmp,encoding:"utf8"});assert.equal(bad.status,1);assert.match(bad.stderr,/runtime-file is required/);assert.deepEqual(fs.readdirSync(tmp),[]);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test("matching fixed material accepts only the same managed peer and never returns runtime proof",async()=>{
 const {verifiedRuntime}=await import("../desirecore/cli.mjs"),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"ve-cli-peer-"));
 try{
  const materialRoot=path.join(tmp,"material"),manifest=fixedMaterial(materialRoot),dataDir=path.join(tmp,"data");fs.mkdirSync(dataDir);
  const data={schemaVersion:1,dataDir:fs.realpathSync(dataDir),port:7777,instanceId:"actual-instance",scopeId:"actual-scope",runtimeGeneration:"actual-generation",releaseDigest:manifest.releaseDigest};
  let peer={...data,managed:true,pid:123},identityOverride={};
  const fetch=async(url,options)=>{assert.equal(options.headers["x-fablecut-expected-release"],data.releaseDigest);return new Response(JSON.stringify(url.endsWith("/instance")?peer:{...peer,...identityOverride,proof:"do-not-expose"}));};
  const actual=await verifiedRuntime(data,{fetch,materialRoot});assert.equal(actual.instanceId,data.instanceId);assert.equal(actual.proof,undefined);
  for(const key of ["instanceId","scopeId","runtimeGeneration","releaseDigest"]){peer={...data,managed:true,[key]:"stale"};await assert.rejects(verifiedRuntime(data,{fetch,materialRoot}),/service identity does not match/);}
  for(const managed of [false,undefined]){peer={...data,pid:123};if(managed!==undefined)peer.managed=managed;await assert.rejects(verifiedRuntime(data,{fetch,materialRoot}),/service identity does not match/);}
  peer={...data,managed:true,pid:123};
  for(const key of ["scopeId","runtimeGeneration","releaseDigest"]){identityOverride={[key]:"stale-binding"};await assert.rejects(verifiedRuntime(data,{fetch,materialRoot}),/service identity does not match/);}
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test("old client material cannot attach to a current release, or be relabeled by replacing its manifest",async()=>{
 const {verifiedRuntime}=await import("../desirecore/cli.mjs"),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"ve-cli-material-"));
 try{
  const payload=readPayload(),rootA=path.join(tmp,"release-a"),rootB=path.join(tmp,"release-b"),manifestA=fixedMaterial(rootA,payload);
  const changed=payload.map(file=>({...file,bytes:file.path==="mcp-server.js"?Buffer.concat([file.bytes,Buffer.from("\n// Different fixed implementation B.\n")]):file.bytes}));
  const manifestB=fixedMaterial(rootB,changed);assert.notEqual(manifestA.releaseDigest,manifestB.releaseDigest);
  const data={releaseDigest:manifestB.releaseDigest};let networkRequests=0;const fetch=async()=>{networkRequests++;throw Error("must not contact or import another implementation");};
  await assert.rejects(verifiedRuntime(data,{fetch,materialRoot:rootA}),/material release does not match/);assert.equal(networkRequests,0);
  fs.copyFileSync(path.join(rootB,"app-release.json"),path.join(rootA,"app-release.json"));
  await assert.rejects(verifiedRuntime(data,{fetch,materialRoot:rootA}),/material changed/);assert.equal(networkRequests,0);
  assert.equal(verifyFixedRelease(rootB,manifestB.releaseDigest).releaseDigest,manifestB.releaseDigest);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test("source-only draft cannot substitute for a fixed material manifest",()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"ve-cli-draft-"));
 try{fs.mkdirSync(path.join(tmp,"desirecore"));fs.writeFileSync(path.join(tmp,"desirecore/app-release.json"),JSON.stringify(manifestFor(readPayload())));assert.throws(()=>verifyFixedRelease(tmp),/source drafts cannot attach/);}
 finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
