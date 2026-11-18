"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const a = source.indexOf("const bgSeg = "), b = source.indexOf("/* ═══════════ PIXEL PIPELINE", a);
assert(a >= 0 && b > a);
function load({ offline = false, mode = "ok" } = {}) {
  const calls = [];
  const control = { mode };
  class Segmentation {
    setOptions() {}
    onResults(callback) { this.callback = callback; }
    async send({ image }) {
      calls.push(image.frame);
      await new Promise(resolve => setImmediate(resolve));
      if (control.mode === "error") throw new Error("model refused frame");
      if (control.mode !== "empty") this.callback({ segmentationMask: { width: 2, height: 2, frame: image.frame } });
    }
  }
  const document = {
    head: { appendChild(script) { setImmediate(() => offline ? script.onerror() : script.onload()); } },
    createElement(kind) {
      if (kind === "script") return {};
      const canvas = { getContext: () => ({ drawImage(image) { canvas.frame = image.frame; } }) };
      return canvas;
    },
  };
  const context = { document, SelfieSegmentation: Segmentation, toast() {} };
  vm.runInNewContext(source.slice(a, b) + "; globalThis.api = {bgSeg, ensureBgSeg, requestMask};", context);
  return { ...context.api, calls, control };
}
const image = frame => ({ frame, videoWidth: 360, videoHeight: 640 });
test("the first forced cutout waits for loading AND inference before returning its mask", async () => {
  const api = load();
  await api.requestMask("person", image(1), true);
  assert.deepEqual(api.calls, [1]);
  assert.equal(api.bgSeg.masks.get("person")?.frame, 1);
});
test("a missing segmentation runtime refuses a forced frame instead of retaining the rectangle", async () => {
  await assert.rejects(load({ offline: true }).requestMask("person", image(1), true), /script load failed/);
});
test("inference failure refuses a forced frame and a later explicit request can recover", async () => {
  const api = load({ mode: "error" });
  await api.ensureBgSeg();
  await assert.rejects(api.requestMask("person", image(1), true), /model refused frame/);
  api.control.mode = "ok";
  await api.requestMask("person", image(2), true);
  assert.equal(api.bgSeg.masks.get("person")?.frame, 2);
  assert.equal(api.bgSeg.pending, 0);
});
test("a resolved inference without a new result cannot reuse a stale mask", async () => {
  const api = load();
  await api.ensureBgSeg();
  await api.requestMask("person", image(1), true);
  api.control.mode = "empty";
  await assert.rejects(api.requestMask("person", image(2), true), /mask result unavailable/);
});
test("forced masks remain serialized across frames", async () => {
  const api = load();
  await api.ensureBgSeg();
  await Promise.all([api.requestMask("one", image(1), true), api.requestMask("two", image(2), true)]);
  assert.deepEqual(api.calls, [1, 2]);
  assert.equal(api.bgSeg.masks.get("one")?.frame, 1);
  assert.equal(api.bgSeg.masks.get("two")?.frame, 2);
});
test("shared frame preparation reports the clip/time when segmentation fails", async () => {
  const start = source.indexOf("async function prepareFrameAssets("), end = source.indexOf("/* UI exports", start);
  const clip = { id: "person", kind: "video", props: { bgRemove: true } };
  const env = { mediaClips: () => [clip], activeAt: () => true, clipRenders: () => true,
    getClipEl: () => image(1), requestMask: async () => { throw new Error("model unavailable"); } };
  const prepare = new Function(...Object.keys(env), source.slice(start, end) + "; return prepareFrameAssets;")(...Object.values(env));
  await assert.rejects(prepare(1.25), /BACKGROUND_MASK_UNAVAILABLE.*person.*1\.250.*model unavailable/);
});
