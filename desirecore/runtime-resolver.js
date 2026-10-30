"use strict";
// Source-only runtime adapter. Native assets are prepared explicitly under the app-owned data root.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable, Transform } = require("stream");
const { createGunzip } = require("zlib");
const MANIFEST = path.join(__dirname, "runtime-assets.json");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function dataRoot(args=[],env=process.env) {
 const at=args.indexOf("--data-dir"), explicit=at<0?null:args[at+1];
 const value=env.APP_DATA_DIR||env.APP_DATA_ROOT||explicit||env.FABLECUT_DATA_DIR;
 if(!value)throw Error("Choose an owned data root with --data-dir, or use the owner-provided APP_DATA_DIR");
 return path.resolve(value);
}
function assetsFor(platform=process.platform,arch=process.arch,manifest=JSON.parse(fs.readFileSync(MANIFEST,"utf8"))) {
 if(manifest.schemaVersion!==1||!/^[A-Za-z0-9._-]+$/.test(manifest.revision)||!["darwin","linux","win32"].includes(platform)||!["arm64","x64"].includes(arch))throw Error("Invalid runtime manifest or unsupported target");
 const key=platform+"-"+arch,target=manifest.targets[key];
 if(!target)throw Error("No pinned runtime for "+key+"; this architecture is not a supported native target");
 const relative=p=>typeof p==="string"&&p.length>0&&!p.startsWith("/")&&!p.includes("\\")&&p.split("/").every(part=>part&&part!=="."&&part!=="..");
 const ids=new Set();
 for(const asset of target.assets){if(ids.has(asset.id)||!/^[A-Za-z0-9._-]+$/.test(asset.id)||!/^[a-f0-9]{64}$/.test(asset.sha256)||!asset.url.startsWith("https://")||!Number.isSafeInteger(asset.maxBytes)||asset.maxBytes<1||asset.maxBytes>1073741824||!relative(asset.executable)||!["gzip","zip","text"].includes(asset.format))throw Error("Unpinned or invalid runtime asset: "+asset.id);ids.add(asset.id);}
 for(const id of ["ffmpeg","ffprobe","chromium"])if(!ids.has(id))throw Error("Missing pinned runtime asset: "+id);
 for(const p of target.requiredNotices||[])if(!relative(p))throw Error("Invalid runtime notice path");
 return{key,manifest,target};
}
function runtimeRoot(home,manifest) {return path.join(home,"runtime","video-editing-"+manifest.revision);}
function fileRecord(root,relative) {
 const file=path.join(root,relative), stat=fs.lstatSync(file);
 if(stat.isSymbolicLink())return{path:relative,link:fs.readlinkSync(file)};
 if(!stat.isFile())throw Error("Expected runtime file: "+relative);
 return{path:relative,size:stat.size,sha256:digest(fs.readFileSync(file))};
}
function collectFiles(root,relative="",out=[]) {
 for(const name of fs.readdirSync(path.join(root,relative)).sort()){
 const p=relative?relative+"/"+name:name;if(p==="receipt.json")continue;
 const stat=fs.lstatSync(path.join(root,p));if(stat.isDirectory()&&!stat.isSymbolicLink())collectFiles(root,p,out);else out.push(fileRecord(root,p));
 }return out;
}
function checkedRuntime(home,options={}) {
 const {key,manifest,target}=assetsFor(options.platform,options.arch,options.manifest), root=runtimeRoot(home,manifest), receipt=JSON.parse(fs.readFileSync(path.join(root,"receipt.json"),"utf8"));
 if(receipt.manifestDigest!==digest(JSON.stringify(manifest))||receipt.target!==key)throw Error("Runtime receipt does not match the pinned manifest and target");
 const actual=collectFiles(root);if(JSON.stringify(actual)!==JSON.stringify(receipt.files))throw Error("Runtime cache content changed; prepare a fresh verified runtime");
 const executable=name=>{const asset=target.assets.find(a=>a.id===name);const file=path.join(root,asset.executable);if(!fs.statSync(file).isFile())throw Error("Missing runtime executable: "+name);return file;};
 return{root,node:process.execPath,ffmpeg:executable("ffmpeg"),ffprobe:executable("ffprobe"),chrome:executable("chromium"),receipt};
}
async function download(asset,file,fetchImpl=fetch) {
 const controller=new AbortController();let size=0;const hash=crypto.createHash("sha256");
 const timer=setTimeout(()=>controller.abort(),15*60_000);
 try{
 const response=await fetchImpl(asset.url,{signal:controller.signal});if(!response.ok||!response.body)throw Error("Runtime download failed: "+asset.id+" HTTP "+response.status);
 await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,done){size+=chunk.length;if(size>asset.maxBytes)return done(Error("Runtime download exceeds pinned size limit: "+asset.id));hash.update(chunk);done(null,chunk);}}),fs.createWriteStream(file,{flags:"wx",mode:0o600}));
 if(hash.digest("hex")!==asset.sha256)throw Error("Runtime SHA-256 mismatch: "+asset.id);
 }catch(e){fs.rmSync(file,{force:true});throw e;}finally{clearTimeout(timer);}
}
function run(command,args,options={}) {const r=spawnSync(command,args,{encoding:"utf8",windowsHide:true,timeout:120_000,...options});if(r.error||r.status!==0)throw Error("Runtime extraction failed: "+command+": "+(r.error?.message||r.stderr||r.status));}
async function extract(asset,archive,stage,platform) {
 if(asset.format==="gzip"){
 const output=path.join(stage,asset.executable);fs.mkdirSync(path.dirname(output),{recursive:true});await pipeline(fs.createReadStream(archive),createGunzip(),fs.createWriteStream(output,{flags:"wx",mode:0o755}));
 }else if(asset.format==="zip"){
 if(platform==="win32")run("tar.exe",["-xf",archive,"-C",stage]);else run("unzip",["-q",archive,"-d",stage]);
 }else if(asset.format==="text")fs.copyFileSync(archive,path.join(stage,asset.executable));
 else throw Error("Unsupported pinned archive format: "+asset.format);
}
async function setupRuntime(home,options={}) {
 const {key,manifest,target}=assetsFor(options.platform,options.arch,options.manifest),root=runtimeRoot(home,manifest),platform=key.slice(0,key.lastIndexOf("-"));
 fs.mkdirSync(path.dirname(root),{recursive:true,mode:0o700});
 if(fs.existsSync(root))return checkedRuntime(home,options);
 const lock=root+".prepare.lock";let fd;
 try{fd=fs.openSync(lock,"wx",0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,target:key,startedAt:new Date().toISOString()}));}catch(e){if(e.code==="EEXIST")throw Error("Runtime preparation already owned; inspect "+lock+" before retrying");throw e;}
 const stage=fs.mkdtempSync(root+".stage-"),archives=fs.mkdtempSync(root+".downloads-");
 try{
 for(const asset of target.assets){const archive=path.join(archives,asset.id);await download(asset,archive,options.fetch);await extract(asset,archive,stage,platform);}
 for(const notice of target.requiredNotices||[]){if(!fs.statSync(path.join(stage,notice)).isFile())throw Error("Required runtime notice missing: "+notice);}
 fs.copyFileSync(path.join(__dirname,"licenses/COPYING.GPLv3"),path.join(stage,"COPYING.GPLv3"));
 fs.writeFileSync(path.join(stage,"runtime-assets.json"),JSON.stringify(manifest,null,2)+"\n");
 for(const name of ["ffmpeg","ffprobe","chromium"]){const asset=target.assets.find(a=>a.id===name);if(!asset)throw Error("Missing required runtime: "+name);fs.chmodSync(path.join(stage,asset.executable),0o755);}
 const receipt={schemaVersion:1,target:key,manifestDigest:digest(JSON.stringify(manifest)),preparedAt:new Date().toISOString(),files:collectFiles(stage)};
 fs.writeFileSync(path.join(stage,"receipt.json"),JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});
 // Refuse to overwrite another completed prepare, even if it appeared after the lock was acquired.
 if(fs.existsSync(root))throw Error("Runtime destination appeared during preparation");fs.renameSync(stage,root);return checkedRuntime(home,options);
 }finally{fs.rmSync(stage,{recursive:true,force:true});fs.rmSync(archives,{recursive:true,force:true});if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
}
function applyRuntime(home,options={}) {
 const runtime=checkedRuntime(home,options);process.env.PATH=path.dirname(runtime.ffmpeg)+path.delimiter+(process.env.PATH||"");process.env.FABLECUT_CHROME=runtime.chrome;process.env.FABLECUT_DATA_DIR=home;return runtime;
}
module.exports={dataRoot,assetsFor,runtimeRoot,checkedRuntime,download,setupRuntime,applyRuntime};
