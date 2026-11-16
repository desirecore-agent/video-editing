"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const start = source.indexOf("function assertExportVideoFrame(");
const end = source.indexOf("async function seekVideosTo(", start);
const clip = { id: "c_video", mediaId: "m_video", kind: "video", name: "Camera take" };
function load(element, frame) {
  assert.ok(start >= 0 && end > start, "production frame admission function exists");
  const runtime = { exportFrames: new Map(frame ? [[clip.id, frame]] : []) };
  return new Function("runtime", "getClipEl", "getMedia", `${source.slice(start, end)}; return assertExportVideoFrame;`)(
    runtime, () => element, () => ({ name: "Dolby.mp4", src: "/media/Dolby.mp4" }));
}
test("export refuses an active clip without a decoded picture and names its source/time", () => {
  for (const element of [null, { readyState: 2, videoWidth: 0, videoHeight: 0 },
    { readyState: 1, videoWidth: 1920, videoHeight: 1080 },
    { readyState: 2, videoWidth: 1920, videoHeight: 1080, error: { code: 4 } }]) {
    assert.throws(() => load(element)(clip, 1.25), /VIDEO_FRAME_UNAVAILABLE.*c_video.*Dolby\.mp4.*1\.250/);
  }
});
test("real video frames and intentional black pictures do not require non-black pixels", () => {
  assert.doesNotThrow(() => load({ readyState: 2, videoWidth: 1920, videoHeight: 1080 })(clip, 0));
  assert.doesNotThrow(() => load(null, { displayWidth: 1920, displayHeight: 1080 })(clip, 0));
  assert.throws(() => load(null, { displayWidth: 0, displayHeight: 0 })(clip, 0), /VIDEO_FRAME_UNAVAILABLE/);
});
test("the shared export seek path refuses a missing player instead of skipping the clip", async () => {
  const a = source.indexOf("async function seekVideosTo(");
  const b = source.indexOf("function encodeWAV(", a);
  const env = { projectFps: () => 30, exportLoopLag: () => ({ fast: true, behind: false }), performance,
    mediaClips: () => [clip], clipRenders: () => true, activeAt: () => true,
    runtime: { clipGain: new Map() }, getClipEl: () => null,
    assertExportVideoFrame: load(null), prefetchExportVideos() {},
  };
  const seek = new Function(...Object.keys(env), `let exportSeekClock; ${source.slice(a, b)}; return seekVideosTo;`)(...Object.values(env));
  await assert.rejects(seek(2, {}), /VIDEO_FRAME_UNAVAILABLE/);
});
