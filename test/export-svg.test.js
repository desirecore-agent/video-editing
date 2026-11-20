"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"..","app.js"),"utf8");
const a=source.indexOf("async function prepareSvgFrame("),b=source.indexOf("/* ═════════════ AI BACKGROUND",a);
assert(a>=0&&b>a);
function load({aux,fail=false,missing=false}={}){
 const runtime={mediaAux:new Map(aux?[["icon",{svgSrc:"/media/icon.svg",...aux}]]:[])};let loads=0;
 const context={runtime,getMedia:()=>missing?null:{id:"icon",src:"/media/icon.svg"},
  async loadSvgMedia(){loads++;if(fail)throw Error("invalid SVG markup");runtime.mediaAux.set("icon",{svgSrc:"/media/icon.svg",svgText:"<svg/>",svgAnimated:false,img:{width:100,height:100}});},
  mediaTimeAt:()=>.5,projectFps:()=>30,async renderSvgFrame(){if(fail)throw Error("invalid animated SVG");return{width:100,height:100};},pruneSvgFrames(){} };
 vm.runInNewContext(source.slice(a,b)+";globalThis.prepare=prepareSvgFrame",context);
 return{prepare:context.prepare,runtime,loads:()=>loads};
}
const clip={id:"icon-clip",mediaId:"icon"};
test("a forced static SVG waits for its first real bitmap",async()=>{
 const api=load();await api.prepare(clip,.5);assert.equal(api.loads(),1);assert.equal(api.runtime.mediaAux.get("icon").img.width,100);
});
test("a failed static SVG cannot be silently skipped just because its markup is cached",async()=>{
 const api=load({aux:{svgText:"invalid",svgAnimated:false},fail:true});await assert.rejects(api.prepare(clip,.5),/invalid SVG markup/);
});
test("a missing SVG media reference refuses the forced frame",async()=>{
 await assert.rejects(load({missing:true}).prepare(clip,.5),/SVG.*source|SVG.*media/i);
});
test("a relinked static SVG cannot reuse the old successful bitmap",async()=>{
 const api=load({aux:{svgSrc:"/media/old.svg",svgText:"old valid SVG",svgAnimated:false,img:{width:100,height:100}},fail:true});
 await assert.rejects(api.prepare(clip,.5),/invalid SVG markup/);
});
test("an animated raster error cannot use a stale preview bitmap",async()=>{
 const api=load({aux:{svgText:"animated",svgAnimated:true,svgFrames:new Map(),lastImg:{width:10,height:10}},fail:true});
 await assert.rejects(api.prepare(clip,.5),/invalid animated SVG/);
});
test("shared frame preparation reports the SVG clip and exact time",async()=>{
 const start=source.indexOf("async function prepareFrameAssets("),end=source.indexOf("/* UI exports",start);
 const ctx={mediaClips:()=>[{...clip,kind:"svg"}],activeAt:()=>true,clipRenders:()=>true,async prepareSvgFrame(){throw Error("invalid SVG markup");}};
 vm.runInNewContext(source.slice(start,end)+";globalThis.prepare=prepareFrameAssets",ctx);
 await assert.rejects(ctx.prepare(20),/SVG_FRAME_UNAVAILABLE: icon-clip at 20\.000s: invalid SVG markup/);
});
