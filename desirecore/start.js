#!/usr/bin/env node
"use strict";
// The original owner (normally DesireCore TaskHost) launches exactly one foreground service.
const {dataRoot,applyRuntime}=require("./runtime-resolver");
try {
 const home=dataRoot(process.argv.slice(2));
 applyRuntime(home);
 if(process.env.APP_DATA_DIR||process.env.APP_DATA_ROOT)process.env.FABLECUT_MANAGED="1";
 require("../server.js");
}catch(e){console.error("视频剪辑启动失败："+e.message+"。显式运行 node desirecore/setup-runtime.js --data-dir <同一数据根> 准备依赖。");process.exitCode=1;}
