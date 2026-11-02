"use strict";
/* Only the service process commits. MCP submits through its HTTP owner.
   Project switches and edits are synchronous in that one event loop; no
   cross-process lock file can survive a crashed writer. */
const fs=require("fs"),crypto=require("crypto");
const bases=new WeakMap();
function read(file){const doc=JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));bases.set(doc,{revision:doc.revision||0,projectId:doc.projectId});return doc;}
function base(doc){return bases.get(doc);}
function atomic(file,doc){const tmp=file+"."+crypto.randomUUID()+".tmp";const fd=fs.openSync(tmp,"wx");try{fs.writeFileSync(fd,JSON.stringify(doc,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
function commit(file,doc,expected=base(doc)?.revision,options={}){
 const cur=read(file),current=cur.revision||0;
 const incoming=structuredClone(doc);delete incoming._lastMutation;
 const bodyHash=crypto.createHash("sha256").update(JSON.stringify(incoming)).digest("hex");
 if(options.mutationId&&cur._lastMutation?.id===options.mutationId){
  if(cur._lastMutation.bodyHash!==bodyHash)throw Object.assign(Error("CONFLICT — mutation id reused for different content"),{code:409,revision:current});
  return {revision:current,replayed:true};
 }
 if(options.projectId&&options.projectId!==cur.projectId)throw Object.assign(Error("CONFLICT — another project is open"),{code:409,revision:current});
 if(!Number.isInteger(expected)||expected!==current||doc.revision!==current+1)throw Object.assign(Error(`CONFLICT — expected revision ${expected}, current revision ${current}`),{code:409,revision:current});
 if(cur.projectId)incoming.projectId=cur.projectId;
 if(options.mutationId)incoming._lastMutation={id:options.mutationId,bodyHash};
 atomic(file,incoming);bases.set(doc,{revision:doc.revision,projectId:incoming.projectId});return {revision:doc.revision,replayed:false};
}
module.exports={read,base,commit,atomic};
