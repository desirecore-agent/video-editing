"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
function identity(env=process.env) {
  const keys=["DESIRECORE_APP_RUNTIME_PROOF","DESIRECORE_APP_RELEASE_DIGEST","DESIRECORE_APP_SCOPE_ID","DESIRECORE_APP_RUNTIME_GENERATION"];
  const values=keys.map(k=>env[k]);
  if(values.every(v=>v===undefined))return null;
  if(!values.every(v=>typeof v==="string"&&v.length>0&&v.length<=512))throw Error("platform runtime identity is incomplete or invalid");
  const [proof,releaseDigest,scopeId,runtimeGeneration]=values;
  return {proof,releaseDigest,scopeId,runtimeGeneration};
}
function managedClient(env=process.env) {
  return Boolean(env.APP_DATA_DIR || env.APP_DATA_ROOT || env.FABLECUT_MANAGED==="1");
}
const EXPECTED_FIELDS = {
  instanceId:"FABLECUT_EXPECTED_INSTANCE_ID",
  scopeId:"FABLECUT_EXPECTED_SCOPE_ID",
  runtimeGeneration:"FABLECUT_EXPECTED_RUNTIME_GENERATION",
  releaseDigest:"FABLECUT_EXPECTED_RELEASE_DIGEST",
};
const REQUEST_HEADERS = {
  instanceId:"x-fablecut-expected-instance",
  scopeId:"x-fablecut-expected-scope",
  runtimeGeneration:"x-fablecut-expected-generation",
  releaseDigest:"x-fablecut-expected-release",
};
function expectedService(env=process.env) {
  const managed=managedClient(env), expected={};
  for(const [field,key] of Object.entries(EXPECTED_FIELDS)) {
    const value=env[key];
    if(value===undefined && !managed)continue;
    if(typeof value!=="string" || !value.length || value.length>512)
      throw Error("managed MCP binding is incomplete or invalid; refresh it from the actual runtime owner");
    expected[field]=value;
  }
  return {managed,expected};
}
function verifyService(owner, dataDir, port, env=process.env) {
  const {managed,expected}=expectedService(env);
  if(!owner || owner.dataDir!==fs.realpathSync(dataDir) || owner.port!==Number(port)
    || (managed && owner.managed!==true)
    || Object.entries(expected).some(([field,value])=>owner[field]!==value))
    throw Error("editor service identity does not match the MCP data root, port or bound generation; refresh the binding through its original owner");
  return owner;
}
function requestHeaders(env=process.env) {
  const {managed,expected}=expectedService(env);
  return managed ? Object.fromEntries(Object.entries(REQUEST_HEADERS).map(([field,header])=>[header,expected[field]])) : {};
}
function verifyRequest(owner, headers) {
  if(!Object.values(REQUEST_HEADERS).some(header=>headers[header]!==undefined))return;
  if(owner.managed!==true || Object.entries(REQUEST_HEADERS).some(([field,header])=>headers[header]!==owner[field]))
    throw Object.assign(Error("editor service is a different bound generation; refresh the MCP binding through its original owner"),{code:409});
}
function serviceLease(dataDir,port) {
  // Validate before creating a lease. Partial platform injection must not be
  // silently downgraded to a standalone process or leave an empty lock behind.
  const platform=identity();
  fs.mkdirSync(dataDir,{recursive:true});
  const dir=path.join(dataDir,".fablecut-service.lockdir");
  try {fs.mkdirSync(dir);} catch(e) {
    if(e.code!=="EEXIST")throw e;
    const old=JSON.parse(fs.readFileSync(path.join(dir,"owner.json"),"utf8"));
    try {process.kill(old.pid,0);throw Error("视频剪辑 data root already has a live service: "+old.pid);}
    catch(err){if(err.code!=="ESRCH")throw err;}
    fs.unlinkSync(path.join(dir,"owner.json"));fs.rmdirSync(dir);fs.mkdirSync(dir);
  }
  const owner={instanceId:crypto.randomUUID(),pid:process.pid,dataDir:fs.realpathSync(dataDir),port:Number(port),startedAt:new Date().toISOString(),managed:Boolean(platform),...(platform?{scopeId:platform.scopeId,runtimeGeneration:platform.runtimeGeneration,releaseDigest:platform.releaseDigest}:{})};
  fs.writeFileSync(path.join(dir,"owner.json"),JSON.stringify(owner),{flag:"wx"});
  const release=()=>{try{const current=JSON.parse(fs.readFileSync(path.join(dir,"owner.json")));if(current.instanceId===owner.instanceId){fs.unlinkSync(path.join(dir,"owner.json"));fs.rmdirSync(dir);}}catch{}};
  process.once("exit",release);return {owner,release};
}
module.exports={identity,managedClient,expectedService,verifyService,requestHeaders,verifyRequest,serviceLease};
