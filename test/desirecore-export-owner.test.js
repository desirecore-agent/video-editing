"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {makeDataDir,startServer,seedProject,readProject}=require('./helpers');const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function setup(t,kind){const doc=seedProject({outputs:[{id:'a',on:true,preset:'youtube',width:1280,height:720,fps:30}]}),dir=makeDataDir(t,doc);fs.mkdirSync(path.join(dir,'media'));fs.writeFileSync(path.join(dir,'media/a.mp4'),'unit bytes; never decoded');const gate=path.join(dir,'gate');const service=await startServer(t,dir,{NODE_OPTIONS:'--require '+path.join(__dirname,'fixtures/export-api-unit.cjs'),FABLECUT_EXPORT_UNIT_GATE:gate,FABLECUT_EXPORT_UNIT_KIND:kind});
 const call=async(p,data,method=data===undefined?'GET':'POST')=>{const r=await fetch(service.base+p,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,body:await r.json()};};
 const ready=async()=>{for(let i=0;i<200&&!fs.existsSync(path.join(gate,'ready'));i++)await pause(10);assert.ok(fs.existsSync(path.join(gate,'ready')));};return {dir,gate,service,call,ready};}
test('batch config and input cannot cross a project change during async admission (unit substitutes)',async t=>{
 const {dir,gate,call,ready}=await setup(t,'admission');const request=call('/api/export/request',{outputs:true});await ready();const b=readProject(dir);b.name='B';b.revision++;b.outputs=[{id:'b',on:true,preset:'youtube',width:640,height:360,fps:30}];assert.equal((await call('/api/project',b,'PUT')).status,200);fs.writeFileSync(path.join(gate,'release'),'release');const rejected=await request;assert.equal(rejected.status,409);assert.match(rejected.body.error,/project changed/);assert.equal(readProject(dir).name,'B');
});
test('UI exact project/revision rejects stale targets before snapshot or renderer creation (unit substitutes)',async t=>{
 const {dir,call}=await setup(t,'no-gate');const current=(await call('/api/project')).body;
 for(const target of [{projectId:'another-project',revision:current.revision},{projectId:current.projectId,revision:current.revision-1}]){
  const rejected=await call('/api/export/request',{...target,profile:'draft'});assert.equal(rejected.status,409);assert.match(rejected.body.error,/identity\/revision/);
 }
 const snapshots=path.join(dir,'exports','snapshots');assert.ok(!fs.existsSync(snapshots)||fs.readdirSync(snapshots).length===0);
 const accepted=await call('/api/export/request',{projectId:current.projectId,revision:current.revision,range:'in-out',profile:'draft'});assert.equal(accepted.status,200);assert.equal(accepted.body.range,'in-out');assert.equal(accepted.body.snapshot.receipt.projectId,current.projectId);assert.equal(accepted.body.snapshot.receipt.projectRevision,current.revision);
});
test('an edit while media capture yields refuses admission and removes the rejected snapshot',async t=>{
 const {dir,gate,call,ready}=await setup(t,'capture');const current=readProject(dir);
 const request=call('/api/export/request',{projectId:current.projectId,revision:current.revision,profile:'draft'});
 await ready();const changed=readProject(dir);changed.name='human edit during copy';changed.revision++;
 assert.equal((await call('/api/project',changed,'PUT')).status,200);
 fs.writeFileSync(path.join(gate,'release'),'release');const refused=await request;
 assert.equal(refused.status,409);assert.match(refused.body.error,/snapshot capture/);
 assert.deepEqual(fs.readdirSync(path.join(dir,'exports','snapshots')),[]);
 assert.equal(readProject(dir).name,'human edit during copy');
});
test('cancel while begin awaits preflight removes late session and encoding temps (unit substitutes)',async t=>{
 const {dir,gate,call,ready}=await setup(t,'begin');const j=await call('/api/export/request',{profile:'draft'});assert.equal(j.status,200);assert.equal((await call('/api/export/job/claim?id='+j.body.id,{})).status,200);const begin=call('/api/export/begin',{fps:30,name:'unit',hasAudio:false,profile:'draft',job:j.body.id});await ready();assert.equal((await call('/api/export/job/cancel?id='+j.body.id,{})).body.status,'cancelled');fs.writeFileSync(path.join(gate,'release'),'release');const ended=await begin;assert.equal(ended.status,409);assert.match(ended.body.error,/ended/);assert.deepEqual(fs.readdirSync(path.join(dir,'exports')).filter(n=>n.startsWith('fablecut-')||/\.part(?:\.|$)/.test(n)),[]);
});
test('encoder stop confirms close even when the original child ignores TERM',async t=>{
 const {spawn}=require('node:child_process');
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const start=source.indexOf('const encoderStops = new WeakMap();'),end=source.indexOf('function cleanupExport(',start);
 const stop=new Function(source.slice(start,end)+';return stopEncoder;')();
 const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)'],{stdio:['pipe','pipe','ignore']});
 t.after(()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');});
 await new Promise(resolve=>child.stdout.once('data',resolve));
 assert.equal(await stop(child),true);assert.ok(child.exitCode!==null||child.signalCode,'actual original child exited');
});
