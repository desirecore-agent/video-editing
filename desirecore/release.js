#!/usr/bin/env node
"use strict";
// Freeze source bytes only. Installation, dependency setup and process ownership stay with DesireCore.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const LIMITS = Object.freeze({ maxFiles: 2048, maxFileBytes: 32 * 1024 * 1024, maxBundleBytes: 128 * 1024 * 1024 });
const REQUIRED = ["package.json", "npm-shrinkwrap.json", "LICENSE", "NOTICE.md", "AGENTS.md", "README.md", "README.zh-CN.md", "index.html", "style.css", "desirecore-theme.css", "favicon.svg", "encoding-profiles.json", "manifest.json", "docs/editor-guide.md", "desirecore/RUNTIME.md"];
const TREES = ["icons", "library/elements", "library/fonts", "library/svg", "desirecore/licenses"];
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const runtimeFile = p => !p.split("/").some(s => s.startsWith(".") || s === "node_modules") && !/\.(?:test|integration|resource|manual)\.[cm]?js$/.test(p) && !/\.(?:map|log|tgz)$/.test(p);
function walk(root, p, selected) {
  const stat = fs.lstatSync(path.join(root, p));
  if (stat.isSymbolicLink()) throw Error("Payload symlink refused: " + p);
  if (stat.isDirectory()) for (const child of fs.readdirSync(path.join(root,p)).sort()) { const q=p+"/"+child; if(runtimeFile(q))walk(root,q,selected); }
  else if (stat.isFile() && runtimeFile(p)) selected.add(p);
  else if (!stat.isFile()) throw Error("Payload must be a regular file: " + p);
}
function readPayload(root=ROOT) {
  const selected = new Set(REQUIRED);
  for (const p of REQUIRED) if (!fs.existsSync(path.join(root,p))) throw Error("Required runtime file missing: " + p);
  for (const p of fs.readdirSync(root)) if (p.endsWith(".js")) selected.add(p);
  for (const p of fs.readdirSync(path.join(root,"desirecore"))) if (/\.(?:mjs|js|json)$/.test(p) && p!=="app-release.json") selected.add("desirecore/"+p);
  for (const p of TREES) walk(root,p,selected);
  selected.add("library/README.md"); selected.add("library/sfx/README.md");
  const payload=[...selected].sort().map(p=>{const s=fs.lstatSync(path.join(root,p)); if(!s.isFile()||s.isSymbolicLink()||s.size>LIMITS.maxFileBytes)throw Error("Payload exceeds regular-file/32 MiB budget: "+p);const bytes=fs.readFileSync(path.join(root,p));if(bytes.length!==s.size)throw Error("Payload changed: "+p);return{path:p,bytes};});
  if(payload.length>LIMITS.maxFiles||payload.reduce((n,f)=>n+f.bytes.length,0)>LIMITS.maxBundleBytes)throw Error("Payload exceeds 2048-file/128 MiB budget");
  return payload;
}
function canonicalize(manifest) { const {releaseDigest,...body}=manifest; const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v; return JSON.stringify(canonical({...body,files:[...body.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)})); }
function manifestFor(payload) {
 const pkg=JSON.parse(payload.find(f=>f.path==="package.json").bytes);
 const files=payload.map(f=>({path:f.path,sha256:sha256(f.bytes),size:f.bytes.length,role:/LICENSE|NOTICE|licenses\//.test(f.path)?"license":/\.md$/.test(f.path)?"documentation":/^package/.test(f.path)?"dependency":/\.(html|css|svg|woff2|png)$/.test(f.path)?"ui":"runtime"}));
 const manifest={schemaVersion:1,canonicalization:"app-release-c14n-v1",definition:{id:"0171a763-ad35-4b94-98b9-204782817b44",name:"视频剪辑",iconLetter:"剪",version:pkg.version,entrypoints:[{id:"editor",name:"剪辑工作台",kind:"embedded-web",serviceRef:"video-editing:editor"}],placementPolicy:{showInMyApps:true,allowNavPin:true,allowAgentBinding:true}},delivery:{type:"native-app",runtimeInstructionsPath:"desirecore/RUNTIME.md"},files,source:{kind:"worktree",sha256:sha256(JSON.stringify(files.map(({path,sha256,size})=>({path,sha256,size}))))},supportedPlatforms:["darwin","win32","linux"],requiredCapabilities:["app-authoring-v1","release","runtime-binding"],bridgeCapabilities:["connect","capabilities","publishSelection","requestWork"],dataContract:{schemaVersion:1,formatVersion:"video-editing-home-v1",readableVersions:["video-editing-home-v1"],writableVersions:["video-editing-home-v1"],files:[],uninstallRetention:"retain",backupInstructionsPath:"desirecore/RUNTIME.md",restoreInstructionsPath:"desirecore/RUNTIME.md"},instructionsPath:"desirecore/RUNTIME.md"};
 manifest.releaseDigest=sha256(canonicalize(manifest)); return manifest;
}
/** Bind this executable tree to a fixed release, not a source draft or an authorization claim.
 * The public SDK app-release-c14n-v1 identity excludes releaseDigest, recursively sorts object keys,
 * sorts only files by path, then SHA-256 hashes the UTF-8 JSON. Reuse the generator's exact functions.
 */
function verifyFixedRelease(root=ROOT, expectedDigest) {
 root=fs.realpathSync(root);
 const file=path.join(root,"app-release.json");
 if(!fs.existsSync(file))throw Error("Fixed application material is required at the executing root/app-release.json; source drafts cannot attach to a managed runtime");
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw Error("Fixed application manifest is invalid");
 const actual=JSON.parse(fs.readFileSync(file,"utf8")), expected=manifestFor(readPayload(root));
 if(actual.schemaVersion!==1||actual.canonicalization!=="app-release-c14n-v1"||!Array.isArray(actual.files)
   || actual.releaseDigest!==sha256(canonicalize(actual))
   || actual.releaseDigest!==expected.releaseDigest||canonicalize(actual)!==canonicalize(expected))
  throw Error("Executing application material changed or does not match its fixed release manifest");
 if(expectedDigest!==undefined&&actual.releaseDigest!==expectedDigest)
  throw Error("Executing application material release does not match the bound runtime release; use the current installed material root");
 return{materialRoot:root,manifest:actual,releaseDigest:actual.releaseDigest};
}
function atomic(file,bytes) {fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+"."+process.pid+".tmp";fs.writeFileSync(tmp,bytes);fs.renameSync(tmp,file);}
function writeRelease({root=ROOT,output,check=false}={}) {
 root=path.resolve(root); const payload=readPayload(root),manifest=manifestFor(payload),text=JSON.stringify(manifest,null,2)+"\n";
 if(check){if(fs.readFileSync(path.join(root,"desirecore/app-release.json"),"utf8")!==text)throw Error("Reviewed release manifest is stale");return{manifest,payloadBytes:payload.reduce((n,f)=>n+f.bytes.length,0)};}
 if(!output)throw Error("Choose a fresh --output directory to preserve each immutable release");output=path.resolve(output);
 if(output===root||TREES.some(tree=>output===path.join(root,tree)||output.startsWith(path.join(root,tree)+path.sep))||payload.some(f=>{const p=path.join(root,f.path);return output===p||p.startsWith(output+path.sep);}))throw Error("Output overlaps runtime sources");
 if(fs.existsSync(output)&&fs.readdirSync(output).length)throw Error("Output exists; choose a fresh material directory");
 for(const f of payload)atomic(path.join(output,f.path),f.bytes);
 atomic(path.join(output,"app-release.json"),text);atomic(path.join(root,"desirecore/app-release.json"),text);
 return{materialRoot:output,manifestPath:"app-release.json",releaseDigest:manifest.releaseDigest,files:payload.length,payloadBytes:payload.reduce((n,f)=>n+f.bytes.length,0)};
}
module.exports={LIMITS,readPayload,canonicalize,manifestFor,verifyFixedRelease,writeRelease};
if(require.main===module){try{const args=process.argv.slice(2),i=args.indexOf("--output");console.log(JSON.stringify(writeRelease({output:i<0?undefined:args[i+1],check:args.includes("--check")}),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
