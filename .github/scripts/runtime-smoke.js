#!/usr/bin/env node
"use strict";
// Required CI runtime check, intentionally excluded from app source material and npm files.
const fs=require("fs"),path=require("path"),{spawnSync}=require("child_process");
const {dataRoot,checkedRuntime}=require("../../desirecore/runtime-resolver");
const home=dataRoot(),runtime=checkedRuntime(home);
function run(bin,args){const r=spawnSync(bin,args,{encoding:"utf8",windowsHide:true,timeout:60_000,maxBuffer:8*1024*1024});if(r.error||r.status!==0)throw Error(path.basename(bin)+" failed: "+(r.error?.message||r.stderr||r.status));return r.stdout||r.stderr;}
const ffmpeg=run(runtime.ffmpeg,["-version"]),ffprobe=run(runtime.ffprobe,["-version"]),ffmpegLicense=run(runtime.ffmpeg,["-L"]),ffprobeLicense=run(runtime.ffprobe,["-L"]),chrome=run(runtime.chrome,["--version"]);
const profile=fs.mkdtempSync(path.join(home,"runtime-smoke-browser-"));
try{
 const args=["--headless","--disable-gpu","--user-data-dir="+profile,"--dump-dom","about:blank"];
 // The ephemeral Linux CI runner's AppArmor rules do not permit the downloaded CfT namespace sandbox.
 // This one fixture invocation does not change application launch flags or any host policy.
 if(process.platform==="linux"&&process.env.CI)args.unshift("--no-sandbox");
 const html=run(runtime.chrome,args);if(!/<html/i.test(html))throw Error("Pinned headless browser did not render a document");
 const observation={target:runtime.receipt.target,node:process.version,ffmpeg,ffprobe,ffmpegLicense,ffprobeLicense,chrome,browserDocumentFixture:true,appExportVerified:false,linuxCiFixtureNoSandbox:process.platform==="linux"&&Boolean(process.env.CI)};
 fs.writeFileSync(path.join(home,"runtime-observations.json"),JSON.stringify(observation,null,2)+"\n");console.log(JSON.stringify({target:observation.target,node:observation.node,ffmpeg:ffmpeg.split("\n")[0],ffprobe:ffprobe.split("\n")[0],chrome:chrome.trim(),browserDocumentFixture:true,appExportVerified:false,productionSandboxVerified:!observation.linuxCiFixtureNoSandbox}));
}finally{fs.rmSync(profile,{recursive:true,force:true});}
