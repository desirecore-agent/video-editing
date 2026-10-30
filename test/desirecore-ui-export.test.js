"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const SRC=process.env.FABLECUT_UI_TEST_SOURCE?require('node:fs').readFileSync(process.env.FABLECUT_UI_TEST_SOURCE,'utf8'):require('./timeline-sandbox').SRC;
function slice(a,b){const i=SRC.indexOf(a),j=SRC.indexOf(b,i);assert.ok(i>=0&&j>i);return SRC.slice(i,j);}
function world(over={}){
 const project={name:'A',text:'manual draft'},runtime={projectId:'p_a',confirmedRevision:7},state={connected:true,exporting:false};
 const requests=[],toasts=[],downloads=[];let saves=0;
 const node=()=>({textContent:'',style:{},dataset:{},classList:{add(){},remove(){}}});
 const els={exportOverlay:node(),exportProgress:node(),exportTitle:node(),exportNote:node()};
 const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
 const env={runtime,state,project,els,saveContent:()=>JSON.stringify(project),exportRangeMode:()=> 'in-out',
  flushSave:async()=>{saves++;return true;},toast:s=>toasts.push(s),
  document:{createElement:()=>({click(){downloads.push(this.href);}})},
  setTimeout:fn=>{queueMicrotask(fn);return 0;},
  fetch:async(url,opts)=>{requests.push({url,opts,body:opts?.body&&JSON.parse(opts.body)});if(url==='/api/export/request')return response({id:'x_original',status:'pending',snapshot:{id:'frozen-a'}});if(url.includes('/cancel'))return response({id:'x_original',status:'cancelled'});return response({id:'x_original',status:'done',src:'/exports/A.mp4',progress:1});},...over};
 const names=Object.keys(env),api=new Function(...names,slice('let uiSnapshotExport = null;','/** opts.job:')+';return {requestSnapshotExport,cancelSnapshotExport};')(...names.map(k=>env[k]));
 return {...api,env,project,runtime,state,requests,toasts,downloads,response,get saves(){return saves;}};
}
test('UI flush failure keeps the manual draft and never admits an export',async()=>{
 const w=world({flushSave:async()=>false});const before=JSON.stringify(w.project);const r=await w.requestSnapshotExport({profile:'draft'});assert.match(r.error,/draft could not be saved/);assert.equal(w.requests.length,0);assert.equal(JSON.stringify(w.project),before);
});
test('project switch or local edit while saving is not exported as another target',async()=>{
 for(const change of [w=>w.runtime.projectId='p_b',w=>w.project.text='new manual draft']){let w;w=world({flushSave:async()=>{change(w);return true;}});const r=await w.requestSnapshotExport({profile:'draft'});assert.match(r.error,/project or draft changed/);assert.equal(w.requests.length,0);}
});
test('UI409 admission leaves the draft and saved revision intact',async()=>{
 let w;w=world({fetch:async()=>w.response({error:'project identity/revision changed'},409)});const before=JSON.stringify(w.project);const r=await w.requestSnapshotExport({profile:'draft'});assert.match(r.error,/identity\/revision/);assert.equal(JSON.stringify(w.project),before);assert.equal(w.runtime.confirmedRevision,7);
});
test('UI Fast passes exact saved target/range/profile and observes the original job',async()=>{
 const w=world();const r=await w.requestSnapshotExport({profile:'draft'});assert.equal(w.saves,1);assert.deepEqual(w.requests[0].body,{profile:'draft',range:'in-out',projectId:'p_a',revision:7,where:'headless'});assert.deepEqual(w.requests.map(x=>x.url),['/api/export/request','/api/export/job?id=x_original']);assert.equal(r.jobId,'x_original');assert.deepEqual(w.downloads,['/exports/A.mp4']);assert.equal(w.state.exporting,false,'live editor is not used as renderer or frozen');
});
test('UI delivery choices are captured before an async save without changing the source choice',async()=>{
 const spec={preset:'youtube',fps:24,filename:'Chosen name'};let release;const saving=new Promise(r=>release=r);const w=world({flushSave:()=>saving});const run=w.requestSnapshotExport({delivery:spec,silent:true},'entire');spec.filename='later';release(true);await run;assert.equal(w.requests[0].body.delivery.filename,'Chosen name');assert.equal(w.requests[0].body.range,'entire');assert.deepEqual(w.downloads,[]);
});
test('cancel arriving before admission response is applied to the returned original job',async()=>{
 let answer,w;const pending=new Promise(r=>answer=r);w=world({fetch:async(url,opts)=>{w.requests.push({url,opts});if(url==='/api/export/request')return pending;if(url.includes('/cancel'))return w.response({status:'cancelled'});return w.response({id:'x_original',status:'cancelled'});}});const run=w.requestSnapshotExport({profile:'draft'});await new Promise(r=>setImmediate(r));await w.cancelSnapshotExport();answer(w.response({id:'x_original',status:'pending',snapshot:{id:'frozen-a'}}));const result=await run;assert.equal(result.cancelled,true);assert.ok(w.requests.some(x=>x.url==='/api/export/job/cancel?id=x_original'));assert.ok(w.requests.every(x=>!x.opts?.signal),'admission is not aborted into an unknown original job');
});
test('unknown request does not fall back to a live renderer or retry submission',async()=>{
 let calls=0;const w=world({fetch:async()=>{calls++;throw Error('connection lost');}});const r=await w.requestSnapshotExport({profile:'draft'});assert.match(r.error,/result unknown/);assert.equal(calls,1);
});
test('GUI queue preserves its selected output filenames/range and uses snapshot requests',async()=>{
 const queue=[{id:'q1',status:'pending',spec:{preset:'youtube',fps:24,container:'mp4'},name:'Chosen output',range:'in-out'}],requests=[];
 const env={state:{connected:true,ffmpeg:true,exporting:false},exportQueue:queue,queueRunning:false,queueStop:false,renderQueue(){},projectFps:()=>24,renderQueueProgress(){},toast(){},alert(){throw Error('unexpected alert');},fastExport(){throw Error('unsafe live renderer');},requestSnapshotExport:async(opts,range)=>{requests.push({opts,range});return {outputs:[{ok:true,src:'/exports/chosen.mp4',file:'chosen.mp4'}]};}};
 const names=Object.keys(env);const run=new Function(...names,slice('async function runQueue()','function stopQueue()')+';return runQueue;')(...names.map(k=>env[k]));await run();assert.equal(requests.length,1);assert.equal(requests[0].range,'in-out');assert.deepEqual(requests[0].opts.outputs,[{preset:'youtube',fps:24,container:'mp4',filename:'Chosen output'}]);assert.equal(queue[0].status,'done');
});
test('Fast button routes profile and delivery to snapshot submission; old live mode cannot fallback',()=>{
 for(const kind of ['profile','delivery','unsupported']){const calls=[],alerts=[];const env={els:{engineFast:{checked:kind!=='unsupported',disabled:false},engineRealtime:{checked:kind==='unsupported',disabled:false}},state:{},dlvSpec:{preset:'youtube'},persistExportWcOpts(){},getExportFrame:()=>null,exportRange:()=>({frames:288}),closeExportSetup(){},selectedExportChoice:()=>({kind:kind==='delivery'?'delivery':'profile',id:'draft'}),setSetting(){},requestSnapshotExport:opts=>calls.push(opts),alert:x=>alerts.push(x),fastExport(){throw Error('unsafe renderer');},startExport(){throw Error('unsafe fallback');},webCodecsExport(){throw Error('unsafe fallback');}};const names=Object.keys(env);new Function(...names,slice('function startChosenExport()','/* Keep Range')+';return startChosenExport;')(...names.map(k=>env[k]))();if(kind==='unsupported'){assert.equal(calls.length,0);assert.match(alerts[0],/does not support frozen/);}else assert.deepEqual(calls,[kind==='delivery'?{delivery:{preset:'youtube'}}:{profile:'draft'}]);}
});
test('an in-flight project response cannot replace the frozen export document',async()=>{
 let answer;const incoming=new Promise(r=>answer=r);const runtime={projectId:'p_a',audioBufs:new Map()},state={binTab:'project'},project={revision:1};let applied=0;
 const env={runtime,state,project,fetchSaved:async()=>{},loadLibraryFonts(){},fetchEncodeProfiles(){},fetch:async()=>({ok:true,json:()=>incoming,headers:{get:()=> 'p_b'}}),applyProject(){applied++;}};const names=Object.keys(env);const sync=new Function(...names,slice('async function syncFromServer(','/** Populate a media entry')+';return syncFromServer;')(...names.map(k=>env[k]));const running=sync();runtime.frozenExportInput=true;answer({revision:2,clips:[]});assert.equal(await running,false);assert.equal(applied,0);assert.equal(runtime.projectId,'p_a');
});
test('a renderer group binds its session owner without reporting aggregate completion',async()=>{
 const requests=[],reports=[],node=()=>({textContent:'',style:{},classList:{add(){},remove(){}}});
 const env={state:{exporting:false},runtime:{},AbortController,exportAbort:null,renderCancelled:false,exportFullCanvas:false,
  els:{exportOverlay:node(),exportProgress:node(),exportTitle:node(),exportNote:node()},pause(){},restoreExportVideoState(){},projectFps:()=>24,
  beginExportWindow:()=>({start:0,end:0,frames:0}),renderAudioMix:async()=>null,effectiveEncodeProfileId:()=> 'draft',deliveryCanvas:()=>({w:1280,h:720}),deliveryFileName:()=> 'group',
  fetch:async(url,opts)=>{requests.push({url,body:opts?.body&&JSON.parse(opts.body)});return {json:async()=>url==='/api/export/begin'?{id:'session-real-owner',input:'rgba'}:{src:'/exports/group.mp4'}};},
  loadProjectFonts:async()=>{},resetExportCanvases(){},armExportCors:async()=>{},useOriginalPlayers:async()=>{},exportDecodeBegin(){},createExportUploader:()=>({done:async()=>{}}),createJpegWorkers:()=>null,navigator:{hardwareConcurrency:2},reportExportJob:(...args)=>reports.push(args),exportDecodeEnd(){},endExportWindow(){},releaseOriginalPlayers(){}};
 const names=Object.keys(env),run=new Function(...names,slice('async function fastExport(','/* ── Export queue')+';return fastExport;')(...names.map(k=>env[k]));const result=await run({ownerJob:'aggregate-original',deliveries:[{delivery:{fps:24}}],silent:true});assert.equal(requests[0].body.job,'aggregate-original');assert.equal(result.outputs[0].ok,true);assert.deepEqual(reports,[],'a group has an owner but cannot mark that owner done');
});
function mixedWorld(cancelSecond=false){
 const reports=[],groups=[];let completeSecond;const second=new Promise(r=>completeSecond=r);
 const env={state:{exporting:false,ffmpeg:true},project:{revision:7,clips:[{}]},fetch:async()=>({ok:true}),reportExportJob:async(id,body)=>reports.push({id,body}),fetchEncodeProfiles:async()=>{},probeMissingMeta:async()=>{},exportRangeForced:null,hasWorkArea:()=>false,exportRange:()=>({frames:288}),fetchDeliveryInfo:async()=>{},normalizeDelivery:sp=>({spec:sp}),projectFps:()=>24,
  fastExport:async opts=>{groups.push(opts);if(groups.length===2)await second;if(cancelSecond&&groups.length===2)return {cancelled:true};return {outputs:[{file:groups.length+'.mp4',ok:true,src:'/exports/'+groups.length+'.mp4'}]};}};
 const names=Object.keys(env),run=new Function(...names,slice('async function runExportJob(','/* fablecut_track:')+';return runExportJob;')(...names.map(k=>env[k]));return {reports,groups,completeSecond,run:()=>run({id:'aggregate-original',range:'entire',revision:7,deliveries:[{fps:24},{fps:30}]})};
}
test('mixed-fps first group cannot finish the aggregate and both groups retain its owner',async()=>{
 const w=mixedWorld(),running=w.run();for(let i=0;i<20&&w.groups.length<2;i++)await new Promise(r=>setImmediate(r));assert.equal(w.groups.length,2);assert.ok(w.groups.every(g=>g.ownerJob==='aggregate-original'&&g.job===undefined));assert.ok(!w.reports.some(r=>r.body.status==='done'));w.completeSecond();await running;const done=w.reports.filter(r=>r.body.status==='done');assert.equal(done.length,1);assert.equal(done[0].body.result.outputs.length,2);
});
test('mixed-fps group cancellation never emits an aggregate done receipt',async()=>{
 const w=mixedWorld(true),running=w.run();for(let i=0;i<20&&w.groups.length<2;i++)await new Promise(r=>setImmediate(r));w.completeSecond();await running;assert.ok(!w.reports.some(r=>r.body.status==='done'));assert.ok(w.reports.some(r=>r.body.status==='failed'&&r.body.error==='cancelled'));
});
