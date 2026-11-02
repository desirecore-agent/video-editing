"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const Snapshots=require("../export-snapshot");
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"video-editing-snapshot-"));
  fs.mkdirSync(path.join(dir,"media"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,"media","a.mp4");
  return {dir,source,doc:{projectId:"project-a",name:"A",revision:3,media:[{id:"a",src:"/media/a.mp4"}],clips:[]}};
}
function noSnapshots(dir) {
  assert.deepEqual(fs.readdirSync(path.join(dir,"exports","snapshots")),[]);
}
test("large media capture uses bounded reads and freezes JSON before yielding",async t=>{
  const {dir,source,doc}=setup(t),bytes=Buffer.alloc(3*1024*1024+17,0x41);
  fs.writeFileSync(source,bytes);
  const open=fs.promises.open.bind(fs.promises);let reads=0,maxRead=0;
  t.mock.method(fs.promises,"open",async(...args)=>{
    const handle=await open(...args);
    if(args[0]===source&&args[1]==="r") {
      const read=handle.read.bind(handle);
      handle.read=async(buffer,...rest)=>{reads++;maxRead=Math.max(maxRead,buffer.length);return read(buffer,...rest);};
    }
    return handle;
  });
  const pending=Snapshots.capture(dir,doc);doc.name="later B";doc.media[0].src="/media/missing.mp4";
  const snapshot=await pending,frozen=JSON.parse(fs.readFileSync(Snapshots.resolveFile(dir,snapshot.projectUrl)));
  assert.equal(frozen.name,"A");assert.ok(reads>1);assert.ok(maxRead<=1024*1024,"read allocation stays bounded independently of the media size");
  const expected=crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(snapshot.receipt.files[0].bytes,bytes.length);assert.equal(snapshot.receipt.files[0].sha256,expected);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(Snapshots.resolveFile(dir,frozen.media[0].src))).digest("hex"),expected);
});
test("a source modified during copying is refused and leaves no partial snapshot",async t=>{
  const {dir,source,doc}=setup(t),bytes=Buffer.alloc(1024*1024,0x41);fs.writeFileSync(source,bytes);
  const open=fs.promises.open.bind(fs.promises);let changed=false;
  t.mock.method(fs.promises,"open",async(...args)=>{
    const handle=await open(...args);
    if(args[0]===source&&args[1]==="r") {
      const read=handle.read.bind(handle);
      handle.read=async(...readArgs)=>{const result=await read(...readArgs);if(!changed){changed=true;fs.writeFileSync(source,Buffer.alloc(bytes.length+1,0x42));}return result;};
    }
    return handle;
  });
  await assert.rejects(Snapshots.capture(dir,doc),error=>error.code===409&&/media changed/.test(error.message));
  assert.equal(changed,true);noSnapshots(dir);
});
test("failure after an earlier media copy cleans only the rejected capture",async t=>{
  const {dir,source,doc}=setup(t);fs.writeFileSync(source,"A");
  const retained=await Snapshots.capture(dir,doc);doc.media.push({id:"b",src:"/media/missing.mp4"});
  await assert.rejects(Snapshots.capture(dir,doc),/ENOENT/);
  assert.deepEqual(fs.readdirSync(path.join(dir,"exports","snapshots")),[retained.id]);
});
test("service lifecycle abort closes and removes its incomplete capture",async t=>{
  const {dir,source,doc}=setup(t);fs.writeFileSync(source,Buffer.alloc(1024*1024,0x41));
  const controller=new AbortController(),open=fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises,"open",async(...args)=>{
    const handle=await open(...args);
    if(args[0]===source&&args[1]==="r") {
      const read=handle.read.bind(handle);
      handle.read=async(...readArgs)=>{const result=await read(...readArgs);controller.abort();return result;};
    }
    return handle;
  });
  await assert.rejects(Snapshots.capture(dir,doc,{signal:controller.signal}),error=>error.code===503);
  noSnapshots(dir);
});
