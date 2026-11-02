// Explicit test-only preload. Pauses a real MCP owner request, never supplies state.
const fs=require('fs'),http=require('http'),path=require('path');
const dir=process.env.FABLECUT_OWNER_TEST_GATE;
if(dir){let used=false;const original=http.request;
 http.request=function(url,options,...rest){const request=original.call(this,url,options,...rest);
  if(!used&&options?.method==='POST'&&String(url).endsWith('/api/versions')){
   const end=request.end;request.end=function(...args){used=true;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'ready'),String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'release'))){clearInterval(timer);end.apply(request,args)}},10);return request;};
  }return request;
 };
}
