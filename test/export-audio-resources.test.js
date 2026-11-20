"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}
function clip(id, changes = {}) {
  return { id, mediaId: id, kind: "audio", start: 0, duration: 10, in: 0, props: { volume: 1 }, ...changes };
}
function mixer(clips) {
  const decoded = [], scheduled = [], rendered = [], contexts = [];
  const env = {
    mediaClips: () => clips, clipRenders: c => !c.disabled,
    getMedia: id => id === "missing" ? null : { id },
    getAudioBuffer: async m => { decoded.push(m.id); return { numberOfChannels: 2 }; },
    OfflineAudioContext: class {
      constructor(channels, length, rate) { this.destination = {}; this.shape = { channels, length, rate }; contexts.push(this.shape); }
      createBufferSource() { return { playbackRate: {}, start(...args) { scheduled.push(args); } }; }
      async startRendering() { rendered.push(this.shape); return this.shape; }
    },
    loadFxWorklet: async () => {}, audioTrackIds: () => [], busIdsNow: () => [],
    buildMixBuses: () => ({ trackBus: {}, master: {}, masterOut: { connect() {} } }),
    applyMixLevels() {},
    buildClipChain: () => ({ vol: { gain: { setValueCurveAtTime() {} } }, out: { connect() {} } }),
    evalProps: c => c.props, clipAudioGain: p => p.volume, clipPan: x => x || 0,
    hasSpeedRamp: () => false, clipSpeed: () => 1,
    FableCutFx: { hasKeys: () => false }, masterFx: () => [], project: {},
    encodeWAV: buffer => ({ wav: true, ...buffer }),
  };
  const run = new Function(...Object.keys(env), section("async function renderAudioMix(", "/* Frame-exact asset prep") + "; return renderAudioMix;")(...Object.values(env));
  return { run, decoded, scheduled, rendered, contexts };
}

test("audio input decoding only touches enabled media overlapping the actual export window", async () => {
  const h = mixer([
    clip("active"), clip("left", { start: -2, duration: 3 }),
    clip("after", { start: 65 }), clip("before", { start: -10, duration: 10 }),
    clip("disabled", { disabled: true }), clip("shape", { kind: "shape" }),
    clip("missing", { mediaId: "missing" }),
  ]);
  assert.equal((await h.run(0, 65)).wav, true);
  assert.deepEqual(h.decoded, ["active", "left"]);
  assert.equal(h.scheduled.length, 2);
});

test("many explicitly muted video clips preserve a silent output mix without decoding their large source", async () => {
  const h = mixer(Array.from({ length: 92 }, (_, i) => clip("large-video", { id: "v" + i, kind: "video", props: { volume: 0 } })));
  const wav = await h.run(0, 65);
  assert.deepEqual(h.decoded, []);
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.rendered.length, 1, "retain the original audio-track presence and requested length");
  assert.deepEqual(wav, { wav: true, channels: 2, length: 65 * 48000 + 1, rate: 48000 });
});

test("volume automation and unspecified volume retain the normal decoded source path", async () => {
  const h = mixer([
    clip("automated", { kind: "video", props: { volume: 0 }, keyframes: { volume: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } }),
    clip("default", { props: {} }), clip("quiet", { props: { volume: 0.001 } }),
  ]);
  await h.run(0, 65);
  assert.deepEqual(h.decoded, ["automated", "default", "quiet"]);
  assert.equal(h.scheduled.length, 3);
});

test("an empty export interval performs no audio media reads or offline allocation", async () => {
  const h = mixer([clip("video", { kind: "video" })]);
  assert.equal(await h.run(10, 10), null);
  assert.deepEqual(h.decoded, []);
  assert.deepEqual(h.contexts, []);
});

function waveform(exportDocument) {
  const reads = [], runtime = { wavePeaks: new Map() }, state = {};
  const getAudioBuffer = async m => { reads.push(m.id); return { duration: 1, length: 8, numberOfChannels: 1, getChannelData: () => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]) }; };
  const ensure = new Function("compositorReadback", "runtime", "state", "getAudioBuffer", "WAVE_PEAKS_PER_SEC",
    section("function ensureWave(", "function wavePeaksFor(") + ";return ensureWave;")(exportDocument, runtime, state, getAudioBuffer, 1);
  return { ensure, reads, runtime, state };
}
test("owned export documents do not start interactive waveform decoding", async () => {
  const h = waveform(true);
  h.ensure({ id: "large", kind: "video", src: "/large.mp4" });
  h.ensure({ id: "voice", kind: "audio", src: "/voice.wav" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.reads, []);
  assert.equal(h.runtime.wavePeaks.size, 0);
});

test("the interactive editor still builds and reuses waveform peaks", async () => {
  const h = waveform(false), media = { id: "voice", kind: "audio", src: "/voice.wav" };
  h.ensure(media);
  await new Promise(resolve => setImmediate(resolve));
  h.ensure(media);
  assert.deepEqual(h.reads, ["voice"]);
  assert.equal(h.runtime.wavePeaks.get("voice").max[0], 1);
  assert.equal(media.channels, 1);
  assert.equal(h.state.dirtyTimeline, true);
});
