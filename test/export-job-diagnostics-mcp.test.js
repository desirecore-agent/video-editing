/* Real local HTTP/MCP transport, synthetic persisted receipts only. No movie,
 * browser or successful encoding is represented by these fixtures. */
"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {makeDataDir,seedProject,startServer,startMcp}=require('./helpers');
test('original terminal browser facts and multi-file recovered frames reach MCP without creating another job',async t=>{
 const dir=makeDataDir(t,seedProject()),store=path.join(dir,'exports/jobs');fs.mkdirSync(store,{recursive:true});
 const browser={pid:1234,discovery:'enabled',targetCrashes:[{at:10,targetId:'page',type:'page',status:'oom',errorCode:5,ownerClosing:false}],stderrTail:'not-for-context-'.repeat(1000)+'actual tail',exit:null};
 const ids=[];
 for(const status of ['failed','cancelled','interrupted']){
  const id='x_unit'+status;ids.push(id);
  fs.writeFileSync(path.join(store,id+'.json'),JSON.stringify({id,kind:'export',status,via:'headless',progress:.6,error:'original failure retained',created:Date.now(),updated:Date.now(),diagnostics:{browser},artifacts:{schemaVersion:1,jobId:id,entries:[],stoppedSessions:[]}}));
 }
 const done={id:'x_unitdone',kind:'export',status:'done',via:'headless',progress:1,src:'/exports/one.mp4',created:Date.now(),updated:Date.now(),result:{outputs:[{file:'one.mp4',ok:true},{file:'two.mp4',ok:true}],diagnostics:{jpegReadbackRecoveries:[{frame:0,reason:'EncodingError',readback:'cpu'},{frame:2905,reason:'EncodingError',readback:'cpu'}]}}};
 fs.writeFileSync(path.join(store,done.id+'.json'),JSON.stringify(done));
 const {base,port}=await startServer(t,dir,{FABLECUT_NO_FS_WATCH:'1'}),mcp=startMcp(t,dir,{PORT:String(port),FABLECUT_NO_AUTOSTART:'1'});
 await mcp.request('initialize',{protocolVersion:'2025-11-25'});
 for(const id of ids){
  const result=await mcp.callTool('fablecut_export',{job:id});assert.equal(result.isError,false,result.text);
  assert.match(result.text,/original failure retained/);assert.match(result.text,/Original browser diagnostics:/);
  const facts=JSON.parse(result.text.split('Original browser diagnostics: ')[1]);
  assert.equal(facts.pid,1234);assert.equal(facts.targetCrashes[0].status,'oom');assert.equal(facts.targetCrashes[0].errorCode,5);
  assert.equal(facts.stderrTail.length,2048);assert.equal(facts.stderrTailTruncated,true);assert(facts.stderrTail.endsWith('actual tail'));
  assert(!result.text.includes('Check again'),'terminal receipts do not imply an active renderer');
  const saved=await fetch(base+'/api/export/job?id='+id).then(r=>r.json());assert.equal(saved.error,'original failure retained');
 }
 const result=await mcp.callTool('fablecut_export',{job:done.id});assert.equal(result.isError,false,result.text);
 assert.match(result.text,/2 of 2 files/);assert.match(result.text,/zero-based frames/);assert.match(result.text,/"frame":0/);assert.match(result.text,/"frame":2905/);
 assert.equal(fs.readdirSync(store).filter(n=>n.endsWith('.json')).length,4,'status queries never admit a replacement job');
});
