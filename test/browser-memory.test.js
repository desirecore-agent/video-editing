"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const source = fs.readFileSync(path.join(__dirname, "..", "browser-process.js"), "utf8");
const url = "http://127.0.0.1:7778/?exportJob=owned";
function fixture() {
  const commands = [], timers = new Set(), intervals = new Set(), proc = new EventEmitter();
  proc.pid = 123; proc.exitCode = proc.signalCode = null;
  proc.stdio = [null, null, new PassThrough(), new PassThrough(), new PassThrough()]; proc.stderr = proc.stdio[2]; proc.kill = () => assert.fail("no actual process termination in protocol fixture");
  let input = ""; proc.stdio[3].on("data", b => { input += b; let n; while ((n = input.indexOf("\0")) >= 0) { commands.push(JSON.parse(input.slice(0, n))); input = input.slice(n + 1); } });
  const createTimer = (set, callback, ms) => { const t = { callback, ms, unref() {} }; set.add(t); return t; };
  const module = { exports: {} }, context = { module, Buffer, structuredClone, Date,
    require(name) { if (name === "./native-process") return { spawn: () => proc }; if (name === "fs") return { rm(_p, _o, cb) { cb(); } }; return require(name); },
    setTimeout: (fn, ms) => createTimer(timers, fn, ms), clearTimeout: t => timers.delete(t),
    setInterval: (fn, ms) => createTimer(intervals, fn, ms), clearInterval: t => intervals.delete(t),
  };
  vm.runInNewContext(source, context);
  const handle = module.exports.createBrowserProcess("owned-chrome", [], { profileDir: "owned-profile", onTargetCrash() {}, observePageMemory: url });
  const reply = event => proc.stdio[4].write(JSON.stringify(event) + "\0");
  const info = (targetId, targetUrl = url, type = "page") => reply({ method: "Target.targetCreated", params: { targetInfo: { targetId, url: targetUrl, type } } });
  proc.emit("spawn"); reply({ id: 1, result: {} });
  return { handle, proc, commands, timers, intervals, reply, info, diagnostics: () => JSON.parse(JSON.stringify(handle.diagnostics())) };
}
function attached(f) {
  f.info("owned-page"); const attach = f.commands.at(-1);
  assert.equal(attach.method, "Target.attachToTarget"); assert.equal(attach.params.targetId, "owned-page");
  f.reply({ id: attach.id, result: { sessionId: "owned-session" } });
  const read = f.commands.at(-1); assert.equal(read.method, "Runtime.getHeapUsage"); assert.equal(read.sessionId, "owned-session");
  return read;
}
test("only the exact owned page is attached, with one bounded numeric history and peak", () => {
  const f = fixture(); f.info("other", "http://example.invalid/"); f.info("worker", url, "worker");
  assert.equal(f.commands.length, 1); assert.equal(f.diagnostics().memory.status, "waiting");
  let read = attached(f);
  for (let n = 1; n <= 40; n++) {
    f.reply({ id: read.id, sessionId: "owned-session", result: { usedSize: n, totalSize: 100, backingStorageSize: 1000 - n, embedderHeapUsedSize: "invalid", unexpected: "excluded" } });
    if (n < 40) { [...f.intervals][0].callback(); read = f.commands.at(-1); }
  }
  const memory = f.diagnostics().memory;
  assert.equal(memory.sampleCount, 40); assert.equal(memory.samples.length, 32); assert.equal(memory.samples[0].usedSize, 9);
  assert.deepEqual(memory.peak, { usedSize: 40, totalSize: 100, backingStorageSize: 999 });
  assert(!JSON.stringify(memory).includes("unexpected")); assert(!JSON.stringify(memory).includes("invalid"));
  assert.equal(f.commands.filter(c => c.method === "Target.attachToTarget").length, 1);
  assert(f.commands.every(c => ["Target.setDiscoverTargets", "Target.attachToTarget", "Runtime.getHeapUsage"].includes(c.method)));
  f.handle.close(); assert.equal(f.intervals.size, 0); assert.equal(f.diagnostics().memory.stopReason, "owner_closed");
  f.proc.exitCode = 0; f.proc.emit("exit", 0, null); f.proc.emit("close");
});
test("a pending numeric read is not duplicated and wrong-session or late replies cannot replace facts", () => {
  const f = fixture(), read = attached(f), before = f.commands.length;
  [...f.intervals][0].callback(); assert.equal(f.commands.length, before);
  f.reply({ id: read.id, sessionId: "other-session", result: { usedSize: 999, totalSize: 999 } });
  assert.equal(f.diagnostics().memory.sampleCount, 0);
  f.reply({ method: "Target.targetDestroyed", params: { targetId: "owned-page" } });
  f.reply({ id: read.id, sessionId: "owned-session", result: { usedSize: 999, totalSize: 999 } });
  assert.equal(f.diagnostics().memory.sampleCount, 0); assert.equal(f.diagnostics().memory.stopReason, "target_destroyed"); assert.equal(f.intervals.size, 0);
});
test("unsupported attachment, invalid numeric data and an unresponsive read stop observation without a retry", () => {
  const rejected = fixture(); rejected.info("owned-page"); rejected.reply({ id: rejected.commands.at(-1).id, error: { code: -32601 } });
  assert.equal(rejected.diagnostics().memory.stopReason, "attach_unavailable"); assert.equal(rejected.commands.length, 2);
  const invalid = fixture(), read = attached(invalid);
  invalid.reply({ id: read.id, sessionId: "owned-session", result: { usedSize: -1, totalSize: 100 } });
  assert.equal(invalid.diagnostics().memory.stopReason, "heap_unavailable"); assert.equal(invalid.diagnostics().memory.samples.length, 0);
  const stalled = fixture(); attached(stalled); const count = stalled.commands.length;
  const timeout = [...stalled.timers].find(t => t.ms === 30000); assert(timeout); timeout.callback();
  assert.equal(stalled.diagnostics().memory.status, "unresponsive"); assert.equal(stalled.diagnostics().memory.stopReason, "unresponsive"); assert.equal(stalled.intervals.size, 0); assert.equal(stalled.commands.length, count);
});
