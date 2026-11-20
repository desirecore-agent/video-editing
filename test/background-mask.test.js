"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const Mask=require("../background-mask"),Store=require("../project-store"),{seedProject}=require("./helpers");

test("mask confidence settings preserve soft alpha by default and feather only the chosen confidence band",()=>{
  assert.equal(Mask.alpha(136/255,Mask.settings()),136/255);
  const p=Mask.settings({bgThreshold:60,bgSoftness:10});
  assert.equal(Mask.alpha(136/255,p),0);
  assert(Math.abs(Mask.alpha(.65,p)-.5)<1e-9);
  assert.equal(Mask.alpha(1,p),1);
  assert.equal(Mask.alpha(.65,Mask.settings({bgThreshold:60,bgSoftness:0})),1);
  assert.equal(Mask.alpha(.99,Mask.settings({bgThreshold:100,bgSoftness:10})),0);
  assert.equal(Mask.alpha(1,Mask.settings({bgThreshold:100,bgSoftness:10})),1);
});

test("invalid mask props refuse the original complete-project commit without changing its bytes",t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"mask-props-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,"project.json"),doc=seedProject();fs.writeFileSync(file,JSON.stringify(doc));
  const before=fs.readFileSync(file);
  for(const props of [{bgThreshold:-1},{bgThreshold:101},{bgThreshold:"60"},{bgSoftness:NaN},{bgSoftness:null}]){
    const next=structuredClone(doc);next.revision++;next.clips[0].props={...next.clips[0].props,...props};
    assert.throws(()=>Store.commit(file,next,doc.revision),/bgThreshold|bgSoftness/);
    assert.deepEqual(fs.readFileSync(file),before);
  }
});
