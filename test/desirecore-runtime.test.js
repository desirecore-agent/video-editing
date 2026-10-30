"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),http=require("node:http");
const Runtime=require("../managed-runtime"),fixture=require("./fixtures/managed-runtime-env.cjs");
const {makeDataDir,startMcp,startServer,readProject}=require("./helpers");
test("platform identity is either wholly absent or complete; it cannot silently downgrade",()=>{
  assert.equal(Runtime.identity({}),null);
  assert.throws(()=>Runtime.identity({DESIRECORE_APP_RUNTIME_PROOF:"unit-private-proof"}),/incomplete or invalid/);
  assert.throws(()=>Runtime.identity({...fixture.platform,DESIRECORE_APP_SCOPE_ID:""}),/incomplete or invalid/);
  assert.equal(Runtime.identity(fixture.platform).runtimeGeneration,fixture.platform.DESIRECORE_APP_RUNTIME_GENERATION);
});
test("managed attachment requires all four exact fields and a managed peer",t=>{
  const dir=makeDataDir(t),owner={instanceId:"unit-instance",scopeId:"unit-scope",runtimeGeneration:"unit-generation",releaseDigest:"unit-release",dataDir:fs.realpathSync(dir),port:7777,managed:true};
  const env=fixture.client(owner);
  assert.deepEqual(Runtime.verifyService(owner,dir,7777,env),owner);
  for(const key of Object.keys(env).filter(k=>k.startsWith("FABLECUT_EXPECTED_"))) {
    assert.throws(()=>Runtime.verifyService(owner,dir,7777,{...env,[key]:""}),/incomplete or invalid/);
    assert.throws(()=>Runtime.verifyService(owner,dir,7777,{...env,[key]:"other-generation"}),/identity does not match/);
  }
  assert.throws(()=>Runtime.verifyService({...owner,managed:false},dir,7777,env),/identity does not match/);
});
test("managed MCP refuses a new instance at the same URL instead of following it",async t=>{
  const dir=makeDataDir(t);let owner;
  const server=http.createServer((req,res)=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(owner));});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}));
  const port=server.address().port;owner={instanceId:"unit-old",scopeId:"unit-scope",runtimeGeneration:"unit-generation",releaseDigest:"unit-release",dataDir:fs.realpathSync(dir),port,managed:true};
  const mcp=startMcp(t,dir,{PORT:String(port),...fixture.client(owner)});
  await mcp.request("initialize",{protocolVersion:"2025-11-25"});
  assert.equal((await mcp.callTool("fablecut_get_project")).isError,false);
  owner={...owner,instanceId:"unit-next",runtimeGeneration:"unit-next-generation"};
  const refused=await mcp.callTool("fablecut_get_project");assert.equal(refused.isError,true);assert.match(refused.text,/bound generation/);
});
test("managed binary frames carry the bound owner and refuse a replacement after probing",async t=>{
  const dir=makeDataDir(t),jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]),events=[],frames=[];
  let owner,replaceOnFrame=false;
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,"http://localhost");
    if(url.pathname==="/api/desirecore/instance") {
      events.push({type:"probe",instanceId:owner.instanceId});
      res.setHeader("Content-Type","application/json");res.end(JSON.stringify(owner));return;
    }
    if(url.pathname!=="/api/frame") {res.writeHead(404);res.end();return;}
    // A different service now owns the URL after the successful identity probes.
    // Its request boundary must reject the old binding before any decoder runs.
    if(replaceOnFrame) {
      owner={...owner,instanceId:"unit-next",scopeId:"unit-next-scope",runtimeGeneration:"unit-next-generation",releaseDigest:"unit-next-release"};
      events.push({type:"replacement",instanceId:owner.instanceId});
    }
    const frame={headers:req.headers,status:200};frames.push(frame);events.push({type:"frame",instanceId:owner.instanceId});
    try {Runtime.verifyRequest(owner,req.headers);}
    catch(error) {frame.status=error.code;res.writeHead(error.code,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message}));return;}
    res.writeHead(200,{"Content-Type":"image/jpeg"});res.end(jpeg);
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}));
  const port=server.address().port;
  owner={instanceId:"unit-old",scopeId:"unit-scope",runtimeGeneration:"unit-generation",releaseDigest:"unit-release",dataDir:fs.realpathSync(dir),port,managed:true};
  const boundOwner={...owner},expectedHeaders=Runtime.requestHeaders(fixture.client(boundOwner));
  const mcp=startMcp(t,dir,{PORT:String(port),...fixture.client(boundOwner)});
  await mcp.request("initialize",{protocolVersion:"2025-11-25"});
  const accepted=await mcp.callTool("fablecut_frame",{path:"/media/a.mp4"});
  assert.equal(accepted.isError,false,accepted.text);
  assert.deepEqual(accepted.content.find(block=>block.type==="image"),{type:"image",mimeType:"image/jpeg",data:jpeg.toString("base64")});
  assert.equal(frames[0].status,200);

  events.length=0;replaceOnFrame=true;
  const refused=await mcp.callTool("fablecut_frame",{path:"/media/a.mp4"});
  assert.ok(events.filter(event=>event.type==="probe").length>0);
  assert.ok(events.filter(event=>event.type==="probe").every(event=>event.instanceId===boundOwner.instanceId));
  assert.deepEqual(events.slice(-2).map(event=>event.type),["replacement","frame"]);
  assert.equal(frames.length,2);
  assert.equal(frames[1].status,409);
  assert.equal(refused.isError,true);assert.match(refused.text,/different bound generation/);
  assert.equal(refused.content.some(block=>block.type==="image"),false);
  for(const frame of frames) {
    for(const [header,value] of Object.entries(expectedHeaders))assert.equal(frame.headers[header],value,header);
    assert.equal(frame.headers["x-fablecut-client"],"mcp");
  }
});
test("patch schema and service both honor explicit projectId plus baseRevision",async t=>{
  const dir=makeDataDir(t),service=await startServer(t,dir,fixture.platform);
  const owner=await (await fetch(service.base+"/api/desirecore/instance")).json();
  const mcp=startMcp(t,dir,{PORT:String(service.port),...fixture.client(owner)});
  await mcp.request("initialize",{protocolVersion:"2025-11-25"});
  const listed=await mcp.request("tools/list"),schema=listed.result.tools.find(x=>x.name==="fablecut_patch_project").inputSchema;
  assert.equal(schema.properties.projectId.type,"string");assert.equal(schema.properties.baseRevision.type,"integer");
  const doc=readProject(dir),before=JSON.stringify(doc),ops=[{op:"updateClip",id:"c_a",set:{name:"bound edit"}}];
  for(const target of [{projectId:"other-project",baseRevision:doc.revision},{projectId:doc.projectId,baseRevision:doc.revision-1}]) {
    const refused=await mcp.callTool("fablecut_patch_project",{...target,ops});assert.equal(refused.isError,true);assert.match(refused.text,/CONFLICT/);assert.equal(JSON.stringify(readProject(dir)),before);
  }
  const accepted=await mcp.callTool("fablecut_patch_project",{projectId:doc.projectId,baseRevision:doc.revision,ops});
  assert.equal(accepted.isError,false,accepted.text);assert.equal(readProject(dir).clips[0].name,"bound edit");
});
test("the service rejects a stale managed generation at the write boundary",async t=>{
  const dir=makeDataDir(t),service=await startServer(t,dir,fixture.platform);
  const owner=await (await fetch(service.base+"/api/desirecore/instance")).json();
  const original=readProject(dir),changed={...original,name:"must not cross generations",revision:original.revision+1};
  const headers={"Content-Type":"application/json","X-FableCut-Project":original.projectId,"X-FableCut-Base-Revision":String(original.revision),...Runtime.requestHeaders(fixture.client(owner))};
  const refused=await fetch(service.base+"/api/project",{method:"PUT",headers:{...headers,"x-fablecut-expected-instance":"old-instance"},body:JSON.stringify(changed)});
  assert.equal(refused.status,409);assert.deepEqual(readProject(dir),original);
  const accepted=await fetch(service.base+"/api/project",{method:"PUT",headers,body:JSON.stringify(changed)});
  assert.equal(accepted.status,200);assert.equal(readProject(dir).name,changed.name);
});
