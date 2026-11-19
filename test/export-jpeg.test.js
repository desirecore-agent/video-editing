"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const workerStart = app.indexOf("const JPEG_WORKER_SRC = `") + "const JPEG_WORKER_SRC = `".length;
const workerEnd = app.indexOf("\n`;", workerStart);
assert(workerStart > 0 && workerEnd > workerStart);
const workerSource = app.slice(workerStart, workerEnd);

function worker({ gpuFailures = [], cpuFailures = [], securityFailures = [] } = {}) {
  const canvases = [], messages = [];
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const expected = { count: 0 };
  class Canvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      canvases.push(this);
      // Model a native backing-store budget without allocating video pixels.
      if (canvases.length > 4) throw new Error("native canvas backing store exhausted");
    }
    getContext(_type, options) {
      this.cpuReadback = options?.willReadFrequently === true;
      return { drawImage: bitmap => {
        if (bitmap.closed) throw new Error("cannot draw a closed bitmap");
        this.frameId = bitmap.id; this.fail = bitmap.fail;
      } };
    }
    async convertToBlob() {
      // A readback can settle after the next worker message arrives.
      await new Promise(resolve => setImmediate(resolve));
      if (this.fail) throw new Error("readback failed");
      if (securityFailures.includes(this.frameId)) {
        const error = new Error("origin is not clean"); error.name = "SecurityError"; throw error;
      }
      if ((this.cpuReadback ? cpuFailures : gpuFailures).includes(this.frameId)) {
        const error = new Error("Encoding of the source image has failed."); error.name = "EncodingError"; throw error;
      }
      const frameId = this.frameId;
      return { arrayBuffer: async () => Uint32Array.of(frameId).buffer };
    }
  }
  const self = { postMessage(message) {
    messages.push(message);
    if (messages.length === expected.count) complete();
  } };
  vm.runInNewContext(workerSource, { self, OffscreenCanvas: Canvas });
  async function send(bitmaps) {
    expected.count = bitmaps.length;
    for (const bitmap of bitmaps) self.onmessage({ data: { id: bitmap.id, bmp: bitmap } });
    await done;
    return messages;
  }
  return { send, canvases };
}

const bitmap = (id, fail = false) => ({ id, fail, width: 2160, height: 3840,
  closed: false, closeCount: 0, close() { this.closed = true; this.closeCount++; } });

test("JPEG worker keeps native canvas usage bounded across a long sequence", { timeout: 3000 }, async () => {
  const encoder = worker();
  const frames = Array.from({ length: 240 }, (_, index) => bitmap(index));
  const outputs = await encoder.send(frames);
  assert(outputs.every(output => !output.error), "all frames finish within the backing-store budget");
  assert(encoder.canvases.length <= 2);
  for (const output of outputs) assert.equal(new Uint32Array(output.buf)[0], output.id);
  assert(frames.every(frame => frame.closed));
});

test("JPEG worker reports a failed frame and continues with the next queued frame", { timeout: 3000 }, async () => {
  const encoder = worker();
  const frames = [bitmap(1, true), bitmap(2)];
  const outputs = await encoder.send(frames);
  assert.match(outputs[0].error, /readback failed/);
  assert.equal(new Uint32Array(outputs[1].buf)[0], 2);
  assert(frames.every(frame => frame.closed));
});

test("EncodingError recovers the same retained frame once, then uses bounded CPU readback", { timeout: 3000 }, async () => {
  const encoder = worker({ gpuFailures: [1, 2] });
  const frames = [bitmap(1), bitmap(2), bitmap(3)];
  const outputs = await encoder.send(frames);
  assert(outputs.every(output => !output.error));
  for (const output of outputs) assert.equal(new Uint32Array(output.buf)[0], output.id, "no substituted or reordered frame");
  assert.equal(outputs.filter(output => output.readbackRecovery).length, 1);
  assert.equal(encoder.canvases.length, 2, "one failed GPU store and one reused CPU store");
  assert.equal(encoder.canvases[0].width, 0, "retire the failed backing store");
  assert(frames.every(frame => frame.closeCount === 1), "each retained bitmap closes exactly once");
});

test("a second EncodingError fails the frame without an unbounded retry", { timeout: 3000 }, async () => {
  const encoder = worker({ gpuFailures: [1], cpuFailures: [1] });
  const frames = [bitmap(1), bitmap(2)];
  const outputs = await encoder.send(frames);
  assert.match(outputs[0].error, /Encoding of the source image has failed/);
  assert.equal(new Uint32Array(outputs[1].buf)[0], 2);
  assert.equal(encoder.canvases.length, 2);
  assert(frames.every(frame => frame.closeCount === 1));
});

test("origin-clean failures remain failures and never select a readback workaround", { timeout: 3000 }, async () => {
  const encoder = worker({ securityFailures: [1] });
  const frames = [bitmap(1), bitmap(2)];
  const outputs = await encoder.send(frames);
  assert.match(outputs[0].error, /origin is not clean/);
  assert.equal(new Uint32Array(outputs[1].buf)[0], 2);
  assert.equal(encoder.canvases.length, 1);
  assert(frames.every(frame => frame.closed));
});

test("main-thread JPEG fallback releases its native canvas after readback", async () => {
  const start = app.indexOf("function jpegFromBitmap(");
  const end = app.indexOf("/** Preview may already be tainted", start);
  const canvases = [];
  const document = { createElement() {
    const canvas = {
      getContext: () => ({ drawImage() {} }),
      toBlob: callback => callback({ arrayBuffer: async () => new ArrayBuffer(8) }),
    };
    canvases.push(canvas);
    return canvas;
  } };
  const encode = new Function("document", "canvasTaintError", app.slice(start, end) + "; return jpegFromBitmap;")(
    document, error => error);
  const source = bitmap(1);
  assert.equal((await encode(source, .92)).byteLength, 8);
  assert(source.closed);
  assert.equal(canvases[0].width, 0);
  assert.equal(canvases[0].height, 0);
});
