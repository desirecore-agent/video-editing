"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const poolStart = source.indexOf("function createJpegWorkers("), poolEnd = source.indexOf("function jpegFromBitmap(", poolStart);
const stepStart = source.indexOf("function awaitExportStep("), stepEnd = source.indexOf("/** Preview may already be tainted", stepStart);
assert(poolStart >= 0 && poolEnd > poolStart && stepStart >= 0 && stepEnd > stepStart);

function pool(t, count = 1, timeout = 1000) {
  const workers = [];
  class Worker {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(data) { this.messages.push(data); }
    terminate() { this.stopped = true; }
  }
  const create = new Function("Worker", "OffscreenCanvas", "URL", "Blob", "JPEG_WORKER_SRC",
    source.slice(poolStart, poolEnd) + ";return createJpegWorkers;")(Worker, class {}, { createObjectURL: () => "unit-worker", revokeObjectURL() {} }, class {}, "unit source");
  const value = create(count, timeout);
  t.after(() => value.terminate());
  return { value, workers };
}
const bitmap = () => ({ closeCount: 0, close() { this.closeCount++; } });

test("worker failure rejects all its actual frame promises without waiting for owner stall", async t => {
  const { value, workers } = pool(t);
  const first = value.encode(bitmap(), .95, 2860), next = value.encode(bitmap(), .95, 2863);
  const checks = [assert.rejects(first, /JPEG frame 2860: worker failed: lost worker/), assert.rejects(next, /JPEG frame 2863: worker failed/ )];
  workers[0].onerror({ message: "lost worker" });
  await Promise.all(checks);
  assert.equal(workers[0].stopped, true);
  const unused = bitmap();
  await assert.rejects(value.encode(unused, .95, 2866), /worker is unavailable/);
  assert.equal(unused.closeCount, 1, "an untransferred snapshot is released");
  assert.equal(workers[0].messages.length, 2, "no replacement worker or implicit re-render");
});

test("a lost worker response times out with its exact frame and releases the worker", async t => {
  const { value, workers } = pool(t, 1, 20);
  await assert.rejects(value.encode(bitmap(), .95, 2901), /JPEG frame 2901: worker did not return a frame within 20ms/);
  assert.equal(workers[0].stopped, true);
});

test("message decode failure is explicit while an independent worker retains its own frame", async t => {
  const { value, workers } = pool(t, 2);
  const first = value.encode(bitmap(), .95, 5), second = value.encode(bitmap(), .95, 6);
  const rejected = assert.rejects(first, /JPEG frame 5: worker response could not be decoded/);
  workers[0].onmessageerror({});
  const message = workers[1].messages[0], bytes = Uint8Array.of(6).buffer;
  workers[1].onmessage({ data: { id: message.id, buf: bytes } });
  await rejected;
  assert.equal(await second, bytes);
  assert.equal(workers[1].stopped, undefined);
});

test("completed frame clears its timeout and cancellation rejects outstanding frames", async t => {
  const { value, workers } = pool(t, 1, 20);
  const completed = value.encode(bitmap(), .95, 10), msg = workers[0].messages[0];
  workers[0].onmessage({ data: { id: msg.id, buf: Uint8Array.of(10).buffer } });
  await completed;
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(workers[0].stopped, undefined);
  const waiting = value.encode(bitmap(), .95, 11), rejected = assert.rejects(waiting, /cancelled/);
  value.terminate(); await rejected;
});

test("asynchronous step timeout and rejection preserve step/frame, never retry or accept a late result", async () => {
  const step = new Function(source.slice(stepStart, stepEnd) + "; return awaitExportStep;")();
  let calls = 0, settle;
  const late = new Promise(resolve => { settle = resolve; });
  await assert.rejects(step(() => { calls++; return late; }, "frame-assets", 2860, 20), /EXPORT_FRAME 2860 frame-assets: did not finish within 20ms/);
  settle("late success");
  assert.equal(calls, 1);
  await assert.rejects(step(() => Promise.reject(new Error("exact mask unavailable")), "frame-assets", 2861, 1000), /EXPORT_FRAME 2861 frame-assets: exact mask unavailable/);
  assert.equal(await step(() => Promise.resolve("actual"), "video-seek", 2862, 1000), "actual");
});
