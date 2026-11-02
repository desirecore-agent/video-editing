/* Real Node process/OS-pipe regressions only. Chromium's EOF callback is backed
   by the pinned upstream source; native Chrome and its process tree still need
   separate platform acceptance. No browser, HTTP or encoder is started here. */
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { createBrowserProcess } = require("../browser-process");
const fixture = path.join(__dirname, "fixtures/browser-lifecycle-child.cjs");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, description, timeout = 8000) {
  const end = Date.now() + timeout;
  do { if (predicate()) return; await pause(20); } while (Date.now() < end);
  assert.fail("timed out waiting for " + description);
}
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), "video-editing-browser-pipe-test-"));
function browser(t, mode = "ordinary", keep = false) {
  const dir = directory(), profileDir = path.join(dir, "profile");
  fs.mkdirSync(profileDir); fs.writeFileSync(path.join(profileDir, "owned"), "profile");
  const handle = createBrowserProcess(process.execPath, [fixture, dir, mode], { profileDir, keep });
  const closed = new Promise(resolve => handle.proc.once("close", (code, signal) => resolve({ code, signal })));
  // Cleanup signals only the direct ChildProcess created by this test through
  // its owner pipe. Descendants also have a finite 15-second fixture budget.
  t.after(async () => { handle.close(); await closed; fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, profileDir, handle, closed };
}
const ready = b => waitFor(() => fs.existsSync(path.join(b.dir, "ready.json")), "fixture readiness");
const marked = (b, name) => fs.existsSync(path.join(b.dir, name));
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

test("normal close reaches the real child and descendant by EOF and preserves an independent browser", async t => {
  const first = browser(t), protectedBrowser = browser(t);
  await ready(first); await ready(protectedBrowser);
  const tuple = JSON.parse(fs.readFileSync(path.join(first.dir, "ready.json")));
  assert.ok(tuple.browser > 0 && tuple.descendant > 0 && tuple.browser !== tuple.descendant);
  assert.ok(first.handle.proc.spawnargs.includes("--remote-debugging-pipe"));
  first.handle.close(); first.handle.close();
  assert.deepEqual(await first.closed, { code: 0, signal: null });
  assert.ok(marked(first, "browser-eof")); assert.ok(marked(first, "descendant-eof"));
  assert.equal(fs.readFileSync(path.join(first.dir, "descendant-close"), "utf8"), "0");
  await waitFor(() => !fs.existsSync(first.profileDir), "closed browser profile cleanup");
  assert.equal(protectedBrowser.handle.proc.exitCode, null);
  assert.equal(protectedBrowser.handle.proc.signalCode, null);
  assert.equal(marked(protectedBrowser, "browser-eof"), false);
  assert.ok(fs.existsSync(protectedBrowser.profileDir));
});

test("SIGKILL of the real owner closes its exclusive pipe without a cleanup handler", async t => {
  const dir = directory(), protectedBrowser = browser(t);
  const owner = spawn(process.execPath, [path.join(__dirname, "fixtures/browser-lifecycle-owner.cjs"), dir], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
  });
  let errors = ""; owner.stderr.on("data", bytes => { errors += bytes; });
  const ownerClosed = new Promise(resolve => owner.once("close", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await ownerClosed;
    await waitFor(() => fs.existsSync(path.join(dir, "descendant-close")), "owned fixture child cleanup");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(path.join(dir, "ready.json")), "owner's browser/descendant readiness");
  const tuple = JSON.parse(fs.readFileSync(path.join(dir, "ready.json")));
  await ready(protectedBrowser);
  assert.equal(errors, "");
  assert.equal(owner.kill("SIGKILL"), true);
  const result = await ownerClosed;
  assert.ok(result.signal === "SIGKILL" || process.platform === "win32");
  await waitFor(() => fs.existsSync(path.join(dir, "browser-eof")) && fs.existsSync(path.join(dir, "descendant-eof"))
    && fs.existsSync(path.join(dir, "descendant-close")), "OS EOF and original descendant close");
  assert.equal(fs.readFileSync(path.join(dir, "descendant-close"), "utf8"), "0");
  await waitFor(() => gone(tuple.browser) && gone(tuple.descendant), "original fixture browser and descendant gone");
  assert.equal(fs.existsSync(path.join(dir, "ordinary-timeout")), false);
  assert.equal(fs.existsSync(path.join(dir, "descendant-timeout")), false);
  // Owner death cannot run its JavaScript profile finalizer. No restart glob,
  // stored PID, or deletion of this old throwaway directory is claimed.
  assert.ok(fs.existsSync(path.join(dir, "profile")));
  assert.equal(protectedBrowser.handle.proc.exitCode, null);
  assert.equal(protectedBrowser.handle.proc.signalCode, null);
  assert.equal(marked(protectedBrowser, "browser-eof"), false);
});

test("a retained profile survives normal close", async t => {
  const b = browser(t, "ordinary", true);
  await ready(b); b.handle.close(); await b.closed;
  assert.equal(fs.readFileSync(path.join(b.profileDir, "owned"), "utf8"), "profile");
});

test("unexpected real child exit cleans its temporary profile", async t => {
  const b = browser(t, "early-exit");
  assert.deepEqual(await b.closed, { code: 7, signal: null });
  await waitFor(() => !fs.existsSync(b.profileDir), "unexpected-exit profile cleanup");
  b.handle.close();
});

test("spawn failure closes pipes and cleans only its temporary profile", async t => {
  const dir = directory(), profileDir = path.join(dir, "profile"), protectedFile = path.join(dir, "protected");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(profileDir); fs.writeFileSync(protectedFile, "keep");
  const b = createBrowserProcess(path.join(dir, "missing-executable"), [], { profileDir });
  const error = new Promise(resolve => b.proc.once("error", resolve));
  const closed = new Promise(resolve => b.proc.once("close", resolve));
  assert.equal((await error).code, "ENOENT"); await closed; b.close();
  await waitFor(() => !fs.existsSync(profileDir), "spawn-error profile cleanup");
  assert.equal(fs.readFileSync(protectedFile, "utf8"), "keep");
});

test("normal close gives EOF a grace period before bounded original-child fallback", async t => {
  const b = browser(t, "stubborn");
  await ready(b); b.handle.close();
  await pause(100);
  assert.equal(b.handle.proc.exitCode, null); assert.equal(b.handle.proc.signalCode, null);
  assert.ok(fs.existsSync(b.profileDir), "a live child's profile must stay intact");
  if (process.platform !== "win32") {
    await waitFor(() => marked(b, "term"), "original-child TERM fallback");
    assert.equal(b.handle.proc.exitCode, null); assert.equal(b.handle.proc.signalCode, null);
    assert.ok(fs.existsSync(b.profileDir), "TERM ignored: a still-live child's profile must stay intact");
  }
  const result = await b.closed;
  if (process.platform !== "win32") {
    assert.equal(result.signal, "SIGKILL"); assert.ok(marked(b, "term"));
  }
  await waitFor(() => !fs.existsSync(b.profileDir), "fallback-close profile cleanup");
});
