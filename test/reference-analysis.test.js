"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeDataDir, readProject, startServer, startMcp } = require("./helpers");

test("MCP reference analysis distinguishes an audio track from disabled music extraction", async t => {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    if (spawnSync(bin, ["-version"]).status !== 0) { t.skip(`${bin} unavailable`); return; }
  }
  const dir = makeDataDir(t), file = path.join(dir, "tone.wav");
  const rate = 22050, samples = 4 * rate, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(6500 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  fs.writeFileSync(file, wav);
  const service = await startServer(t, dir), before = readProject(dir);
  const mcp = startMcp(t, dir, { PORT: String(service.port), FABLECUT_NO_AUTOSTART: "1" });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const reply = await mcp.callTool("fablecut_analyze_reference", { path: file, registerMusic: false });
  assert.equal(reply.isError, false, reply.text);
  const bp = JSON.parse(reply.text.slice(0, reply.text.indexOf("\n\n")));
  assert.equal(bp.hasAudio, true); assert.equal(bp.music, null);
  assert.equal(bp.bpm, null); assert.deepEqual(bp.beats, []);
  assert.match(reply.text, /music extraction was not requested/);
  assert.doesNotMatch(reply.text, /has no audio track/);
  assert.doesNotMatch(reply.text, /3\) extracted music on A1/);
  assert.doesNotMatch(reply.text, /drop \(nulls\)|tempo \d/);
  assert.deepEqual(readProject(dir), before, "analysis without registration does not mutate the human project");
});
