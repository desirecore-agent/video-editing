#!/usr/bin/env node
"use strict";
// Check the actual installed source package; never publish, start an application, or fetch native dependencies.
const fs=require("fs"),os=require("os"),path=require("path"),{spawn,spawnSync}=require("child_process");
const ROOT=path.resolve(__dirname,"../.."),pkg=require(path.join(ROOT,"package.json"));
function command(bin,args,opts={}){const r=spawnSync(bin,args,{cwd:ROOT,encoding:"utf8",windowsHide:true,...opts});if(r.error||r.status!==0)throw Error(bin+" failed: "+(r.error?.message||r.stderr||r.stdout));return r.stdout;}
function inspect(dir,{installed=true}={}){
 const metadata=JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8"));
 if(metadata.name!=="@desirecore-agent/video-editing"||metadata.version!==pkg.version||metadata.private!==true||metadata.mcpName)throw Error("Fork metadata or publication boundary invalid");
 const required=["server.js","mcp-server.js","cli.js","managed-runtime.js","project-store.js","export-snapshot.js","docs/editor-guide.md","desirecore/cli.mjs","desirecore/start.js","desirecore/runtime-resolver.js","desirecore/setup-runtime.js","desirecore/runtime.schema.json","desirecore/runtime-file.schema.json","desirecore/runtime-assets.schema.json","desirecore/runtime-assets.json","desirecore/RUNTIME.md","AGENTS.md","NOTICE.md","LICENSE"];
 for(const p of required)if(!fs.statSync(path.join(dir,p)).isFile())throw Error("Installed runtime file missing: "+p);
 for(const p of [...(installed?["test","node_modules"]:[]),"CLAUDE.md","desirecore/POC.md",".mcp.json","server.json","glama.json"])if(fs.existsSync(path.join(dir,p)))throw Error("Non-runtime/upstream metadata leaked into package: "+p);
 const html=fs.readFileSync(path.join(dir,"index.html"),"utf8");
 for(const [,p]of html.matchAll(/(?:src|href)=["']\/?([^"'#:?]+)["']/g))if(!/^https?:/.test(p)&&!fs.existsSync(path.join(dir,p)))throw Error("Installed page dependency missing: "+p);
 for(const p of fs.readdirSync(dir).filter(p=>p.endsWith(".js"))){command(process.execPath,["--check",path.join(dir,p)]);const src=fs.readFileSync(path.join(dir,p),"utf8");for(const[,ref]of src.matchAll(/require\(["'](\.\/[^"']+)["']\)/g))if(!fs.existsSync(path.resolve(dir,ref))&&!fs.existsSync(path.resolve(dir,ref+".js")))throw Error("Installed require missing: "+ref);}
 for(const p of fs.readdirSync(path.join(dir,"desirecore")).filter(p=>p.endsWith(".js")))command(process.execPath,["--check",path.join(dir,"desirecore",p)]);
 if(command(process.execPath,[path.join(dir,"cli.js"),"--version"]).trim()!==pkg.version)throw Error("Installed CLI version is stale");
 const {readPayload,manifestFor}=require(path.join(dir,"desirecore/release.js"));manifestFor(readPayload(dir));
 const {assetsFor}=require(path.join(dir,"desirecore/runtime-resolver.js"));for(const key of ["darwin-arm64","darwin-x64","win32-x64","linux-x64","linux-arm64"]){const at=key.lastIndexOf("-");assetsFor(key.slice(0,at),key.slice(at+1));}
}
function mcpTools(dir){return new Promise((resolve,reject)=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),"video-editing-mcp-check-")),child=spawn(process.execPath,[path.join(dir,"mcp-server.js")],{cwd:dir,env:{...process.env,FABLECUT_DATA_DIR:data,FABLECUT_NO_FS_WATCH:"1",FABLECUT_MANAGED:"1",FABLECUT_NO_AUTOSTART:"1"},stdio:["pipe","pipe","pipe"],windowsHide:true});let buffer="",errors="",done=false;
 const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);child.kill();child.once("close",()=>{fs.rmSync(data,{recursive:true,force:true});error?reject(error):resolve(result);});};
 const timer=setTimeout(()=>finish(Error("MCP list timed out: "+errors.slice(-2000))),20000);
 child.on("error",e=>finish(e));child.on("exit",code=>{if(!done)finish(Error("MCP exited before listing: "+code+" "+errors.slice(-1000)));});child.stderr.on("data",c=>errors+=c);
 child.stdout.setEncoding("utf8");child.stdout.on("data",c=>{buffer+=c;let i;while((i=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;let response;try{response=JSON.parse(line);}catch{return finish(Error("MCP stdout is not JSON"));}if(response.id===1){if(response.result?.serverInfo?.version!==pkg.version)return finish(Error("MCP version mismatch"));child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list"})+"\n");}if(response.id===2){const tools=response.result?.tools;if(!Array.isArray(tools)||!tools.length)return finish(Error("No MCP tools"));const expected=JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"))).tools.map(t=>t.name).sort();if(JSON.stringify(expected)!==JSON.stringify(tools.map(t=>t.name).sort()))return finish(Error("MCP tools differ from manifest"));if(tools.some(t=>!t.description||t.inputSchema?.type!=="object"))return finish(Error("MCP tool contract missing"));finish(null,{tools:tools.length});}}});
 child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"delivery-check",version:"1"}}})+"\n");
});}
async function main(){const i=process.argv.indexOf("--installed");if(i>=0){const dir=path.resolve(process.argv[i+1]);inspect(dir);console.log(JSON.stringify({installed:dir,...await mcpTools(dir)}));return;}
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"video-editing-package-check-"));try{inspect(ROOT,{installed:false});const npm=process.platform==="win32"?"npm.cmd":"npm",pack=JSON.parse(command(npm,["pack","--json","--ignore-scripts","--pack-destination",scratch]));const target=path.join(scratch,"installed");fs.mkdirSync(target);command(npm,["install","--prefix",target,"--no-audit","--no-fund","--ignore-scripts",path.join(scratch,pack[0].filename)]);const installed=path.join(target,"node_modules/@desirecore-agent/video-editing");inspect(installed);console.log(JSON.stringify({package:pack[0].filename,files:pack[0].entryCount,...await mcpTools(installed)}));}finally{fs.rmSync(scratch,{recursive:true,force:true});}}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={inspect,mcpTools};
