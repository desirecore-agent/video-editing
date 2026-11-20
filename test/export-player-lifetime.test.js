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

function previewTick({ frozen, rendering = false, sourceMode = false }) {
  const calls = { players: [], draws: 0, sourceSync: 0, sourceDraws: 0 };
  const clips = Array.from({ length: 100 }, (_, i) => ({ id: "v" + i, kind: "video", start: i * 10, duration: 10 }));
  const noop = () => {};
  const env = {
    compositorReadback: frozen,
    state: { time: 0, pps: 10, playing: false, exporting: false, rendering, source: { playing: false } },
    runtime: { clipGain: new Map() },
    els: { timelineScroll: { scrollLeft: 0, clientWidth: 100 }, playhead: { style: {} } },
    trState: { open: false }, projDur: () => 1000, playRate: () => 1, frameDue: () => true,
    mediaClips: () => clips, clipRenders: () => true, mediaTimeAt: () => 0,
    getClipEl(c) { calls.players.push(c.id); return { paused: true, currentTime: 0 }; },
    muteClipChain: noop, activeAt: (c, t) => t >= c.start && t < c.start + c.duration,
    isSourceMode: () => sourceMode,
    syncSourceMedia() { calls.sourceSync++; }, drawSourceFrame() { calls.sourceDraws++; },
    drawFrame() { calls.draws++; },
    rebuildClips: noop, transcriptTick: noop, watchCaptions: noop, drawRuler: noop,
    updateSafeOverlay: noop, updateKfGraphs: noop, syncInspectorPlayhead: noop, syncFxEditors: noop,
    syncColorPlayhead: noop, updateTimecode: noop, updateMeterUI: noop, updateSourceScrub: noop,
    idleAudio: noop, loopBusy: () => false, setTimeout: () => 0, requestAnimationFrame: noop,
  };
  const code = functionSource("function syncMedia()", "function seekMediaWhilePaused()") +
    functionSource("function loop(ts)", "/* ═══════════════════════════ EXPORT") +
    ";return loop;";
  const loop = new Function(...Object.keys(env), "let lastTs=null,lastRulerKey='',playheadPx=0,loopSleep=0;const IDLE_MS=250,VIDEO_PREFETCH_SEC=.85;" + code)(...Object.values(env));
  loop(1);
  return calls;
}

test("a frozen job leaves all preview players and canvas drawing to its owner from the first tick", () => {
  const calls = previewTick({ frozen: true });
  assert.deepEqual(calls.players, [], "the real syncMedia path must not preload the whole future timeline before mixing");
  assert.equal(calls.draws, 0);
});

test("a frozen job also fences the Source preview path", () => {
  const calls = previewTick({ frozen: true, sourceMode: true });
  assert.equal(calls.sourceSync, 0);
  assert.equal(calls.sourceDraws, 0);
});

test("interactive timeline and Source ticks retain their existing preview behavior", () => {
  const timeline = previewTick({ frozen: false });
  assert.equal(timeline.players.length, 100);
  assert.equal(timeline.draws, 1);
  const source = previewTick({ frozen: false, sourceMode: true });
  assert.equal(source.sourceSync, 1);
  assert.equal(source.sourceDraws, 1);
});

test("the fast renderer still owns the canvas while rendering in either document", () => {
  for (const frozen of [false, true]) {
    const calls = previewTick({ frozen, rendering: true });
    assert.deepEqual(calls.players, []);
    assert.equal(calls.draws, 0);
  }
});
