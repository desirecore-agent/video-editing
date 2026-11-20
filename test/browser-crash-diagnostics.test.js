"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {createBrowserProcess}=require("../browser-process");
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail("original pipe observation timed out");}
function fixture(t,mode="observe"){
 const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),"video-editing-crash-pipe-")),crashes=[];
 const handle=createBrowserProcess(process.execPath,[path.join(__dirname,"fixtures/browser-diagnostics-child.cjs"),mode],{profileDir,onTargetCrash:event=>crashes.push(event)});
 const closed=new Promise(resolve=>handle.proc.once("close",resolve));
 t.after(async()=>{handle.close();await closed;fs.rmSync(profileDir,{recursive:true,force:true});});
 return {handle,crashes,closed};
}
test("owned CDP pipe survives split UTF-8/oversize/malformed events and retains bounded factual crash diagnostics",async t=>{
 const b=fixture(t);await until(()=>b.handle.diagnostics().discovery==="enabled"&&b.handle.diagnostics().stderrTail.endsWith("actual stderr marker\n"));
 await new Promise(r=>setTimeout(r,30));
 b.handle.proc.stdio[3].write(JSON.stringify({id:2,method:"Unit.crash"})+"\0");
 await until(()=>b.crashes.length===12);
 const d=b.handle.diagnostics();assert.equal(d.targetCrashes.length,8);
 assert.equal(b.handle.proc.exitCode,null,"a page crash is distinct from the still-live browser root");
 assert.equal(b.crashes[0].url,"http://127.0.0.1/?exportJob=unit");
 for(const c of d.targetCrashes){assert.equal(c.type,"page");assert.equal(c.status,"oom");assert.equal(c.errorCode,5);assert.equal(c.ownerClosing,false);assert(!("url" in c));}
 assert(Buffer.byteLength(d.stderrTail)<=16384);assert(!d.stderrTail.includes("\ufffd"));
 d.targetCrashes.length=0;assert.equal(b.handle.diagnostics().targetCrashes.length,8,"callers cannot mutate stored facts");
});
test("owner EOF shutdown is never reported as a natural page crash",async t=>{
 const b=fixture(t);await until(()=>b.handle.diagnostics().discovery==="enabled");
 await new Promise(r=>setTimeout(r,30));b.handle.close();await b.closed;
 assert.equal(b.crashes.length,0);assert.equal(b.handle.diagnostics().exit.ownerClosing,true);
 assert(b.handle.diagnostics().targetCrashes.every(c=>c.ownerClosing));
});
test("unsupported target discovery remains explicit and preserves ordinary EOF lifecycle",async t=>{
 const b=fixture(t,"unsupported");await until(()=>b.handle.diagnostics().discovery==="unsupported");
 assert.equal(b.handle.proc.exitCode,null);b.handle.close();await b.closed;
 assert.equal(b.crashes.length,0);assert.equal(b.handle.diagnostics().exit.code,0);
});
