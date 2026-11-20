/* Real local HTTP/MCP transport, synthetic persisted receipts only. No movie,
 * browser or successful encoding is represented by these fixtures. */
"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {makeDataDir,seedProject,startServer,startMcp}=require('./helpers');
test('original terminal browser facts and multi-file recovered frames reach MCP without creating another job',async t=>{
 const dir=makeDataDir(t,seedProject()),store=path.join(dir,'exports/jobs');fs.mkdirSync(store,{recursive:true});
 const browser={pid:1234,discovery:'enabled',targetCrashes:[{at:10,targetId:'page',type:'page',status:'oom',errorCode:5,ownerClosing:false}],stderrTail:'not-for-context-'.repeat(1000)+'actual tail',exit:null};
 browser.memory={status:'sampled',stopReason:'target_destroyed',sampleCount:40,peak:{usedSize:400,totalSize:1000,backingStorageSize:2000,privateData:'excluded'},samples:Array.from({length:40},(_,i)=>({at:i,usedSize:i,totalSize:1000,unexpected:'excluded'}))};
 const frameResources={schemaVersion:1,sampleCount:10,last:{frame:60,decoders:1,jpegWorkerEnabled:1,privateData:'excluded'},peak:{frame:60,pixelsInflight:7,source:'excluded'}};
 const ids=[];
 for(const status of ['failed','cancelled','interrupted']){
  const id='x_unit'+status;ids.push(id);
  fs.writeFileSync(path.join(store,id+'.json'),JSON.stringify({id,kind:'export',status,via:'headless',progress:.6,error:'original failure retained',created:Date.now(),updated:Date.now(),diagnostics:{browser,frameResources},artifacts:{schemaVersion:1,jobId:id,entries:[],stoppedSessions:[]}}));
 }
 const done={id:'x_unitdone',kind:'export',status:'done',via:'headless',progress:1,src:'/exports/one.mp4',created:Date.now(),updated:Date.now(),diagnostics:{frameResources},result:{outputs:[{file:'one.mp4',ok:true},{file:'two.mp4',ok:true}],diagnostics:{jpegReadbackRecoveries:[{frame:0,reason:'EncodingError',readback:'cpu'},{frame:2905,reason:'EncodingError',readback:'cpu'}]}}};
 fs.writeFileSync(path.join(store,done.id+'.json'),JSON.stringify(done));
 const {base,port}=await startServer(t,dir,{FABLECUT_NO_FS_WATCH:'1'}),mcp=startMcp(t,dir,{PORT:String(port),FABLECUT_NO_AUTOSTART:'1'});
 await mcp.request('initialize',{protocolVersion:'2025-11-25'});
 for(const id of ids){
  const result=await mcp.callTool('fablecut_export',{job:id});assert.equal(result.isError,false,result.text);
  assert.match(result.text,/original failure retained/);assert.match(result.text,/Original browser diagnostics:/);
  const facts=JSON.parse(result.text.split('Original browser diagnostics: ')[1]);
  assert.equal(facts.pid,1234);assert.equal(facts.targetCrashes[0].status,'oom');assert.equal(facts.targetCrashes[0].errorCode,5);
  assert.equal(facts.stderrTail.length,2048);assert.equal(facts.stderrTailTruncated,true);assert(facts.stderrTail.endsWith('actual tail'));
  assert.equal(facts.memory.sampleCount,40);assert.equal(facts.memory.retainedSamples,32);assert.equal(facts.memory.lastSample.usedSize,39);
  assert.equal(facts.memory.peak.backingStorageSize,2000);assert.equal(facts.memory.stopReason,'target_destroyed');assert(!JSON.stringify(facts).includes('excluded'));
  assert(!result.text.includes('Check again'),'terminal receipts do not imply an active renderer');
  const counters=JSON.parse(result.text.split('Original compositor counters (not memory/cause): ')[1].split('\n')[0]);
  assert.equal(counters.sampleCount,10);assert.deepEqual(counters.last,{frame:60,jpegWorkerEnabled:1,decoders:1});
  assert.deepEqual(counters.peak,{frame:60,pixelsInflight:7});assert(!result.text.includes('excluded'));
  const saved=await fetch(base+'/api/export/job?id='+id).then(r=>r.json());assert.equal(saved.error,'original failure retained');
 }
 const result=await mcp.callTool('fablecut_export',{job:done.id});assert.equal(result.isError,false,result.text);
 assert.match(result.text,/2 of 2 files/);assert.match(result.text,/zero-based frames/);assert.match(result.text,/"frame":0/);assert.match(result.text,/"frame":2905/);
 assert.match(result.text,/Original compositor counters/);assert(!result.text.includes('excluded'));
 assert.equal(fs.readdirSync(store).filter(n=>n.endsWith('.json')).length,4,'status queries never admit a replacement job');
});
