#!/usr/bin/env node
"use strict";
const {dataRoot,setupRuntime}=require("./runtime-resolver");
if(require.main===module)setupRuntime(dataRoot(process.argv.slice(2))).then(r=>console.log(JSON.stringify({target:r.receipt.target,root:r.root,node:r.node,ffmpeg:r.ffmpeg,ffprobe:r.ffprobe,chrome:r.chrome},null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
