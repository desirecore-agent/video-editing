#!/usr/bin/env node
// Explicit, bounded native fixture. Not an editor server or a full export acceptance.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { createBrowserProcess } = require("../../browser-process.js");
const { checkedRuntime } = require("../../desirecore/runtime-resolver.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function option(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
const dataDir = option("--data-dir"), output = option("--out");
const frames = Number(option("--frames") || 3105), injection = option("--inject") || "none";
if (!dataDir || !output || !Number.isInteger(frames) || frames < 3 || frames > 6000 || !["none", "one-per-worker"].includes(injection))
  throw Error("Use --data-dir <prepared data> --out <new directory> [--frames 3..6000] [--inject none|one-per-worker]");
const runtime = checkedRuntime(path.resolve(dataDir));
const out = path.resolve(output);
await fs.mkdir(out); // Never overwrite a previous observation.
const profileDir = path.join(out, "browser-profile");
await fs.mkdir(profileDir);
const source = await fs.readFile(path.join(root, "app.js"), "utf8");
function chunk(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw Error("Production source marker missing: " + start);
  return source.slice(a, b);
}
const workerSource = chunk("const JPEG_WORKER_SRC = `", "\n`;").slice("const JPEG_WORKER_SRC = `".length);
const snapshotSource = chunk("function snapshotExportFrame()", "const JPEG_WORKER_SRC =");
const resetSource = chunk("function resetExportCanvases()", "function waitMediaEl(");
const poolSource = chunk("function createJpegWorkers(", "function jpegFromBitmap(");
const injectSource = injection === "one-per-worker" ? `
const NativeCanvas = OffscreenCanvas;
let injected = false;
self.OffscreenCanvas = class extends NativeCanvas {
  async convertToBlob(options) {
    if (!injected) { injected = true; throw new DOMException("Explicit native fixture injection", "EncodingError"); }
    return super.convertToBlob(options);
  }
};
` : "";
const browser = createBrowserProcess(runtime.chrome, [
  "--headless=new", "--enable-gpu", "--user-data-dir=" + profileDir,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio",
  ...(process.platform === "win32" ? ["--disable-accelerated-video-decode"] : []),
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows", "--window-size=800,600", "about:blank",
], { profileDir });
const { proc } = browser;
let sequence = 0, sessionId, buffer = "";
const pending = new Map();
function send(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("CDP timeout: " + method)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    proc.stdio[3].write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + "\0");
  });
}
proc.stdio[4].on("data", bytes => {
  buffer += bytes;
  let end;
  while ((end = buffer.indexOf("\0")) >= 0) {
    const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!raw) continue;
    const message = JSON.parse(raw), p = pending.get(message.id);
    if (!p) continue;
    clearTimeout(p.timer); pending.delete(message.id);
    message.error ? p.reject(Error(JSON.stringify(message.error))) : p.resolve(message.result);
  }
});
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
let lastReport;
try {
  let page;
  for (let n = 0; n < 100; n++) {
    page = (await send("Target.getTargets", {}, null)).targetInfos.find(p => p.type === "page");
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!page) throw Error("Owned fixture page missing");
  ({ sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, null));
  await evaluate(`
    "use strict";
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = 2160; sourceCanvas.height = 3840;
    const sourceContext = sourceCanvas.getContext("2d", { alpha: false });
    function exportSourceCanvas() { return sourceCanvas; }
    function canvasTaintError(error) { return error; }
    ${snapshotSource}
    const els = { preview: sourceCanvas }, adjScratch = new OffscreenCanvas(1, 1), scratch = new OffscreenCanvas(1, 1);
    const pixGL = { stage: new OffscreenCanvas(1, 1), outs: new Map() };
    let exportCropCanvas = null, exportCropCtx = null;
    ${resetSource}
    resetExportCanvases();
    const JPEG_WORKER_SRC = ${JSON.stringify(injectSource + workerSource)};
    ${poolSource}
    globalThis.fixture = { status: "running", completed: 0, frames: ${frames}, width: 2160, height: 3840,
      injection: ${JSON.stringify(injection)}, resetValidated: true, queuePeak: 0, pixelChecks: [], bytes: 0, appExportVerified: false };
    (async () => {
      const pool = createJpegWorkers(3), queue = [];
      if (!pool) throw Error("Actual native JPEG workers unavailable");
      const texture = new OffscreenCanvas(270, 480), tc = texture.getContext("2d");
      const pixels = tc.createImageData(270, 480); let seed = 8128;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.data[i] = seed & 255; pixels.data[i+1] = (seed >>> 8) & 255;
        pixels.data[i+2] = (seed >>> 16) & 255; pixels.data[i+3] = 255;
      }
      tc.putImageData(pixels, 0, 0);
      const checkCanvas = new OffscreenCanvas(1, 1), cc = checkCanvas.getContext("2d", { willReadFrequently: true });
      const color = f => [8 + (f & 15) * 16, 8 + ((f >>> 4) & 15) * 16, 8 + ((f >>> 8) & 15) * 16];
      const consume = async () => {
        const item = queue.shift(), buf = await item.promise;
        const bytes = new Uint8Array(buf);
        if (bytes.length < 128 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
          throw Error("Invalid JPEG at frame " + item.frame);
        if (item.frame < 3 || item.frame % 100 === 0 || item.frame === fixture.frames - 1) {
          const image = await createImageBitmap(new Blob([buf], { type: "image/jpeg" }));
          try {
            if (image.width !== 2160 || image.height !== 3840) throw Error("Wrong native dimensions");
            cc.drawImage(image, 64, 64, 64, 64, 0, 0, 1, 1);
            const actual = [...cc.getImageData(0, 0, 1, 1).data].slice(0, 3), expected = color(item.frame);
            if (actual.some((v, i) => Math.abs(v - expected[i]) > 8)) throw Error("Wrong snapshot pixels at frame " + item.frame);
            fixture.pixelChecks.push({ frame: item.frame, expected, actual });
          } finally { image.close(); }
        }
        fixture.bytes += bytes.length; fixture.completed++;
      };
      try {
        for (let f = 0; f < fixture.frames; f++) {
          sourceContext.drawImage(texture, 0, 0, 2160, 3840);
          sourceContext.fillStyle = "rgb(" + color(f).join(",") + ")";
          sourceContext.fillRect(0, 0, 192, 192);
          const snap = snapshotExportFrame();
          if (snap.kind !== "rgba" || snap.data.byteLength !== 2160 * 3840 * 4) throw Error("Native CPU pixel snapshot unavailable");
          const promise = pool.encodePixels(snap.data, snap.w, snap.h, .95, f);
          if (snap.data.byteLength !== 0) throw Error("CPU pixel ownership was not transferred");
          promise.catch(() => {}); // consume owns the error, including queued failures.
          queue.push({ frame: f, promise }); fixture.queuePeak = Math.max(fixture.queuePeak, queue.length);
          if (queue.length >= 7) await consume();
        }
        while (queue.length) await consume();
        fixture.recoveries = pool.readbackRecoveries(); fixture.status = "done";
      } finally { pool.terminate(); }
    })().catch(error => { fixture.status = "failed"; fixture.error = String(error.stack || error); });
  `);
  const started = Date.now();
  while (true) {
    lastReport = await evaluate("globalThis.fixture");
    console.log(JSON.stringify({ status: lastReport.status, completed: lastReport.completed, frames,
      elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
    if (lastReport.status !== "running") break;
    if (Date.now() - started > 30 * 60_000) throw Error("Bounded fixture deadline exceeded");
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  lastReport.elapsedSeconds = (Date.now() - started) / 1000;
  await fs.writeFile(path.join(out, "report.json"), JSON.stringify(lastReport, null, 2) + "\n", { flag: "wx" });
  if (lastReport.status !== "done" || lastReport.completed !== frames) throw Error(lastReport.error || "Incomplete native fixture");
  if (injection === "one-per-worker" && JSON.stringify(lastReport.recoveries.map(r => r.frame).sort((a,b) => a-b)) !== "[0,1,2]")
    throw Error("Expected exactly one same-frame recovery per worker");
  console.log(JSON.stringify({ report: path.join(out, "report.json"), completed: frames, recoveryCount: lastReport.recoveries.length, appExportVerified: false }));
} finally {
  try { await send("Browser.close", {}, null); } catch {}
  browser.close();
  await new Promise(resolve => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 6000);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error("Owned fixture closed")); }
}
