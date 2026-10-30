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

// Execute the real repaint and both monitor renderers against one shared
// canvas. A Source clear therefore destroys the same frame Program just drew.
function monitorHarness({ mode="program", playing=false, sourcePlaying=false, exporting=false, sampling=false, media=null }={}) {
  const cv=canvas(),paint={color:"#334455",text:["existing preview"]},programTimes=[],sourceImages=[],sourceDestinations=[];
  cv.width=1280;cv.height=720;
  cv.context.fillRect=()=>{paint.color=cv.context.fillStyle;paint.text=[];};
  cv.context.fillText=text=>paint.text.push(String(text));
  cv.context.drawImage=(img,...destination)=>{sourceImages.push(img);sourceDestinations.push(destination);paint.color=img.pixelColor;paint.text=[];};
  const project={projectId:"theme-preview",revision:7,background:"#ff1800",clips:[{id:"picture",mediaId:"video",start:0,duration:12}]};
  const state={monitorMode:mode,time:3,playing,exporting,source:{mediaId:media?.id??null,time:2,playing:sourcePlaying}};
  const ui={ruler:0,wave:0,graphs:0,meters:0,rebuilds:0},wave={},element={dataset:{id:"picture"},querySelector:()=>wave};
  const image={naturalWidth:1280,naturalHeight:720,pixelColor:"#2468ac"};
  const context=vm.createContext({
    project,state,ctx2d:cv.context,els:{preview:cv,tracks:{querySelectorAll:()=>[element]}},
    runtime:{sampling,mediaAux:new Map(media?[[media.id,{img:image}]]:[])},
    DesireCoreTheme:{snapshot:()=>({palette:{overlayMuted:"#aabbcc"}})},
    visibleClipsAt:t=>{programTimes.push(t);return [];},matteTracksAt:()=>new Set(),
    drawMaskView(){},updateScopes(){},drawNullGuides(){},drawSelectionOverlay(){},
    sourceMedia:()=>media,
    drawRuler(){ui.ruler++;},getClip:id=>project.clips.find(c=>c.id===id),trackOf:()=>({h:58}),
    drawClipWave(canvas,clip,height){assert.equal(canvas,wave);assert.equal(clip,project.clips[0]);assert.equal(height,58);ui.wave++;},
    updateKfGraphs(){ui.graphs++;},meterState:{lastLit:{old:1},lastHold:{old:1}},paintMixerMeters(){ui.meters++;},
    rebuildClips(){ui.rebuilds++;},
  });
  vm.runInContext(["uiColor","drawFrame","drawSourceContain","drawSourceFrame","repaintEditorTheme"].map(fn).join("\n"),context);
  return {context,paint,project,state,ui,programTimes,sourceImages,sourceDestinations,image,repaint:()=>context.repaintEditorTheme()};
}
function assertChromeRepainted(h,count=1) {
  assert.deepEqual(h.ui,{ruler:count,wave:count,graphs:count,meters:count,rebuilds:0});
  assert.deepEqual(Object.keys(h.context.meterState.lastLit),[]);
  assert.deepEqual(Object.keys(h.context.meterState.lastHold),[]);
}
test("host theme repaint preserves paused Program when its shared Source is empty",()=>{
  const h=monitorHarness(),before=JSON.stringify(h.project);
  for(const color of ["#aabbcc","#112233"]) {
    h.context.DesireCoreTheme={snapshot:()=>({palette:{overlayMuted:color}})};
    h.repaint();
    assert.equal(h.paint.color,h.project.background,"the composed Program background stays on the shared canvas");
    assert.deepEqual(h.paint.text,[],"an empty Source must not replace Program with its prompt");
    assert.equal(JSON.stringify(h.project),before);
    assert.equal(h.state.time,3);assert.equal(h.state.monitorMode,"program");assert.equal(h.state.source.mediaId,null);
  }
  assert.deepEqual(h.programTimes,[3,3]);assertChromeRepainted(h,2);
});
test("paused Source repaints its empty prompt or loaded image without drawing Program",()=>{
  const empty=monitorHarness({mode:"source"});empty.repaint();
  assert.equal(empty.paint.color,"#000");
  assert.deepEqual(empty.paint.text,["Double-click a clip to load Source"]);
  assert.deepEqual(empty.programTimes,[]);assertChromeRepainted(empty);
  const loaded=monitorHarness({mode:"source",media:{id:"source-image",kind:"image"}});loaded.repaint();
  assert.equal(loaded.paint.color,"#2468ac");assert.deepEqual(loaded.sourceImages,[loaded.image]);
  assert.deepEqual(loaded.sourceDestinations,[[0,0,1280,720]]);
  assert.deepEqual(loaded.programTimes,[]);assertChromeRepainted(loaded);
});
test("inactive monitor playback does not suppress the paused active monitor repaint",()=>{
  const program=monitorHarness({sourcePlaying:true});program.repaint();
  assert.equal(program.paint.color,program.project.background);assert.deepEqual(program.paint.text,[]);
  assert.deepEqual(program.programTimes,[3]);assertChromeRepainted(program);
  const source=monitorHarness({mode:"source",playing:true});source.repaint();
  assert.equal(source.paint.color,"#000");assert.deepEqual(source.paint.text,["Double-click a clip to load Source"]);
  assert.deepEqual(source.programTimes,[]);assertChromeRepainted(source);
});
test("playing, exporting and exact-frame sampling retain the existing preview while UI chrome repaints",()=>{
  for(const options of [
    {mode:"program",playing:true},{mode:"source",sourcePlaying:true},
    {mode:"program",exporting:true},{mode:"source",exporting:true},
    {mode:"program",sampling:true},{mode:"source",sampling:true},
  ]) {
    const h=monitorHarness(options),before=JSON.stringify(h.paint);h.repaint();
    assert.equal(JSON.stringify(h.paint),before,JSON.stringify(options));
    assert.deepEqual(h.programTimes,[],JSON.stringify(options));assertChromeRepainted(h);
  }
});
