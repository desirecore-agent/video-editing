/* Real OS pipes, synthetic CDP events. No browser or native movie proof. */
"use strict";
const fs=require("node:fs");
const mode=process.argv[2];
if (["observe", "unsupported"].includes(mode)) {
 const input=fs.createReadStream(null,{fd:3}),output=fs.createWriteStream(null,{fd:4});
 const budget=setTimeout(()=>process.exit(2),10000);
 let pending="";
 const crash={method:"Target.targetCrashed",params:{targetId:"owned-page",status:"oom",errorCode:5}};
 const send=x=>output.write(JSON.stringify(x)+"\0");
 input.on("data",bytes=>{
  pending+=bytes.toString();let end;
  while((end=pending.indexOf("\0"))!==-1){
   const message=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);
   if(message.method==="Target.setDiscoverTargets"){
    if(mode==="unsupported"){send({id:message.id,error:{code:-32601,message:"unsupported"}});continue;}
    send({id:message.id,result:{}});
    // Oversized and malformed messages must not prevent the next valid event.
    output.write("x".repeat(70000)+"\0{invalid\0");
    const event=Buffer.from(JSON.stringify({method:"Target.targetCreated",params:{targetInfo:{targetId:"owned-page",type:"page",url:"http://127.0.0.1/?exportJob=unit",title:"测试镜头"}}})+"\0");
    const split=event.indexOf(Buffer.from("测"))+1;
    output.write(event.subarray(0,split));
    setTimeout(()=>output.write(event.subarray(split)),10);
    process.stderr.write("长日志".repeat(8000)+"\nactual stderr marker\n");
   }else if(message.method==="Unit.crash")for(let i=0;i<12;i++)send(crash);
  }
 });
 input.on("end",()=>{
  // Owner-induced target loss is observable, but must not trigger a natural
  // crash callback or overwrite the owner's already chosen terminal result.
  output.end(JSON.stringify(crash)+"\0",()=>{clearTimeout(budget);process.exit(0);});
 });
 input.on("error",()=>process.exit(3));output.on("error",()=>process.exit(4));
}
