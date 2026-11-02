/* Pure Windows executable spelling and process-call wiring. No Chrome,
   FFmpeg, ffprobe, Windows process or native qualification is run here. */
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const cp = require("node:child_process"), { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const native = require("../native-process");
const longExe = "C:\\Users\\测试 User\\" + "long directory\\".repeat(22) + "Chrome for Testing\\chrome.exe";
const serial = { concurrency: false };

function platformScope(platform) {
  const previous = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...previous, value: platform });
  return () => Object.defineProperty(process, "platform", previous);
}
function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "video-editing-native-exe-unit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  proc.exitCode = null; proc.signalCode = null;
  proc.kill = () => assert.fail("no fixture process may be signalled");
  return proc;
}

test("only fully qualified Windows executables use the standard namespace conversion", () => {
  assert.ok(longExe.length > 260);
  for (const exe of [longExe, "D:/空 格/ffmpeg.exe", "\\\\server\\共享\\ffprobe.exe"]) {
    const converted = native.nativeExecutable(exe, "win32");
    assert.equal(converted, path.win32.toNamespacedPath(exe));
    assert.ok(converted.startsWith("\\\\?\\"));
    assert.equal(native.nativeExecutable(converted, "win32"), converted, "already namespaced paths are idempotent");
  }
  for (const exe of ["ffmpeg", "ffprobe", "powershell.exe", "./ffmpeg", "C:ffmpeg.exe", "\\rooted\\ffmpeg.exe", "", null, undefined])
    assert.equal(native.nativeExecutable(exe, "win32"), exe, "bare/root-relative inputs keep Node lookup semantics");
});

test("non-Windows executable values retain the original bytes, including foreign-looking paths", () => {
  for (const platform of ["darwin", "linux"]) for (const exe of [longExe, "/opt/工具 bin/ffmpeg", "ffprobe", "\\\\?\\C:\\bin\\chrome.exe", null])
    assert.equal(native.nativeExecutable(exe, platform), exe);
});

for (const platform of ["win32", "darwin", "linux"]) for (const method of ["spawn", "spawnSync", "execFile"])
  test(`${method} on ${platform} changes only the executable spelling and returns the original handle`, serial, () => {
    const restore = platformScope(platform), original = cp[method], marker = {};
    const args = ["-i", "C:\\媒体 path\\片段 '[$].mp4", "-vf", "scale=if(gt(iw,ih),1280,-2):720", "http://127.0.0.1:7777/?exportJob=x_1"];
    const options = { windowsHide: true, stdio: ["pipe", "ignore", "pipe"], timeout: 5000, env: { PATH: "unchanged" } };
    const callback = () => {};
    try {
      // Patch after native-process was loaded: delegation must stay dynamic.
      cp[method] = (...received) => {
        assert.equal(received[0], native.nativeExecutable(longExe, platform));
        assert.equal(received[1], args); assert.equal(received[2], options); assert.equal(received[3], callback);
        return marker;
      };
      assert.equal(native[method](longExe, args, options, callback), marker);
      cp[method] = (exe, ...received) => { assert.equal(exe, "ffmpeg"); assert.equal(received[0], args); return marker; };
      assert.equal(native[method]("ffmpeg", args, options), marker, "bare media commands keep PATH lookup");
    } finally { cp[method] = original; restore(); }
  });

test("execFile's optional-argument callback and native exceptions pass through unchanged", serial, () => {
  const original = cp.execFile, callback = () => {}, expected = Error("original native error");
  try {
    cp.execFile = (exe, cb) => { assert.equal(exe, "ffprobe"); assert.equal(cb, callback); throw expected; };
    assert.throws(() => native.execFile("ffprobe", callback), error => error === expected);
  } finally { cp.execFile = original; }
});

test("the actual browser launcher namespaces its exe while retaining its pipe argv and original child", serial, t => {
  const restore = platformScope("win32"), original = cp.spawn, proc = fakeProcess();
  const profileDir = workspace(t), args = ["--headless=new", "--user-data-dir=" + profileDir, "http://127.0.0.1/?exportJob=x_unit"];
  try {
    cp.spawn = (exe, actualArgs, options) => {
      assert.equal(exe, path.win32.toNamespacedPath(longExe));
      assert.deepEqual(actualArgs, [...args, "--remote-debugging-pipe"]);
      assert.deepEqual(options, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
      return proc;
    };
    const browser = require("../browser-process").createBrowserProcess(longExe, args, { profileDir, keep: true });
    assert.equal(browser.proc, proc); browser.close(); proc.emit("close", 0);
  } finally { cp.spawn = original; restore(); }
});

test("the actual proxy creator routes an absolute FFmpeg exe through the same boundary", serial, async t => {
  const restore = platformScope("win32"), original = cp.spawn, directory = workspace(t), file = path.join(directory, "原始 clip.mp4");
  fs.writeFileSync(file, "unit metadata only; not decoded");
  let acknowledge;
  const invoked = new Promise(resolve => { acknowledge = resolve; });
  try {
    cp.spawn = (exe, args, options) => {
      assert.equal(exe, path.win32.toNamespacedPath(longExe)); assert.ok(args.includes(file));
      assert.equal(args[args.indexOf("-c:v") + 1], "libx264"); assert.deepEqual(options, { windowsHide: true });
      const proc = fakeProcess(); acknowledge(proc); return proc;
    };
    const proxies = require("../proxy").createProxies({ dir: path.join(directory, "proxies"), resolveSrc: () => file,
      probe: async () => ({ duration: 1 }), ffmpeg: longExe });
    await proxies.start("/media/original.mp4"); const proc = await invoked; proc.emit("close", 1);
  } finally { cp.spawn = original; restore(); }
});

test("actual media probing preserves bare ffprobe lookup and media-path arguments", serial, async t => {
  const originalSync = cp.spawnSync, originalExec = cp.execFile, directory = workspace(t), file = path.join(directory, "片段 '[x].mp4");
  fs.writeFileSync(file, "unit metadata only; not probed");
  const modulePath = require.resolve("../media-probe"), cached = require.cache[modulePath];
  try {
    cp.spawnSync = (exe, args, options) => { assert.equal(exe, "ffprobe"); assert.deepEqual(args, ["-version"]); assert.deepEqual(options, { stdio: "ignore" }); return { status: 0 }; };
    cp.execFile = (exe, args, options, callback) => { assert.equal(exe, "ffprobe"); assert.equal(args.at(-1), file);
      assert.equal(options.timeout, 15000); callback(null, JSON.stringify({ streams: [], format: { duration: "1" } })); };
    delete require.cache[modulePath]; const info = await require("../media-probe").probeFile(file);
    assert.equal(info.probe, "ffprobe"); assert.equal(info.duration, 1);
  } finally { cp.spawnSync = originalSync; cp.execFile = originalExec; delete require.cache[modulePath]; if (cached) require.cache[modulePath] = cached; }
});
