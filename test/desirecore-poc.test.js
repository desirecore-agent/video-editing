"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const Store=require("../project-store"),Snapshots=require("../export-snapshot"),{createExportJobs}=require("../export-jobs");
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"fablecut-poc-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test("two readers cannot overwrite each other with a larger self-selected revision",t=>{
 const dir=temp(t),file=path.join(dir,"project.json");fs.writeFileSync(file,JSON.stringify({revision:1,name:"initial"}));
 const human=Store.read(file),agent=Store.read(file);human.revision=2;human.name="human";Store.commit(file,human);
 agent.revision=100;agent.name="stale agent";assert.throws(()=>Store.commit(file,agent),/CONFLICT/);
 assert.deepEqual(Store.read(file),human);assert.equal(fs.existsSync(file+".write-lock"),false);
});
test("snapshot retains exact submitted bytes when the same source path is replaced",async t=>{
 const dir=temp(t);fs.mkdirSync(path.join(dir,"media"));const source=path.join(dir,"media","clip.mp4");fs.writeFileSync(source,"A");
 const doc={revision:7,name:"SUBMITTED A",media:[{id:"m1",src:"/media/clip.mp4"}],clips:[{props:{text:"SUBMITTED A"}}]};
 const snap=await Snapshots.capture(dir,doc);fs.writeFileSync(source,"B");doc.clips[0].props.text="EDITED B";
 const frozen=JSON.parse(fs.readFileSync(Snapshots.resolveFile(dir,snap.projectUrl)));
 assert.equal(frozen.clips[0].props.text,"SUBMITTED A");assert.equal(fs.readFileSync(Snapshots.resolveFile(dir,frozen.media[0].src),"utf8"),"A");
 assert.equal(snap.receipt.projectRevision,7);assert.equal(snap.receipt.files[0].bytes,1);
});
test("restart retains the original running job id and marks it interrupted",t=>{
 const dir=temp(t),opts={storeDir:dir,editors:()=>1,broadcast:()=>{},url:id=>id};
 const first=createExportJobs(opts),j=first.request({where:"tab"});assert.equal(first.claim(j.id),true);first.shutdown();
 const restored=createExportJobs(opts);t.after(()=>restored.shutdown());
 assert.equal(restored.get(j.id).id,j.id);assert.equal(restored.get(j.id).status,"interrupted");assert.equal(restored.claim(j.id),false);
});
test("cancel invokes cleanup for exactly the cancelled original job",t=>{
 const cancelled=[],jobs=createExportJobs({storeDir:temp(t),editors:()=>1,broadcast:()=>{},url:id=>id,onCancel:id=>cancelled.push(id)});t.after(()=>jobs.shutdown());
 const j=jobs.request({where:"tab"});jobs.claim(j.id);assert.equal(jobs.cancel(j.id).status,"cancelled");assert.deepEqual(cancelled,[j.id]);
});
