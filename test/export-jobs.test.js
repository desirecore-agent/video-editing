/* Snapshot export HTTP/MCP ownership, with unit-only process substitutes.
   No browser, movie encoding or native acceptance is simulated as passed. */
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {makeDataDir,seedProject,startServer,startMcp}=require("./helpers");
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const post=(base,p,body)=>fetch(base+p,{method:"POST",headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)})
  .then(async r=>({status:r.status,body:await r.json()}));
function exportState(dir) {
  const tree=relative=>{
    const root=path.join(dir,relative),files=[];
    if(!fs.existsSync(root))return files;
    const walk=p=>{for(const name of fs.readdirSync(path.join(root,p)).sort()){
      const file=path.join(p,name),full=path.join(root,file);
      if(fs.statSync(full).isDirectory())walk(file);
      else files.push([file,fs.readFileSync(full).toString("hex")]);
    }};
    walk("");return files;
  };
  return {project:fs.readFileSync(path.join(dir,"project.json")).toString("hex"),media:tree("media"),exports:tree("exports")};
}
async function boot(t,kind="no-gate") {
  const dir=makeDataDir(t,seedProject({revision:7}));
  fs.mkdirSync(path.join(dir,"media"));fs.writeFileSync(path.join(dir,"media","a.mp4"),"unit media; never decoded");
  const service=await startServer(t,dir,{
    FABLECUT_NO_FS_WATCH:"1",FABLECUT_CHROME:path.join(dir,"no-such-browser"),
    NODE_OPTIONS:"--require "+path.join(__dirname,"fixtures/export-api-unit.cjs"),
    FABLECUT_EXPORT_UNIT_GATE:path.join(dir,"gate"),FABLECUT_EXPORT_UNIT_KIND:kind,
  });
  return {dir,...service};
}
async function onlyTicket(dir,base) {
  const jobs=path.join(dir,"exports","jobs");
  for(let i=0;i<300;i++) {
    const files=fs.existsSync(jobs)?fs.readdirSync(jobs).filter(n=>/^x_.*\.json$/.test(n)):[];
    if(files.length){assert.equal(files.length,1);return fetch(base+"/api/export/job/ticket?id="+files[0].slice(0,-5)).then(r=>r.json());}
    await pause(10);
  }
  assert.fail("original export job was not admitted");
}
test("export validates range and profile before admission",async t=>{
  const {base}=await boot(t);
  assert.equal((await post(base,"/api/export/request",{range:"half"})).status,400);
  assert.equal((await post(base,"/api/export/request",{profile:"no-such-profile"})).status,400);
});
test("export rejects tab and invalid renderer modes before capture or any job side effect",async t=>{
  const {dir,base}=await boot(t,"capture"),before=exportState(dir);
  try {
    for(const [where,status,error] of [
      ["tab",409,/tab.*not supported.*frozen snapshot/i],
      ...["elsewhere","",null,false,0,{},[]].map(where=>[where,400,/where must be/i]),
    ]) {
      const response=await fetch(base+"/api/export/request",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({where}),signal:AbortSignal.timeout(1500)});
      assert.equal(response.status,status,JSON.stringify(where));assert.match((await response.json()).error,error);
      assert.equal(fs.existsSync(path.join(dir,"gate","ready")),false,"the snapshot capture boundary was never entered");
      assert.deepEqual(exportState(dir),before,"a refused renderer must not change project, media, snapshots or jobs");
    }
    for(const body of [null,[],false,"tab"]) {
      const response=await post(base,"/api/export/request",body);
      assert.equal(response.status,400);assert.match(response.body.error,/request must be an object/);
      assert.equal(fs.existsSync(path.join(dir,"gate","ready")),false);
      assert.deepEqual(exportState(dir),before,"invalid request shapes have no export side effects");
    }
  } finally {
    // Unblock the unit capture substitute if old code reached it, so a red
    // regression can still clean up its own temporary server.
    if(fs.existsSync(path.join(dir,"gate","ready")))fs.writeFileSync(path.join(dir,"gate","release"),"unit cleanup");
  }
});
for(const where of [undefined,"auto","headless"])test(`export ${where===undefined?"omitted renderer":where} admits the original frozen headless document`,async t=>{
  const {base}=await boot(t);
  const admitted=await post(base,"/api/export/request",{...(where===undefined?{}:{where}),range:"entire"});
  assert.equal(admitted.status,200);assert.equal(admitted.body.via,"headless");
  assert.equal(admitted.body.snapshot.receipt.projectRevision,7);assert.equal(admitted.body.snapshot.receipt.files.length,1);
});
test("export MCP schema advertises frozen modes without narrowing the other tab tools",async t=>{
  const {dir,port}=await boot(t),mcp=startMcp(t,dir,{PORT:String(port),FABLECUT_NO_AUTOSTART:"1"});
  await mcp.request("initialize",{protocolVersion:"2025-11-25"});
  const listed=await mcp.request("tools/list"),tools=listed.result.tools;
  assert.deepEqual(tools.find(tool=>tool.name==="fablecut_export").inputSchema.properties.where.enum,["auto","headless"]);
  for(const name of ["fablecut_frame","fablecut_scopes","fablecut_track"])
    assert.ok(tools.find(tool=>tool.name===name).inputSchema.properties.where.enum.includes("tab"),name+" keeps its tab capability");
});
test("raw MCP export preserves invalid renderer arguments for rejection without creating a job",async t=>{
  const {dir,port}=await boot(t),mcp=startMcp(t,dir,{PORT:String(port),FABLECUT_NO_AUTOSTART:"1"}),before=exportState(dir);
  await mcp.request("initialize",{protocolVersion:"2025-11-25"});
  for(const where of ["tab","elsewhere","",null,false,0]) {
    const result=await mcp.callTool("fablecut_export",{where,wait:false});
    assert.equal(result.isError,true,JSON.stringify(where)+": "+result.text);
    assert.match(result.text,where==="tab"?/tab.*not supported.*frozen snapshot/i:/where must be/i);
    assert.deepEqual(exportState(dir),before,"MCP cannot replace an invalid renderer choice with an admitted job");
  }
});
test("a missing prepared browser fails admission and removes its unowned snapshot",async t=>{
  const {dir,base}=await boot(t,"no-browser");
  const refused=await post(base,"/api/export/request",{});
  assert.equal(refused.status,409);assert.match(refused.body.error,/FABLECUT_CHROME/);
  assert.deepEqual(fs.readdirSync(path.join(dir,"exports","snapshots")),[]);
});
test("the original snapshot job claims once, reports progress and returns its MCP result",async t=>{
  const {dir,base,port}=await boot(t);
  const mcp=startMcp(t,dir,{PORT:String(port),FABLECUT_NO_AUTOSTART:"1"});
  await mcp.request("initialize",{protocolVersion:"2025-11-25"});
  const pending=mcp.callTool("fablecut_export",{range:"entire"});
  const ticket=await onlyTicket(dir,base);
  assert.equal(ticket.range,"entire");assert.equal(ticket.revision,7);assert.ok(ticket.snapshot.projectUrl);
  assert.equal((await post(base,"/api/export/job/claim?id="+ticket.id)).status,200);
  assert.equal((await post(base,"/api/export/job/claim?id="+ticket.id)).status,409);
  assert.deepEqual((await post(base,"/api/export/job/report?id="+ticket.id,{progress:0.5})).body,{cancel:false});
  const running=await fetch(base+"/api/export/job?id="+ticket.id).then(r=>r.json());
  assert.equal(running.status,"running");assert.equal(running.progress,0.5);
  // A tiny fixture file only exercises result-path transport, not rendering.
  fs.writeFileSync(path.join(dir,"exports","Test Project.mp4"),Buffer.alloc(16));
  await post(base,"/api/export/job/report?id="+ticket.id,{status:"done",src:"/exports/Test%20Project.mp4"});
  const result=await pending;assert.equal(result.isError,false,result.text);
  assert.match(result.text,/done → .*Test Project\.mp4/);assert.ok(result.text.includes(path.join(dir,"exports")));
});
test("one snapshot job at a time and cancelling frees its original owner slot",async t=>{
  const {dir,base,port}=await boot(t),first=await post(base,"/api/export/request",{});
  assert.equal(first.status,200);const id=first.body.id;
  await post(base,"/api/export/job/claim?id="+id);
  const busy=await post(base,"/api/export/request",{});assert.equal(busy.status,409);assert.match(busy.body.error,/still running/);
  const mcp=startMcp(t,dir,{PORT:String(port),FABLECUT_NO_AUTOSTART:"1"});await mcp.request("initialize",{protocolVersion:"2025-11-25"});
  assert.match((await mcp.callTool("fablecut_export",{job:id})).text,/running/);
  assert.match((await mcp.callTool("fablecut_export",{cancel:id})).text,/cancelled/);
  assert.deepEqual((await post(base,"/api/export/job/report?id="+id,{progress:0.6})).body,{cancel:true});
  assert.equal((await post(base,"/api/export/request",{})).status,200);
});
