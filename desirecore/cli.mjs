#!/usr/bin/env node
/** Thin entry point around the retained CJS editor. Only explicit start/setup commands have side effects. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const ROOT=fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const ManagedRuntime=require('../managed-runtime.js');
const {verifyFixedRelease}=require('./release.js');
export const HELP=`视频剪辑 ${require('../package.json').version}
node desirecore/cli.mjs start --data-dir <owned application data>
node desirecore/cli.mjs setup-runtime --data-dir <owned application data>
node desirecore/cli.mjs connection --binding-file <actual AppAuthoring runtime_read response.json>
node desirecore/cli.mjs status|identity|mcp|mcp-config --runtime-file <actual runtime response snapshot.json>
node desirecore/cli.mjs docs [--section <manual heading>]

status, identity, connection, mcp-config, docs and mcp never install or start an application. A runtime-file is a connection hint from actual owner responses, not authorization. It contains dataDir, port, instanceId, scopeId, runtimeGeneration and releaseDigest; no credentials or runtime proof. connection writes that snapshot to stdout after matching the platform binding to the existing service. Configure the returned MCP entry through the existing authorized MCP configuration flow; association alone does not configure tools.`;
function readConnectionJSON(file){
 if(!file)throw Error('A connection JSON file is required');
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('Connection input must be a regular JSON file of at most 64 KiB');
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
export async function connectionFromBinding(input,{fetch:fetchImpl=fetch,materialRoot=ROOT}={}){
 const binding=(input?.data??input)?.binding;
 if(!binding||binding.schemaVersion!==1||binding.providerId!=='task-host'||binding.health!=='healthy'
   || typeof binding.runtimeGeneration!=='string'||!binding.runtimeGeneration
   || !/^[a-f0-9]{64}$/.test(binding.releaseDigest))throw Error('Use the healthy binding from the actual AppAuthoring runtime_read response; repair/start the application through its original owner first');
 const scopeId=binding.scope?.kind==='installation'?binding.scope.installationId:binding.scope?.kind==='preview'?binding.scope.previewId:null;
 if(typeof scopeId!=='string'||!scopeId)throw Error('Runtime binding has no current installation/preview scope');
 const url=new URL(binding.url);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||url.username||url.password||url.hash)
   throw Error('Video-editing connection requires the actual local HTTP task-host binding');
 verifyFixedRelease(materialRoot,binding.releaseDigest);
 const response=await fetchImpl(url.origin+'/api/desirecore/instance',{signal:AbortSignal.timeout(5000),redirect:'error'});
 if(response.status!==200)throw Error('Existing editor instance unavailable; inspect AppAuthoring runtime_read before recovery');
 const text=await response.text();if(Buffer.byteLength(text)>65536)throw Error('Runtime instance exceeds 64 KiB');
 const instance=JSON.parse(text);
 if(instance.managed!==true||instance.scopeId!==scopeId||instance.runtimeGeneration!==binding.runtimeGeneration||instance.releaseDigest!==binding.releaseDigest)
   throw Error('Existing service does not match the platform managed binding; use the original runtime owner to repair/start it, never invent identity fields');
 const snapshot={schemaVersion:1,dataDir:instance.dataDir,port:Number(url.port),instanceId:instance.instanceId,scopeId,runtimeGeneration:binding.runtimeGeneration,releaseDigest:binding.releaseDigest};
 return verifiedRuntime(snapshot,{fetch:fetchImpl,materialRoot});
}
export function readRuntimeFile(file){
 if(!file)throw Error('--runtime-file is required; obtain current facts from the installed application owner');
 file=path.resolve(file);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('runtime-file must be a regular JSON file of at most 64 KiB');
 const data=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!data||data.schemaVersion!==1||typeof data.dataDir!=='string'||!path.isAbsolute(data.dataDir)||!Number.isSafeInteger(data.port)||data.port<1||data.port>65535)throw Error('runtime-file data root/port/schema is invalid');
 for(const key of ['instanceId','scopeId','runtimeGeneration','releaseDigest'])if(typeof data[key]!=='string'||!data[key]||data[key].length>512)throw Error('runtime-file missing actual '+key);
 if(!/^[a-f0-9]{64}$/.test(data.releaseDigest))throw Error('runtime-file releaseDigest is not SHA-256');
 return data;
}
function bindingEnvironment(data){
 return{APP_DATA_DIR:data.dataDir,PORT:String(data.port),FABLECUT_MANAGED:'1',FABLECUT_NO_AUTOSTART:'1',FABLECUT_EXPECTED_INSTANCE_ID:data.instanceId,FABLECUT_EXPECTED_SCOPE_ID:data.scopeId,FABLECUT_EXPECTED_RUNTIME_GENERATION:data.runtimeGeneration,FABLECUT_EXPECTED_RELEASE_DIGEST:data.releaseDigest};
}
export async function verifiedRuntime(data,{fetch:fetchImpl=fetch,materialRoot=ROOT}={}){
 // A runtime-file describes the live peer; it cannot bless a different local CLI/MCP implementation.
 verifyFixedRelease(materialRoot,data.releaseDigest);
 const env=bindingEnvironment(data);
 const get=async endpoint=>{const response=await fetchImpl('http://127.0.0.1:'+data.port+endpoint,{headers:ManagedRuntime.requestHeaders(env),signal:AbortSignal.timeout(5000),redirect:'error'});if(response.status!==200)throw Error('Installed runtime unavailable: '+endpoint+' HTTP '+response.status);const text=await response.text();if(Buffer.byteLength(text)>65536)throw Error('Runtime identity exceeds 64 KiB');return JSON.parse(text);};
 const instance=await get('/api/desirecore/instance');
 ManagedRuntime.verifyService(instance,data.dataDir,data.port,env);
 const identity=await get('/api/desirecore/runtime-identity');
 ManagedRuntime.verifyService({...instance,scopeId:identity.scopeId,runtimeGeneration:identity.runtimeGeneration,releaseDigest:identity.releaseDigest},data.dataDir,data.port,env);
 // Proof is intentionally not returned or persisted; platform authority still belongs to the real owner.
 return{schemaVersion:1,instanceId:instance.instanceId,dataDir:instance.dataDir,port:instance.port,scopeId:identity.scopeId,runtimeGeneration:identity.runtimeGeneration,releaseDigest:identity.releaseDigest,pid:instance.pid};
}
export async function main(args=process.argv.slice(2)){
 const [command,...rest]=args;
 if(!command||command==='help'||command==='--help'||command==='-h'){console.log(HELP);return;}
 if(command==='--version'||command==='-v'){console.log(require('../package.json').version);return;}
 if(command==='docs'){
  const manual=fs.readFileSync(path.join(ROOT,'docs/editor-guide.md'),'utf8'),i=rest.indexOf('--section');
  const section=i<0?'':String(rest[i+1]||'').toLowerCase();
  const parts=manual.split(/^(?=## )/m).filter(p=>!section||p.startsWith('## ')&&p.slice(0,p.indexOf('\n')).toLowerCase().includes(section));
  if(!parts.length)throw Error('Manual section not found');console.log(parts.join('\n'));return;
 }
 if(command==='connection'){
  const i=rest.indexOf('--binding-file');
  if(i<0||!rest[i+1])throw Error('--binding-file is required; save the actual AppAuthoring runtime_read response');
  console.log(JSON.stringify(await connectionFromBinding(readConnectionJSON(rest[i+1])),null,2));return;
 }
 if(command==='setup-runtime'){const {dataRoot,setupRuntime}=require('./runtime-resolver.js');const runtime=await setupRuntime(dataRoot(rest));console.log(JSON.stringify({target:runtime.receipt.target,root:runtime.root}));return;}
 if(command==='start'){const {dataRoot,applyRuntime}=require('./runtime-resolver.js');const home=dataRoot(rest);applyRuntime(home);if(process.env.APP_DATA_DIR||process.env.APP_DATA_ROOT)process.env.FABLECUT_MANAGED='1';require('../server.js');return;}
 if(!['status','identity','mcp','mcp-config'].includes(command))throw Error('Unknown command: '+command);
 const i=rest.indexOf('--runtime-file'),data=readRuntimeFile(i<0?undefined:rest[i+1]);const actual=await verifiedRuntime(data);
 if(command==='mcp-config'){console.log(JSON.stringify({command:process.execPath,args:[path.join(ROOT,'desirecore/cli.mjs'),'mcp','--runtime-file',path.resolve(rest[i+1])],cwd:ROOT},null,2));return;}
 if(command!=='mcp'){console.log(JSON.stringify({status:'running',...actual},null,2));return;}
 require('./runtime-resolver.js').applyRuntime(data.dataDir);
 Object.assign(process.env,bindingEnvironment(data));
 require('../mcp-server.js');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
