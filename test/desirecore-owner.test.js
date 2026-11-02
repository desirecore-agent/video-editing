"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {makeDataDir,startServer,startMcp,readProject}=require('./helpers');
const managed=require('./fixtures/managed-runtime-env.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('MCP history owner rejects A after project switch and preserves B draft/history',async t=>{
 const dir=makeDataDir(t),service=await startServer(t,dir,managed.platform),gate=path.join(dir,'test-gate');
 const call=async(p,body)=>{const r=await fetch(service.base+p,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 const original=readProject(dir),made=await call('/api/projects',{action:'new',name:'B',open:false});
 const owner=await (await fetch(service.base+'/api/desirecore/instance')).json();
 const client=startMcp(t,dir,{PORT:String(service.port),...managed.client(owner),NODE_OPTIONS:'--require '+path.join(__dirname,'fixtures/owner-gate.cjs'),FABLECUT_OWNER_TEST_GATE:gate});
 await client.request('initialize',{protocolVersion:'2025-11-25'});
 const inFlight=client.callTool('fablecut_patch_project',{baseRevision:original.revision,ops:[{op:'updateClip',id:'c_a',set:{name:'late A'}}]});
 for(let i=0;i<300&&!fs.existsSync(path.join(gate,'ready'));i++)await pause(10);
 assert.ok(fs.existsSync(path.join(gate,'ready')),'actual MCP history request reached owner gate');
 await call('/api/projects',{action:'open',id:made.body.id});const fresh=readProject(dir);fresh.name='B NEW HUMAN DRAFT';fresh.revision++;
 const saved=await fetch(service.base+'/api/project',{method:'PUT',headers:{'Content-Type':'application/json','X-FableCut-Project':made.body.id,'X-FableCut-Base-Revision':String(fresh.revision-1)},body:JSON.stringify(fresh)});assert.equal(saved.status,200);
 const before=fs.readFileSync(path.join(dir,'project.json'),'utf8'),versionsBefore=await call('/api/versions?project='+made.body.id);
 fs.writeFileSync(path.join(gate,'release'),'release');const rejected=await inFlight;
 assert.equal(rejected.isError,true);assert.match(rejected.text,/CONFLICT/);assert.equal(fs.readFileSync(path.join(dir,'project.json'),'utf8'),before);
 const versionsAfter=await call('/api/versions?project='+made.body.id);assert.deepEqual(versionsAfter.body.versions,versionsBefore.body.versions);
});
test('UI original mutation retries after a lost response without adding a revision',async t=>{
 const dir=makeDataDir(t),service=await startServer(t,dir),doc=readProject(dir);doc.name='human pending';doc.revision++;
 const headers={'Content-Type':'application/json','X-FableCut-Project':doc.projectId,'X-FableCut-Base-Revision':String(doc.revision-1),'X-FableCut-Mutation-Id':'fixed-test-original-mutation'};
 const submit=()=>fetch(service.base+'/api/project',{method:'PUT',headers,body:JSON.stringify(doc)});
 const committed=await submit();assert.equal(committed.status,200);const original=await committed.json(); // simulate reply loss after actual commit
 const replay=await submit();assert.equal(replay.status,200);const receipt=await replay.json();assert.equal(receipt.replayed,true);assert.equal(receipt.revision,original.revision);assert.equal(readProject(dir).revision,doc.revision);
});
