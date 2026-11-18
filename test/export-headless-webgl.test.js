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

test("the owned export browser renders WebGL, mask refinement and scaled strokes", {
  skip: process.env.FABLECUT_WEBGL_TEST !== "1" && "requires explicit native WebGL acceptance environment",
  timeout: 30000,
}, async t => {
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  const server = http.createServer((req, res) => {
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
      ${pixelCode}
      ${strokeCode}
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
      pixGL.tried=true;pixGL.gl=null;
      const cpu = cases.map(p=>alphas(pixelPass({id:'qa'},p,foreground,0,0,4,4,4,4)));
      fetch('/result?data=' + encodeURIComponent(JSON.stringify({webgl:!!gl,pixel:[...pixel],strokes,gpu,cpu})));
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
  jobs.report(job.id, { status: "done", result: rendered });
});
