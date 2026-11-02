/* Original server/job wiring with unit-only browser/FFmpeg substitutes.
   The hard stop kills a real service PID; no encoded video or native evidence is claimed. */
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{once}=require("node:events");
const {startServer,seedProject}=require("./helpers");
async function setup(t,kind="no-gate") {
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"fablecut-recovery-api-"))),services=[];
 fs.writeFileSync(path.join(dir,"project.json"),JSON.stringify(seedProject()));fs.mkdirSync(path.join(dir,"media"));fs.writeFileSync(path.join(dir,"media/a.mp4"),"unit source bytes; never decoded");
 t.after(async()=>{try{for(const s of services)if(s.child.exitCode===null&&s.child.signalCode===null)await s.stop();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
 const boot=async()=>{const s=await startServer({after(){}},dir,{FABLECUT_NO_FS_WATCH:"1",NODE_OPTIONS:"--require "+path.join(__dirname,"fixtures/export-api-unit.cjs"),FABLECUT_EXPORT_UNIT_GATE:path.join(dir,"gate"),FABLECUT_EXPORT_UNIT_KIND:kind});services.push(s);return s;};
 const call=async(s,p,body)=>{const response=await fetch(s.base+p,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
 const receipt=id=>JSON.parse(fs.readFileSync(path.join(dir,"exports/jobs",id+".json"),"utf8"));
 const beginJob=async s=>{const j=await call(s,"/api/export/request",{profile:"draft"});assert.equal(j.status,200);assert.equal((await call(s,"/api/export/job/claim?id="+j.body.id,{})).status,200);return j.body;};
 return{dir,boot,call,receipt,beginJob};
}
test("actual service SIGKILL restores the same job and cleans its registered single output, probe and audio",async t=>{
 const {dir,boot,call,receipt,beginJob}=await setup(t),service=await boot(),j=await beginJob(service);
 const project=fs.readFileSync(path.join(dir,"project.json")),media=fs.readFileSync(path.join(dir,"media/a.mp4"));
 const begun=await call(service,"/api/export/begin",{fps:30,name:"unit recovery",hasAudio:true,profile:"draft",job:j.id});assert.equal(begun.status,200);
 const audio=await fetch(service.base+"/api/export/audio?id="+begun.body.id,{method:"POST",body:Buffer.from("unit WAV bytes; no encoder")});assert.equal(audio.status,200);
 const before=receipt(j.id);assert.equal(before.status,"running");assert.equal(before.artifacts.entries.length,4);
 const part=before.artifacts.entries.find(e=>e.kind==="part");fs.appendFileSync(path.join(dir,"exports",part.path),Buffer.alloc(48,7));
 const completed=path.join(dir,"exports/previous-done.mp4"),foreign=path.join(dir,"exports/foreign.part.mp4");fs.writeFileSync(completed,"prior complete bytes");fs.writeFileSync(foreign,"foreign partial bytes");
 const exited=once(service.child,"exit");service.child.kill("SIGKILL");await exited;
 const reopened=await boot(),original=await call(reopened,"/api/export/job?id="+j.id);
 assert.equal(original.body.status,"interrupted");assert.equal(original.body.id,j.id);assert.equal(original.body.created,before.created);assert.deepEqual(original.body.snapshot,before.snapshot);
 assert.deepEqual(original.body.cleanup,{status:"complete",removed:4,retained:0,errors:[]});
 for(const record of before.artifacts.entries)assert.equal(fs.existsSync(path.join(dir,"exports",record.path)),false,record.path);
 assert.equal(fs.readFileSync(completed,"utf8"),"prior complete bytes");assert.equal(fs.readFileSync(foreign,"utf8"),"foreign partial bytes");
 assert.deepEqual(fs.readFileSync(path.join(dir,"project.json")),project);assert.deepEqual(fs.readFileSync(path.join(dir,"media/a.mp4")),media);
 assert.deepEqual(fs.readdirSync(path.join(dir,"exports/jobs")).filter(n=>n.endsWith(".json")),[j.id+".json"]);
 assert.equal((await call(reopened,"/api/export/job/cancel?id="+j.id,{})).body.cleanupConfirmed,true);
});
test("batch begin records both collision-resolved parts and preflight files; cancel preserves a previous final",async t=>{
 const {dir,boot,call,receipt,beginJob}=await setup(t),service=await boot(),j=await beginJob(service);
 const previous=path.join(dir,"exports/collision.mp4");fs.writeFileSync(previous,"prior final; must not overwrite or remove");
 const begun=await call(service,"/api/export/begin",{fps:30,name:"batch",canvasW:1280,canvasH:720,hasAudio:false,job:j.id,deliveries:[{name:"collision",delivery:{preset:"youtube"}},{name:"second",delivery:{preset:"youtube"}}]});
 assert.equal(begun.status,200,JSON.stringify(begun.body));const saved=receipt(j.id),parts=saved.artifacts.entries.filter(e=>e.kind==="part");assert.equal(parts.length,2);assert.equal(saved.artifacts.entries.length,5);assert.equal(parts.some(e=>e.path==="collision_1.part.mp4"),true);
 for(const part of parts)fs.appendFileSync(path.join(dir,"exports",part.path),"unit encoded substitute bytes");
 const cancelled=await call(service,"/api/export/job/cancel?id="+j.id,{});assert.equal(cancelled.status,200);assert.equal(cancelled.body.cleanupConfirmed,true);assert.deepEqual(cancelled.body.cleanup,{status:"complete",removed:5,retained:0,errors:[]});
 for(const record of saved.artifacts.entries)assert.equal(fs.existsSync(path.join(dir,"exports",record.path)),false);
 assert.equal(fs.readFileSync(previous,"utf8"),"prior final; must not overwrite or remove");
});
test("failed batch preflight is already bound to its original job and leaves no registered residue",async t=>{
 const {dir,boot,call,receipt,beginJob}=await setup(t,"recovery-dry-fail"),service=await boot(),j=await beginJob(service);
 const begun=await call(service,"/api/export/begin",{fps:30,canvasW:1280,canvasH:720,hasAudio:false,job:j.id,deliveries:[{preset:"youtube"},{preset:"youtube"}]});
 assert.equal(begun.status,400);assert.match(begun.body.error,/unit preflight rejected/);
 const saved=receipt(j.id);assert.equal(saved.artifacts.entries.length,3);assert.equal(saved.cleanup.status,"complete");assert.ok(saved.artifacts.entries.every(e=>e.state==="removed"));
 for(const record of saved.artifacts.entries)assert.equal(fs.existsSync(path.join(dir,"exports",record.path)),false);
 assert.equal((await call(service,"/api/export/job/cancel?id="+j.id,{})).body.cleanupConfirmed,true);
});
test("a replaced audio link is neither overwritten nor cleaned as the original job artifact",async t=>{
 const {dir,boot,call,receipt,beginJob}=await setup(t),service=await boot(),j=await beginJob(service);
 const begun=await call(service,"/api/export/begin",{fps:30,hasAudio:true,profile:"draft",job:j.id});assert.equal(begun.status,200);
 const upload=()=>fetch(service.base+"/api/export/audio?id="+begun.body.id,{method:"POST",body:Buffer.from("unit WAV bytes")});assert.equal((await upload()).status,200);
 const audio=receipt(j.id).artifacts.entries.find(e=>e.path.endsWith("/audio.wav")),file=path.join(dir,"exports",audio.path),foreign=path.join(dir,"foreign.wav");
 fs.writeFileSync(foreign,"foreign target bytes");fs.renameSync(file,file+".original");fs.symlinkSync(foreign,file,"file");
 assert.equal((await upload()).status,500);assert.equal(fs.readFileSync(foreign,"utf8"),"foreign target bytes");
 const cancelled=await call(service,"/api/export/job/cancel?id="+j.id,{});assert.equal(cancelled.status,409);assert.equal(cancelled.body.cleanupConfirmed,false);assert.equal(cancelled.body.cleanup.status,"failed");assert.equal(fs.lstatSync(file).isSymbolicLink(),true);
});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(file){for(let i=0;i<300&&!fs.existsSync(file);i++)await pause(10);assert.equal(fs.existsSync(file),true,file);}
function slowFrame(base,id){
 const http=require("node:http");let request;
 const result=new Promise((resolve,reject)=>{request=http.request(base+"/api/export/frame?id="+id,{method:"POST",headers:{"Content-Length":"4"}},response=>{let body="";response.on("data",b=>body+=b);response.on("end",()=>resolve({status:response.statusCode,body:JSON.parse(body)}));});request.on("error",reject);request.write(Buffer.from([1]));});
 return{finish:()=>request.end(Buffer.from([2,3,4])),result};
}
test("a frame body arriving after confirmed cancel cannot start an encoder or recreate the original part",async t=>{
 const {dir,boot,call,receipt,beginJob}=await setup(t,"recovery-frame"),service=await boot(),j=await beginJob(service);
 const begun=await call(service,"/api/export/begin",{fps:30,hasAudio:false,profile:"draft",job:j.id});assert.equal(begun.status,200);
 const records=receipt(j.id).artifacts.entries,late=slowFrame(service.base,begun.body.id);await pause(30);
 const cancelled=await call(service,"/api/export/job/cancel?id="+j.id,{});assert.equal(cancelled.status,200);assert.equal(cancelled.body.cleanupConfirmed,true);
 late.finish();assert.equal((await late.result).status,409);assert.equal(fs.existsSync(path.join(dir,"gate/encoder-started")),false);
 for(const record of records)assert.equal(fs.existsSync(path.join(dir,"exports",record.path)),false);
});
test("a queued frame rechecks the same original session after cancellation closes its first encoder write",async t=>{
 const {dir,boot,call,beginJob}=await setup(t,"recovery-frame-queue"),service=await boot(),j=await beginJob(service);
 const begun=await call(service,"/api/export/begin",{fps:30,hasAudio:false,profile:"draft",job:j.id});assert.equal(begun.status,200);
 const frame=()=>fetch(service.base+"/api/export/frame?id="+begun.body.id,{method:"POST",body:Buffer.alloc(4)});
 const first=frame();await until(path.join(dir,"gate/encoder-started"));const queued=frame();await pause(20);
 const cancelled=await call(service,"/api/export/job/cancel?id="+j.id,{});assert.equal(cancelled.status,200);assert.equal(cancelled.body.cleanupConfirmed,true);
 assert.equal((await queued).status,409);assert.ok([409,500].includes((await first).status));assert.equal(fs.readFileSync(path.join(dir,"gate/encoder-started"),"utf8").trim().split("\n").length,1);
});
test("cancel joins the original loudnorm process and its late audio completion cannot acknowledge success",async t=>{
 const {dir,boot,call,beginJob}=await setup(t,"recovery-loudnorm"),service=await boot(),j=await beginJob(service);
 const begun=await call(service,"/api/export/begin",{fps:30,canvasW:1280,canvasH:720,hasAudio:true,job:j.id,delivery:{preset:"youtube",audio:{codec:"aac",loudness:-14,truePeak:-1}}});assert.equal(begun.status,200,JSON.stringify(begun.body));
 const audio=fetch(service.base+"/api/export/audio?id="+begun.body.id,{method:"POST",body:Buffer.from("unit audio mix")});await until(path.join(dir,"gate/loudnorm-started"));
 const cancelled=await call(service,"/api/export/job/cancel?id="+j.id,{});assert.equal(cancelled.status,200);assert.equal(cancelled.body.cleanupConfirmed,true);assert.equal(fs.existsSync(path.join(dir,"gate/loudnorm-stop")),true);assert.equal((await audio).status,409);
});
test("cancel joins in-flight discard and preserves failed encoder cleanup until the original encoder actually closes",async t=>{
 const {dir,boot,call,receipt,beginJob}=await setup(t,"recovery-cleanup-unconfirmed"),service=await boot(),j=await beginJob(service);
 const begun=await call(service,"/api/export/begin",{fps:30,hasAudio:false,profile:"draft",job:j.id});assert.equal(begun.status,200);
 assert.equal((await fetch(service.base+"/api/export/frame?id="+begun.body.id,{method:"POST",body:Buffer.alloc(4)})).status,200);
 const part=receipt(j.id).artifacts.entries.find(e=>e.kind==="part"),file=path.join(dir,"exports",part.path),before=fs.readFileSync(file);
 const discard=call(service,"/api/export/end?id="+begun.body.id+"&discard=1",{});await until(path.join(dir,"gate/encoder-kills"));
 const cancelled=await call(service,"/api/export/job/cancel?id="+j.id,{});assert.equal(cancelled.status,409);assert.equal(cancelled.body.encoderTermination,"unconfirmed");assert.equal(cancelled.body.cleanupConfirmed,false);assert.equal((await discard).status,409);assert.deepEqual(fs.readFileSync(file),before);
 const again=await call(service,"/api/export/job/cancel?id="+j.id,{});assert.equal(again.status,409);assert.equal(again.body.cleanupConfirmed,false);assert.deepEqual(fs.readFileSync(file),before);
 fs.writeFileSync(path.join(dir,"gate/encoder-release"),"unit actual close");await pause(30);
 const stopped=await call(service,"/api/export/job/cancel?id="+j.id,{});assert.equal(stopped.status,200);assert.equal(stopped.body.encoderTermination,"confirmed");assert.equal(stopped.body.cleanupConfirmed,true);assert.equal(fs.existsSync(file),false);
});
test("cleanup receipt I/O failures return failure and do not crash the service or become a false clean receipt",async t=>{
 const {dir,boot,call,receipt,beginJob}=await setup(t),service=await boot(),j=await beginJob(service);
 const begun=await call(service,"/api/export/begin",{fps:30,hasAudio:false,profile:"draft",job:j.id});assert.equal(begun.status,200);
 const blocker=path.join(dir,"exports/jobs",j.id+".json.tmp");fs.mkdirSync(blocker);
 const failed=await call(service,"/api/export/end?id="+begun.body.id+"&discard=1",{});assert.equal(failed.status,409);assert.equal(failed.body.cleanupConfirmed,false);
 const state=await call(service,"/api/export/job?id="+j.id);assert.equal(state.body.cleanup.status,"failed");assert.match(state.body.cleanup.errors.join(" "),/receipt persistence failed/);assert.equal((await call(service,"/api/project")).status,200);
 fs.rmdirSync(blocker);const retry=await call(service,"/api/export/end?id="+begun.body.id+"&discard=1",{});assert.equal(retry.status,200);assert.equal(retry.body.cleanupConfirmed,true);assert.equal(receipt(j.id).cleanup.status,"complete");
});
test("fire-and-forget frame-error cleanup consumes receipt write failure and leaves the service alive",async t=>{
 const {dir,boot,call,beginJob}=await setup(t),service=await boot(),j=await beginJob(service);
 const begun=await call(service,"/api/export/begin",{fps:30,hasAudio:false,profile:"draft",job:j.id});assert.equal(begun.status,200);
 const blocker=path.join(dir,"exports/jobs",j.id+".json.tmp");fs.mkdirSync(blocker);
 assert.equal((await fetch(service.base+"/api/export/frame?id="+begun.body.id,{method:"POST",body:Buffer.alloc(0)})).status,500);
 await pause(30);assert.equal((await call(service,"/api/project")).status,200);assert.equal((await call(service,"/api/export/job?id="+j.id)).body.cleanup.status,"failed");
 fs.rmdirSync(blocker);assert.equal((await call(service,"/api/export/job/cancel?id="+j.id,{})).body.cleanupConfirmed,true);
});
