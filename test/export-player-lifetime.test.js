"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function functionSource(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first);
  return source.slice(first, last);
}

test("export preparation switches existing players without opening the rest of a long timeline", async () => {
  const clips = Array.from({ length: 100 }, (_, index) => ({ id: "video-" + index, kind: "video" }));
  const element = {};
  const runtime = { clipEls: new Map([[clips[0].id, element]]) };
  const requested = [];
  const prepare = new Function("runtime", "mediaClips", "clipRenders", "getClipEl", "waitMediaEl",
    functionSource("async function useOriginalPlayers()", "function releaseOriginalPlayers()") + "; return useOriginalPlayers;")(
    runtime, () => clips, () => true, clip => { requested.push(clip.id); return element; }, async () => {});
  await prepare();
  assert.equal(runtime.forceOriginals, true);
  assert.deepEqual(requested, [clips[0].id]);
});

function inactiveSeek(runtime, releaseClipEl = () => {}) {
  const clip = { id: "future", kind: "video", start: 30, duration: 10 };
  const env = {
    projectFps: () => 30, exportLoopLag: () => ({ fast: true, behind: false }), performance,
    mediaClips: () => [clip], clipRenders: () => true, activeAt: () => false, runtime,
    getClipEl() { assert.fail("inactive clips must not create media players"); },
    clipEnd: c => c.start + c.duration, releaseClipEl,
    driveClipChain() {}, evalProps: () => ({}), prefetchExportVideos() {},
  };
  const seek = new Function(...Object.keys(env), "let exportSeekClock; " +
    functionSource("async function seekVideosTo(", "function encodeWAV(") + "; return seekVideosTo;")(...Object.values(env));
  return seek;
}

test("export seeking leaves future clips unopened", async () => {
  const runtime = { clipEls: new Map(), clipGain: new Map() };
  await inactiveSeek(runtime)(0);
});

test("export seeking releases a past clip player", async () => {
  const element = { paused: true };
  const runtime = { forceOriginals: true, clipEls: new Map([["future", element]]), clipGain: new Map() };
  const released = [];
  await inactiveSeek(runtime, id => { released.push(id); runtime.clipEls.delete(id); })(41);
  assert.deepEqual(released, ["future"]);
  assert.equal(runtime.clipEls.size, 0);
});
