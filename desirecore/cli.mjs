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
export const HELP=`视频剪辑 0.1.2
node desirecore/cli.mjs start --data-dir <owned application data>
node desirecore/cli.mjs setup-runtime --data-dir <owned application data>
node desirecore/cli.mjs status|identity|mcp --runtime-file <actual runtime response snapshot.json>

status, identity and mcp never install or start an application. A runtime-file is a connection hint from actual owner responses, not authorization. It contains dataDir, port, instanceId, scopeId, runtimeGeneration and releaseDigest; no credentials or runtime proof.`;
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
 if(command==='setup-runtime'){const {dataRoot,setupRuntime}=require('./runtime-resolver.js');const runtime=await setupRuntime(dataRoot(rest));console.log(JSON.stringify({target:runtime.receipt.target,root:runtime.root}));return;}
 if(command==='start'){const {dataRoot,applyRuntime}=require('./runtime-resolver.js');const home=dataRoot(rest);applyRuntime(home);if(process.env.APP_DATA_DIR||process.env.APP_DATA_ROOT)process.env.FABLECUT_MANAGED='1';require('../server.js');return;}
 if(!['status','identity','mcp'].includes(command))throw Error('Unknown command: '+command);
 const i=rest.indexOf('--runtime-file'),data=readRuntimeFile(i<0?undefined:rest[i+1]);const actual=await verifiedRuntime(data);
 if(command!=='mcp'){console.log(JSON.stringify({status:'running',...actual},null,2));return;}
 require('./runtime-resolver.js').applyRuntime(data.dataDir);
 Object.assign(process.env,bindingEnvironment(data));
 require('../mcp-server.js');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
