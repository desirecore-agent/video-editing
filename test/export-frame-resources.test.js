/* Bounded facts from the original export; synthetic counters/process owners.
 * These tests do not encode media or certify a native movie. */
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createExportJobs } = require("../export-jobs");
const { makeDataDir, seedProject } = require("./helpers");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("frame facts count the actual decoder/HTML/worker queues without retaining media", () => {
  const a = source.indexOf("function exportFrameResources("), b = source.indexOf("\nasync function reportExportJob(", a);
  assert(a >= 0 && b > a, "the app must report its actual selected path");
  const held = { close() { assert.fail("observing must not release a frame"); } };
  const context = {
    runtime: {
      exportDecode: { sources: new Map([["native", { cur: held, out: [held, held], dec: { decodeQueueSize: 3 } }], ["fallback", null]]) },
      exportFrames: new Map([["native", held]]),
      clipEls: new Map([["video", { tagName: "VIDEO" }], ["audio", { tagName: "AUDIO" }]]),
      audioBufs: new Map([["private source omitted", Promise.resolve(null)]]),
    },
  };
  vm.runInNewContext(source.slice(a, b) + ";globalThis.sample = exportFrameResources;", context);
  const result = JSON.parse(JSON.stringify(context.sample(60, 6, 4, {})));
  assert.deepEqual(result, {
    frame: 60, pixelsInflight: 6, uploadsInflight: 4, jpegWorkerEnabled: 1,
    decoders: 1, decoderQueuedChunks: 3, decoderQueuedFrames: 2, decoderHeldFrames: 1,
    decodedVideoClips: 1, htmlVideoElements: 1, audioBufferEntries: 1,
  });
  assert.equal(context.sample(61, 0, 0, null).jpegWorkerEnabled, 0, "workerless fallback is explicit");
  assert.equal(context.runtime.exportFrames.get("native"), held);
});

function ownedJobs(t) {
  const dir = makeDataDir(t, seedProject()), storeDir = path.join(dir, "export-facts");
  const jobs = createExportJobs({ storeDir, editors: () => 0, broadcast() {}, launchBrowser(j) {
    j.browser = { close() {}, diagnostics: () => ({ pid: 123, discovery: "enabled", targetCrashes: [] }) };
  } });
  t.after(() => jobs.shutdown());
  const admitted = jobs.request({ where: "headless", range: "entire" });
  assert(jobs.claim(admitted.id));
  return { jobs, storeDir, id: admitted.id };
}

test("original job keeps only latest/peak numeric facts across failure and restart", t => {
  const { jobs, storeDir, id } = ownedJobs(t);
  for (let frame = 1; frame <= 1000; frame++) jobs.report(id, {
    progress: frame / 2000,
    frameResources: { frame, decoders: frame === 1 ? 2 : 1, pixelsInflight: 7,
      uploadsInflight: 4, jpegWorkerEnabled: 1, privateSource: "/do-not-persist.mp4" },
  });
  const running = jobs.get(id).diagnostics?.frameResources;
  assert(running, "original reports must retain observed compositor facts");
  assert.deepEqual(running.last, { frame: 1000, pixelsInflight: 7, uploadsInflight: 4, jpegWorkerEnabled: 1, decoders: 1 });
  assert.equal(running.peak.decoders, 2);
  assert.equal(running.sampleCount, 1000);
  assert(!JSON.stringify(running).includes("privateSource"));
  assert(!JSON.stringify(running).includes("/do-not"));
  jobs.report(id, { status: "failed", error: "original failure" });
  assert.equal(jobs.get(id).diagnostics.browser.pid, 123);
  assert.deepEqual(jobs.get(id).diagnostics.frameResources, running, "browser termination must not erase frame facts");
  assert(fs.statSync(path.join(storeDir, id + ".json")).size < 4096, "receipt size must not grow with frame count");
  const restored = createExportJobs({ storeDir, broadcast() {} }); t.after(() => restored.shutdown());
  assert.equal(restored.get(id).status, "failed");
  assert.equal(restored.get(id).error, "original failure");
  assert.deepEqual(restored.get(id).diagnostics.frameResources, running);
});

test("invalid counters are omitted and terminal reports cannot rewrite original facts", t => {
  const { jobs, id } = ownedJobs(t);
  jobs.report(id, { frameResources: { frame: 12, pixelsInflight: -1, uploadsInflight: Infinity,
    decoders: "1", jpegWorkerEnabled: NaN, decoderQueuedFrames: 1.5, decoderHeldFrames: Number.MAX_SAFE_INTEGER + 1 } });
  const facts = jobs.get(id).diagnostics?.frameResources;
  assert(facts, "the valid numeric fact survives malformed neighbours");
  assert.deepEqual(facts.last, { frame: 12 });
  jobs.report(id, { frameResources: { privatePayload: ["excluded"] } });
  assert.deepEqual(jobs.get(id).diagnostics.frameResources, facts);
  jobs.report(id, { status: "done", src: "/exports/fixture-only.mp4" });
  const before = jobs.get(id);
  jobs.report(id, { status: "failed", error: "replacement", frameResources: { frame: 999 } });
  assert.deepEqual(jobs.get(id), before, "late reports never reclassify or mutate a terminal job");
});

test("the heartbeat samples after throttling, and absent samplers keep old reports unchanged", async () => {
  const a = source.indexOf("let exportJobReportAt = "), b = source.indexOf("async function runExportJob(", a);
  const sent = []; let now = 1001, samples = 0;
  const context = { performance: { now: () => now }, renderCancelled: false, exportAbort: null,
    fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ cancel: false }) }; } };
  vm.runInNewContext(source.slice(a, b) + ";globalThis.report = reportExportJob;", context);
  const sample = () => { samples++; return { frame: 20 }; };
  await context.report("original", { progress: .2 }, false, sample);
  now = 1100; await context.report("original", { progress: .3 }, false, sample);
  assert.equal(samples, 1); assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { progress: .2, frameResources: { frame: 20 } });
  now = 2200; await context.report("original", { status: "done" }, true);
  assert.deepEqual(sent[1], { status: "done" });
  now = 3300; await context.report("original", { progress: .4 }, false, () => { throw Error("diagnostics unavailable"); });
  assert.deepEqual(sent[2], { progress: .4 }, "unavailable observations must not suppress the owner's heartbeat");
});
