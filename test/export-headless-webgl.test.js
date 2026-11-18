/* Opt-in native regression: real export browser, WebGL draw and readback. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createExportJobs } = require("../export-jobs");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const strokeStart = source.indexOf('const mediaStroke = document.createElement("canvas");');
const strokeEnd = source.indexOf("/* ═══════════ COLOR GRADE", strokeStart);
assert(strokeStart >= 0 && strokeEnd > strokeStart);
const strokeCode = source.slice(strokeStart, strokeEnd);
const maskModule = fs.readFileSync(path.join(__dirname, "..", "background-mask.js"), "utf8");
const pixelStart = source.indexOf("const pixGL = ");
const pixelEnd = source.indexOf("/* Alpha-outline", pixelStart);
assert(pixelStart >= 0 && pixelEnd > pixelStart);
const pixelCode = source.slice(pixelStart, pixelEnd);
const svgStart = source.indexOf("function parseSvgSize(");
const svgEnd = source.indexOf("/* ═════════════ AI BACKGROUND", svgStart);
assert(svgStart >= 0 && svgEnd > svgStart);
const svgCode = source.slice(svgStart, svgEnd);
const seekStart = source.indexOf("function notePresented(");
const seekEnd = source.indexOf("/** Play forward until", seekStart);
assert(seekStart >= 0 && seekEnd > seekStart);
const seekCode = source.slice(seekStart, seekEnd);
// Generated colour only: ffmpeg -f lavfi -i color=c=0x10b070:s=1080x1920:r=30
// -t 0.5 -an -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -movflags +faststart.
const portraitVideo = fs.readFileSync(path.join(__dirname, "fixtures", "green-portrait.mp4"));

test("the owned browser renders portrait video at 4K and validates effects/SVG", {
  skip: process.env.FABLECUT_WEBGL_TEST !== "1" && "requires explicit native WebGL acceptance environment",
  timeout: 30000,
}, async t => {
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url === "/portrait.mp4") {
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), portraitVideo.length - 1) : portraitVideo.length - 1;
      if (start > end || start >= portraitVideo.length) { res.writeHead(416); res.end(); return; }
      if (range) res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${portraitVideo.length}`, "Content-Length": end - start + 1 });
      else res.setHeader("Content-Length", portraitVideo.length);
      res.end(portraitVideo.subarray(start, end + 1));
      return;
    }
    if (req.url === "/valid.svg" || req.url === "/invalid.svg") {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red" ${req.url === "/invalid.svg" ? 'fill="blue"' : ""}/></svg>`);
      return;
    }
    if (req.url.startsWith("/result?")) {
      resolveResult(JSON.parse(new URL(req.url, "http://localhost").searchParams.get("data")));
      res.end("ok");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<canvas width="2" height="2"></canvas><script>
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      ${maskModule}
      const BackgroundMask = self.FableCutBackgroundMask;
      const bgSeg = {masks:new Map()};
      const scratch = document.createElement('canvas');
      const scratchCtx = scratch.getContext('2d',{willReadFrequently:true});
      const runtime={projectGen:1,mediaAux:new Map()},state={};
      const sourceMap={valid:'valid',invalid:'invalid'};
      const getMedia=id=>({id,src:'/'+sourceMap[id]+'.svg'}),mediaTimeAt=()=>.5,projectFps=()=>30;
      ${svgCode}
      ${pixelCode}
      ${strokeCode}
      ${seekCode}
      const gl = document.querySelector('canvas').getContext('webgl');
      const pixel = new Uint8Array(4);
      if (gl) {
        gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      }
      const strokes = [];
      for (const [width, scale] of [[0,1],[3,1],[3,2]]) {
        const source = document.createElement('canvas');
        source.width = source.height = 20 * scale;
        const s = source.getContext('2d'); s.fillStyle = '#00ff00';
        s.fillRect(5 * scale, 5 * scale, 10 * scale, 10 * scale);
        const dest = document.createElement('canvas'); dest.width = dest.height = 100;
        const d = dest.getContext('2d'); d.translate(50,50);
        drawMediaStroke(d, source, {strokeWidth:width,strokeColor:'#ff00ff'}, 20,20);
        d.drawImage(source,-10,-10,20,20);
        const at = (x,y) => [...d.getImageData(x,y,1,1).data];
        strokes.push({width,scale,center:at(50,50),border:at(42,50),outside:at(39,50)});
      }
      const mask = document.createElement('canvas'); mask.width = mask.height = 4;
      const mg = mask.getContext('2d'), md = mg.createImageData(4,4);
      for(let y=0;y<4;y++)for(let x=0;x<4;x++)md.data.set([255,255,255,[0,136,166,255][x]],(y*4+x)*4);
      mg.putImageData(md,0,0); bgSeg.masks.set('qa',mask);
      const foreground = document.createElement('canvas'); foreground.width = foreground.height = 4;
      foreground.getContext('2d').fillStyle='#00ff00';foreground.getContext('2d').fillRect(0,0,4,4);
      const alphas = canvas => { const data=canvas.getContext('2d').getImageData(0,0,4,1).data;return [data[3],data[7],data[11],data[15]]; };
      const cases = [{bgRemove:true},{bgRemove:true,bgThreshold:60,bgSoftness:10},{bgRemove:true,bgThreshold:60,bgSoftness:0}];
      const gpu = cases.map(p=>{const cv=pixelPassGL({id:'qa'},p,foreground,0,0,4,4,4,4,4);return cv?alphas(cv):null;});
      const hardwareGL=pixGL.gl;
      pixGL.tried=true;pixGL.gl=null;
      const cpu = cases.map(p=>alphas(pixelPass({id:'qa'},p,foreground,0,0,4,4,4,4)));
      pixGL.gl=hardwareGL;
      (async()=>{
        const video=document.createElement('video');self.portraitProbe=video;video.muted=true;video.playsInline=true;
        const loaded=new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('portrait video decode failed'));});
        video.src='/portrait.mp4';await loaded;await hardSeekVideo(video,.2);
        const actualVideo=pixelPassGL({id:'portrait'},{temperature:2},video,0,0,video.videoWidth,video.videoHeight,1080,1920,1080);
        if(!actualVideo)throw Error('portrait video GPU pass unavailable');
        const program=document.createElement('canvas');program.width=2160;program.height=3840;
        const pg=program.getContext('2d',{willReadFrequently:true});pg.drawImage(actualVideo,0,0,2160,3840);
        const portrait={source:[video.videoWidth,video.videoHeight],canvas:[program.width,program.height],time:video.currentTime,presented:video._fcPresentedTime,pixel:[...pg.getImageData(1080,1920,1,1).data]};
        video.pause();video.removeAttribute('src');video.load();
        await prepareSvgFrame({id:'valid-clip',mediaId:'valid'},.5);
        const svgValid=!!runtime.mediaAux.get('valid').img;
        sourceMap.valid='invalid';
        let svgRelinkError;
        try { await prepareSvgFrame({id:'valid-clip',mediaId:'valid'},.5); }
        catch(error) { svgRelinkError=error.message; }
        let svgError;
        try { await prepareSvgFrame({id:'invalid-clip',mediaId:'invalid'},.5); }
        catch(error) { svgError=error.message; }
        fetch('/result?data=' + encodeURIComponent(JSON.stringify({webgl:!!gl,pixel:[...pixel],strokes,gpu,cpu,svgValid,svgError,svgRelinkError,portrait})));
      })().catch(error=>{const v=self.portraitProbe;return fetch('/result?data='+encodeURIComponent(JSON.stringify({error:error.message,video:v&&{time:v.currentTime,ready:v.readyState,seeking:v.seeking,error:v.error?.message,width:v.videoWidth,height:v.videoHeight,presented:v._fcPresentedTime,lastShown:v._fcLastShown}})));});
    </script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const jobs = createExportJobs({
    editors: () => 0, broadcast() {},
    url: id => `http://127.0.0.1:${server.address().port}/?exportJob=${id}`,
  });
  t.after(() => jobs.shutdown());
  const job = jobs.request({ kind: "scopes", where: "headless", time: 0 });
  jobs.claim(job.id);
  let timer;
  t.after(() => clearTimeout(timer));
  const rendered = await Promise.race([result, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("export browser did not report WebGL capabilities")), 20000);
  })]);
  assert.equal(rendered.error,undefined,JSON.stringify({error:rendered.error,video:rendered.video}));
  assert.ok(Math.abs(rendered.portrait.time - .2) < .002, "the source actually sought to the requested time");
  assert.ok(rendered.portrait.presented <= .2001 && rendered.portrait.presented > .15, "a real target-frame timestamp was observed");
  assert.equal(rendered.webgl, true, "segmentation requires an available WebGL context");
  assert.deepEqual(rendered.pixel, [255, 0, 0, 255]);
  for (const stroke of rendered.strokes) {
    assert.deepEqual(stroke.center, [0, 255, 0, 255], "source pixels stay above the outline");
    assert.deepEqual(stroke.outside, [0, 0, 0, 0], "padding remains transparent");
    assert.deepEqual(stroke.border, stroke.width ? [255, 0, 255, 255] : [0, 0, 0, 0],
      "stroke colour and destination width survive different source resolutions");
  }
  assert.deepEqual(rendered.cpu, [[0,136,166,255],[0,0,131,255],[0,0,255,255]]);
  for (const [i, values] of rendered.gpu.entries()) {
    assert(values, "the hardware shader must run for this native acceptance");
    values.forEach((alpha,x)=>assert(Math.abs(alpha-rendered.cpu[i][x])<=1,"GPU/CPU alpha differs"));
  }
  assert.equal(rendered.svgValid,true);
  assert.match(rendered.svgError,/svg raster failed/);
  assert.match(rendered.svgRelinkError,/svg raster failed/);
  assert.deepEqual(rendered.portrait.source,[1080,1920]);
  assert.deepEqual(rendered.portrait.canvas,[2160,3840],"background UI dimensions do not reduce the output canvas");
  const [red,green,blue,alpha]=rendered.portrait.pixel;
  assert(red<50 && green>150 && blue>70 && blue<140 && alpha>250,
    `decoded portrait pixels must survive the GPU compositor, got ${rendered.portrait.pixel}`);
  jobs.report(job.id, { status: "done", result: rendered });
});
