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

test("the owned headless export browser can render a WebGL frame", {
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
      fetch('/result?data=' + encodeURIComponent(JSON.stringify({webgl:!!gl,pixel:[...pixel],strokes})));
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
  jobs.report(job.id, { status: "done", result: rendered });
});
