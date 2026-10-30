"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../app.js"),"utf8"),worker=fs.readFileSync(path.join(__dirname,"../ruler-worker.js"),"utf8");
function fn(name) {
  const a=source.indexOf("function "+name+"("),b=source.indexOf("\n}",a);
  assert.ok(a>=0&&b>a,name+" remains a real top-level implementation");return source.slice(a,b+2);
}
function canvas() {
  const styles=[],context=new Proxy({
    setTransform(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},closePath(){},
    fillText(){},fillRect(){},save(){},restore(){},rect(){},clip(){},measureText(){return {width:18};},
  },{set(o,key,value){styles.push([key,value]);o[key]=value;return true;}});
  return {width:800,height:30,style:{},getContext:()=>context,styles,context};
}
const palettes=[
  {rulerTick:"#112233",rulerText:"#223344",outsideRange:"#334455",markerLabelBackground:"#445566",rangeIn:"#556677",rangeOut:"#667788",playhead:"#778899",fontMono:"monospace"},
  {rulerTick:"#aabbcc",rulerText:"#bbccdd",outsideRange:"#ccddee",markerLabelBackground:"#ddeeff",rangeIn:"#aaccbb",rangeOut:"#bbaacc",playhead:"#ccaabb",fontMono:"monospace"},
];
test("main and OffscreenCanvas rulers consume the same theme while marker data stays unchanged",()=>{
  for(const palette of palettes) {
    const project={markers:[{t:0.2,color:"gold",label:"Cue"}],inPoint:0.1,outPoint:1.5};
    const before=JSON.stringify(project),main=canvas(),offscreen=canvas(),markerColors={gold:"#abcdef"};
    vm.runInNewContext(fn("uiColor")+"\n"+fn("drawRulerMainThread")+"\ndrawRulerMainThread(800,30,1);",{
      DesireCoreTheme:{snapshot:()=>({palette})},els:{ruler:main,timelineScroll:{scrollLeft:0}},
      state:{pps:100,time:0.7},project,markerColor:mk=>markerColors[mk.color],fmt:()=>"00:00:00",
    });
    const self={};vm.runInNewContext(worker,{self});
    self.onmessage({data:{type:"init",canvas:offscreen}});
    self.onmessage({data:{type:"draw",w:800,h:30,dpr:1,sl:0,pps:100,markers:project.markers,markerColors,inPoint:0.1,outPoint:1.5,time:0.7,fps:24,palette}});
    for(const [key,value] of Object.entries(palette)) {
      if(key==="fontMono")continue;
      assert.ok(main.styles.some(x=>x[1]===value),"main uses "+key);
      assert.ok(offscreen.styles.some(x=>x[1]===value),"worker uses "+key);
    }
    assert.ok(main.styles.some(x=>x[1]===markerColors.gold));assert.ok(offscreen.styles.some(x=>x[1]===markerColors.gold));
    assert.equal(JSON.stringify(project),before);
  }
});
test("host theme cannot change the composed film background",()=>{
  const project={background:"#123456"},cv=canvas(),runtime={sampling:true},before=JSON.stringify(project);
  const context=vm.createContext({project,ctx2d:cv.context,els:{preview:{width:1280,height:720}},state:{time:0,exporting:true},runtime,visibleClipsAt:()=>[],matteTracksAt:()=>new Set()});
  vm.runInContext(fn("uiColor")+"\n"+fn("drawFrame"),context);
  for(const palette of palettes) {
    context.DesireCoreTheme={snapshot:()=>({palette})};vm.runInContext("drawFrame(0)",context);
    assert.equal(cv.context.fillStyle,"#123456");assert.equal(JSON.stringify(project),before);
  }
});
test("theme repaint keeps an active export compositor and row DOM untouched",()=>{
  let frames=0,rebuilds=0;
  const context={drawRuler(){},els:{tracks:{querySelectorAll:()=>[]}},updateKfGraphs(){},meterState:{lastLit:{},lastHold:{}},paintMixerMeters(){},state:{exporting:true,source:{}},runtime:{sampling:false},drawFrame(){frames++;},drawSourceFrame(){frames++;},rebuildClips(){rebuilds++;}};
  vm.runInNewContext(fn("repaintEditorTheme")+"\nrepaintEditorTheme();",context);
  assert.equal(frames,0);assert.equal(rebuilds,0);
});
