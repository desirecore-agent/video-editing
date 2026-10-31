/* Filesystem-only recovery of the original export job and its exact artifacts.
   No browser, encoder, movie output or native acceptance is claimed here. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createExportJobs } = require("../export-jobs");

const MODULE = path.resolve(__dirname, "..", "export-jobs.js");
const SNAPSHOT = { projectUrl: "/exports/snapshots/unit/project.json", receipt: { projectRevision: 17, files: [] } };

function workspace(t) {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-export-recovery-"))), cleanup = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  });
  const artifactRoot = path.join(dataRoot, "exports"), storeDir = path.join(artifactRoot, "jobs");
  fs.mkdirSync(artifactRoot);
  fs.mkdirSync(path.join(dataRoot, "media"));
  const project = path.join(dataRoot, "project.json"), input = path.join(dataRoot, "media", "input.mp4");
  fs.writeFileSync(project, '{"revision":17,"name":"retained unit project"}\n');
  fs.writeFileSync(input, "unit source bytes; never decoded\n");
  return { dataRoot, artifactRoot, storeDir, project, input, cleanup };
}

function options(w, extra = {}) {
  return { storeDir: w.storeDir, dataRoot: w.dataRoot, artifactRoot: w.artifactRoot,
    editors: () => 1, broadcast: () => {}, url: id => id, ...extra };
}

function open(t, w, extra) {
  const jobs = createExportJobs(options(w, extra));
  w.cleanup.push(() => jobs.shutdown());
  return jobs;
}

function running(jobs) {
  const job = jobs.request({ where: "tab", revision: 17, snapshot: SNAPSHOT });
  assert.equal(jobs.claim(job.id), true);
  return job;
}

const receiptFile = (w, id) => path.join(w.storeDir, id + ".json");
const receipt = (w, id) => JSON.parse(fs.readFileSync(receiptFile(w, id), "utf8"));
const receiptNames = w => fs.readdirSync(w.storeDir).filter(name => /^x_[a-z0-9]+\.json$/.test(name)).sort();
const bytes = file => fs.readFileSync(file).toString("hex");
const entry = (w, id, file) => receipt(w, id).artifacts.entries.find(e => e.path === path.relative(w.artifactRoot, file).split(path.sep).join("/"));

function create(jobs, id, sessionId, file, kind, contents) {
  assert.equal(jobs.createArtifact(id, sessionId, file, kind), file);
  if (kind !== "directory") fs.appendFileSync(file, contents || "owned unit artifact\n");
  return file;
}

async function crashChild(t, w) {
  const script = `(${function () {
    const fs = require("node:fs"), path = require("node:path");
    const { createExportJobs } = require(process.argv[1]);
    const dataRoot = process.argv[2], artifactRoot = path.join(dataRoot, "exports");
    const jobs = createExportJobs({ storeDir: path.join(artifactRoot, "jobs"), dataRoot, artifactRoot,
      editors: () => 1, broadcast: () => {}, url: id => id });
    const done = jobs.request({ where: "tab" });
    jobs.claim(done.id);
    const donePart = path.join(artifactRoot, "finished.part.mp4"), final = path.join(artifactRoot, "finished.mp4");
    jobs.createArtifact(done.id, "finished", donePart, "part");
    fs.appendFileSync(donePart, "completed unit output; never encoded\n");
    fs.renameSync(donePart, final);
    jobs.report(done.id, { status: "done", src: "/exports/finished.mp4" });
    const snapshot = { projectUrl: "/exports/snapshots/unit/project.json", receipt: { projectRevision: 17, files: [] } };
    const job = jobs.request({ where: "tab", revision: 17, snapshot });
    jobs.claim(job.id);
    const sessionId = "recovery-session", dir = path.join(artifactRoot, "fablecut-" + sessionId + "-random");
    jobs.createArtifact(job.id, sessionId, dir, "directory");
    const audio = path.join(dir, "audio.wav"), parts = ["batch-a.part.mp4", "batch-b.part.webm"].map(name => path.join(artifactRoot, name));
    for (const file of [audio, ...parts]) {
      jobs.createArtifact(job.id, sessionId, file, file === audio ? "temp-file" : "part");
      fs.appendFileSync(file, "created then appended before SIGKILL: " + path.basename(file));
    }
    process.send({ id: job.id, doneId: done.id, pid: process.pid, dir, audio, parts, final });
    setInterval(() => {}, 1000);
  }.toString()})();`;
  const child = spawn(process.execPath, ["-e", script, MODULE, w.dataRoot], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.resume();
  w.cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("artifact child did not become ready: " + stderr)), 10_000);
    const finish = callback => value => { clearTimeout(timer); callback(value); };
    child.once("message", finish(resolve));
    child.once("error", finish(reject));
    child.once("exit", (code, signal) => finish(reject)(Error(`artifact child exited before readiness (${code}, ${signal}): ${stderr}`)));
  });
  assert.equal(ready.pid, child.pid);
  return { child, ready };
}

test("SIGKILL recovery keeps the original job and removes only its two batch parts and session files", async t => {
  const w = workspace(t), foreignPart = path.join(w.artifactRoot, "foreign.part.mp4");
  const foreignDir = path.join(w.artifactRoot, "fablecut-foreign-random");
  fs.mkdirSync(foreignDir);
  const foreignChild = path.join(foreignDir, "audio.wav");
  fs.writeFileSync(foreignPart, "foreign partial output"); fs.writeFileSync(foreignChild, "foreign audio");
  const preserved = [w.project, w.input, foreignPart, foreignChild].map(file => [file, bytes(file)]);
  const { child, ready } = await crashChild(t, w), before = receipt(w, ready.id), names = receiptNames(w);
  assert.equal(before.status, "running", "the child must not stop the job gracefully");
  assert.deepEqual(before.snapshot, SNAPSHOT);
  assert.equal(before.artifacts.entries.length, 4);
  assert.ok(before.artifacts.entries.every(e => e.state === "owned" && e.identity?.ino && e.identity?.birthtimeNs));
  for (const file of [ready.audio, ...ready.parts]) assert.match(fs.readFileSync(file, "utf8"), /appended before SIGKILL/);
  preserved.push([ready.final, bytes(ready.final)]);
  assert.deepEqual(names, [ready.id + ".json", ready.doneId + ".json"].sort());
  const exited = once(child, "exit");
  assert.equal(child.kill("SIGKILL"), true);
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");

  const effects = [], noWork = { launchBrowser: () => { effects.push("launch"); }, broadcast: () => { effects.push("broadcast"); } };
  const restored = open(t, w, noWork), original = restored.get(ready.id);
  assert.equal(original.id, ready.id); assert.equal(original.status, "interrupted");
  assert.equal(original.created, before.created); assert.deepEqual(original.snapshot, before.snapshot);
  assert.equal(restored.claim(ready.id), false);
  assert.deepEqual(original.cleanup, { status: "complete", removed: 4, retained: 0, errors: [] });
  for (const file of [ready.dir, ready.audio, ...ready.parts]) assert.equal(fs.existsSync(file), false, file);
  for (const [file, content] of preserved) assert.equal(bytes(file), content, file + " must be retained byte-for-byte");
  assert.equal(restored.get(ready.doneId).status, "done");
  assert.deepEqual(receiptNames(w), names); assert.deepEqual(effects, []);
  restored.shutdown();
  const second = open(t, w, noWork);
  assert.equal(second.get(ready.id).status, "interrupted");
  assert.deepEqual(second.get(ready.id).cleanup, original.cleanup);
  assert.deepEqual(receiptNames(w), names); assert.deepEqual(effects, []);
  for (const [file, content] of preserved) assert.equal(bytes(file), content);
});

test("session-scoped cleanup leaves another session's registered artifacts alone", t => {
  const w = workspace(t), jobs = open(t, w), job = running(jobs);
  const files = ["first", "second"].map(sid => create(jobs, job.id, sid, path.join(w.artifactRoot, sid + ".part.mp4"), "part"));
  const secondBytes = bytes(files[1]);
  assert.deepEqual(jobs.cleanupArtifacts(job.id, "first"), { status: "complete", removed: 1, retained: 0, errors: [] });
  assert.equal(fs.existsSync(files[0]), false); assert.equal(bytes(files[1]), secondBytes);
  assert.equal(entry(w, job.id, files[1]).state, "owned");
  assert.deepEqual(jobs.get(job.id).cleanup, { status: "pending", removed: 1, retained: 1, errors: [] });
  assert.deepEqual(receipt(w, job.id).cleanup, jobs.get(job.id).cleanup);
  assert.deepEqual(jobs.cleanupArtifacts(job.id, "second"), { status: "complete", removed: 1, retained: 0, errors: [] });
  assert.equal(fs.existsSync(files[1]), false);
});

test("one session's successful cleanup cannot overwrite another session's persisted failure", t => {
  const w = workspace(t), jobs = open(t, w), job = running(jobs);
  const first = create(jobs, job.id, "first", path.join(w.artifactRoot, "first-failed.part.mp4"), "part");
  const second = create(jobs, job.id, "second", path.join(w.artifactRoot, "second-success.part.mp4"), "part");
  const firstBytes = bytes(first), unlink = fs.unlinkSync;
  try {
    fs.unlinkSync = function (file, ...args) {
      if (file === first) throw Object.assign(Error("injected first-session unlink denial"), { code: "EACCES" });
      return unlink.call(this, file, ...args);
    };
    assert.deepEqual(jobs.cleanupArtifacts(job.id, "first"), { status: "failed", removed: 0, retained: 1, errors: ["EACCES"] });
    assert.deepEqual(jobs.get(job.id).cleanup, { status: "failed", removed: 0, retained: 2, errors: ["EACCES"] });
    assert.deepEqual(jobs.cleanupArtifacts(job.id, "second"), { status: "complete", removed: 1, retained: 0, errors: [] });
    const global = { status: "failed", removed: 1, retained: 1, errors: ["EACCES"] };
    assert.deepEqual(jobs.get(job.id).cleanup, global); assert.deepEqual(receipt(w, job.id).cleanup, global);
    assert.equal(bytes(first), firstBytes); assert.equal(fs.existsSync(second), false);
    assert.equal(entry(w, job.id, first).state, "owned"); assert.equal(entry(w, job.id, first).error, "EACCES");
    assert.equal(entry(w, job.id, second).state, "removed");
  } finally { fs.unlinkSync = unlink; }
  const names = receiptNames(w), complete = { status: "complete", removed: 2, retained: 0, errors: [] };
  assert.deepEqual(jobs.cleanupArtifacts(job.id), complete);
  assert.deepEqual(jobs.get(job.id).cleanup, complete); assert.deepEqual(receipt(w, job.id).cleanup, complete);
  assert.equal(fs.existsSync(first), false); assert.deepEqual(receiptNames(w), names);
});

test("unconfirmed encoder termination persists failure without deleting session artifacts", t => {
  const w = workspace(t), jobs = open(t, w), job = running(jobs), sid = "encoder-unconfirmed";
  const dir = create(jobs, job.id, sid, path.join(w.artifactRoot, "fablecut-" + sid + "-random"), "directory");
  const audio = create(jobs, job.id, sid, path.join(dir, "audio.wav"), "temp-file");
  const part = create(jobs, job.id, sid, path.join(w.artifactRoot, "encoder-unconfirmed.part.mp4"), "part");
  const preserved = [w.project, w.input, audio, part].map(file => [file, bytes(file)]);
  const identities = receipt(w, job.id).artifacts.entries.map(record => record.identity), names = receiptNames(w);
  const blocked = jobs.cleanupArtifacts(job.id, sid, false);
  assert.equal(blocked.status, "failed"); assert.equal(blocked.removed, 0); assert.equal(blocked.retained, 3);
  assert.equal(blocked.errors.length, 3); assert.ok(blocked.errors.every(error => /encoder termination unconfirmed/.test(error)));
  assert.deepEqual(jobs.get(job.id).cleanup, blocked); assert.deepEqual(receipt(w, job.id).cleanup, blocked);
  assert.equal(jobs.get(job.id).status, "running"); assert.equal(fs.statSync(dir).isDirectory(), true);
  for (const [file, content] of preserved) assert.equal(bytes(file), content);
  const retained = receipt(w, job.id).artifacts.entries;
  assert.ok(retained.every(record => record.state === "owned" && /encoder termination unconfirmed/.test(record.error)));
  assert.deepEqual(retained.map(record => record.identity), identities);
  const complete = { status: "complete", removed: 3, retained: 0, errors: [] };
  assert.deepEqual(jobs.cleanupArtifacts(job.id, sid, true), complete);
  assert.deepEqual(jobs.get(job.id).cleanup, complete); assert.deepEqual(receipt(w, job.id).cleanup, complete);
  for (const file of [dir, audio, part]) assert.equal(fs.existsSync(file), false);
  for (const [file, content] of preserved.slice(0, 2)) assert.equal(bytes(file), content);
  assert.deepEqual(receiptNames(w), names);
});

test("legacy interrupted jobs without artifact facts remain unknown and leave matching filenames untouched", t => {
  const w = workspace(t), first = open(t, w), job = running(first);
  first.shutdown();
  const legacy = receipt(w, job.id); delete legacy.artifacts;
  fs.writeFileSync(receiptFile(w, job.id), JSON.stringify(legacy));
  const part = path.join(w.artifactRoot, "legacy.part.mp4"), dir = path.join(w.artifactRoot, "fablecut-legacy-random");
  fs.mkdirSync(dir); fs.writeFileSync(part, "unregistered legacy part");
  const audio = path.join(dir, "audio.wav"); fs.writeFileSync(audio, "unregistered legacy audio");
  const preserved = [w.project, w.input, part, audio].map(file => [file, bytes(file)]), names = receiptNames(w);
  const restored = open(t, w), original = restored.get(job.id);
  assert.equal(original.status, "interrupted"); assert.equal(original.id, job.id);
  assert.equal(original.cleanup.status, "unknown"); assert.match(original.cleanup.errors.join(" "), /ownership facts/);
  assert.equal(restored.claim(job.id), false); assert.deepEqual(receiptNames(w), names);
  for (const [file, content] of preserved) assert.equal(bytes(file), content);
  assert.equal(fs.statSync(dir).isDirectory(), true);
});

test("outside paths and existing symlink artifacts cannot be claimed or deleted", t => {
  const w = workspace(t), jobs = open(t, w), job = running(jobs);
  const outside = path.join(w.dataRoot, "outside.part.mp4"); fs.writeFileSync(outside, "outside root bytes");
  assert.throws(() => jobs.createArtifact(job.id, "escape", outside, "part"), /invalid export artifact path/);
  const link = path.join(w.artifactRoot, "linked.part.mp4"); fs.symlinkSync(outside, link, "file");
  assert.throws(() => jobs.createArtifact(job.id, "escape", link, "part"), { code: "EEXIST" });
  assert.deepEqual(jobs.cleanupArtifacts(job.id), { status: "complete", removed: 0, retained: 0, errors: [] });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true); assert.equal(fs.readFileSync(outside, "utf8"), "outside root bytes");
  assert.deepEqual(receipt(w, job.id).artifacts.entries, []);
});

test("recovery rejects an escaped persisted artifact path instead of deleting outside the root", t => {
  const w = workspace(t), first = open(t, w), job = running(first);
  const part = create(first, job.id, "escape", path.join(w.artifactRoot, "owned.part.mp4"), "part");
  first.shutdown();
  const outside = path.join(w.dataRoot, "outside.part.mp4"); fs.writeFileSync(outside, "retained outside target");
  const saved = receipt(w, job.id); saved.artifacts.entries[0].path = "../outside.part.mp4";
  fs.writeFileSync(receiptFile(w, job.id), JSON.stringify(saved));
  const restored = open(t, w), cleanup = restored.get(job.id).cleanup;
  assert.equal(cleanup.status, "failed"); assert.equal(cleanup.removed, 0); assert.equal(cleanup.retained, 1);
  assert.match(cleanup.errors.join(" "), /invalid export artifact path/);
  assert.equal(fs.readFileSync(outside, "utf8"), "retained outside target");
  assert.equal(fs.existsSync(part), true, "an invalid record cannot justify deleting a different file either");
});

test("a registered path replaced by another regular file is retained with an identity failure", t => {
  const w = workspace(t), first = open(t, w), job = running(first);
  const part = create(first, job.id, "replace", path.join(w.artifactRoot, "replace.part.mp4"), "part");
  const originalIdentity = entry(w, job.id, part).identity, original = path.join(w.artifactRoot, "original-owned-file");
  fs.renameSync(part, original); fs.writeFileSync(part, "different inode at the same path");
  first.shutdown();
  const restored = open(t, w), cleanup = restored.get(job.id).cleanup;
  assert.equal(cleanup.status, "failed"); assert.equal(cleanup.removed, 0); assert.equal(cleanup.retained, 1);
  assert.match(cleanup.errors.join(" "), /replaced|identity/);
  assert.equal(fs.readFileSync(part, "utf8"), "different inode at the same path");
  assert.equal(fs.readFileSync(original, "utf8"), "owned unit artifact\n");
  assert.deepEqual(entry(w, job.id, part).identity, originalIdentity);
  assert.equal(entry(w, job.id, part).state, "owned");
});

test("a registered file replaced by a symlink and a linked session ancestor are rejected without following either", t => {
  const w = workspace(t), first = open(t, w), job = running(first), sid = "linked-session";
  const part = create(first, job.id, sid, path.join(w.artifactRoot, "replace-link.part.mp4"), "part");
  const dir = create(first, job.id, sid, path.join(w.artifactRoot, "fablecut-" + sid + "-random"), "directory");
  const audio = create(first, job.id, sid, path.join(dir, "audio.wav"), "temp-file");
  const external = path.join(w.dataRoot, "external"), externalFile = path.join(external, "audio.wav");
  fs.mkdirSync(external); fs.writeFileSync(externalFile, "external target bytes");
  fs.renameSync(part, path.join(w.artifactRoot, "unlinked-original")); fs.symlinkSync(externalFile, part, "file");
  fs.renameSync(dir, path.join(w.artifactRoot, "unlinked-session"));
  fs.symlinkSync(external, dir, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => first.createArtifact(job.id, sid, path.join(dir, "new.wav"), "temp-file"), /artifact is linked|ancestor is linked|identity changed/);
  first.shutdown();
  const restored = open(t, w), cleanup = restored.get(job.id).cleanup;
  assert.equal(cleanup.status, "failed"); assert.equal(cleanup.removed, 0); assert.equal(cleanup.retained, 3);
  assert.equal(fs.lstatSync(part).isSymbolicLink(), true); assert.equal(fs.lstatSync(dir).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(externalFile, "utf8"), "external target bytes");
  assert.equal(fs.existsSync(path.join(external, "new.wav")), false);
  assert.equal(entry(w, job.id, audio).state, "owned");
});

test("cleanup removes registered children but preserves unknown children inside its owned directory", t => {
  const w = workspace(t), jobs = open(t, w), job = running(jobs), sid = "foreign-child";
  const dir = create(jobs, job.id, sid, path.join(w.artifactRoot, "fablecut-" + sid + "-random"), "directory");
  const audio = create(jobs, job.id, sid, path.join(dir, "audio.wav"), "temp-file");
  const foreign = path.join(dir, "foreign.wav"); fs.writeFileSync(foreign, "unregistered child bytes");
  const cleanup = jobs.cleanupArtifacts(job.id, sid);
  assert.equal(cleanup.status, "failed"); assert.equal(cleanup.removed, 1); assert.equal(cleanup.retained, 1);
  assert.match(cleanup.errors.join(" "), /ENOTEMPTY|EEXIST/);
  assert.equal(fs.existsSync(audio), false); assert.equal(fs.readFileSync(foreign, "utf8"), "unregistered child bytes");
  assert.equal(fs.statSync(dir).isDirectory(), true);
  assert.equal(entry(w, job.id, dir).state, "owned"); assert.ok(entry(w, job.id, dir).error);
});

test("unlink failure is reported and its persisted ownership record retries on the next restore", t => {
  const w = workspace(t), first = open(t, w), job = running(first);
  const part = create(first, job.id, "retry", path.join(w.artifactRoot, "retry.part.mp4"), "part");
  const identity = entry(w, job.id, part).identity, unlink = fs.unlinkSync;
  try {
    fs.unlinkSync = function (file, ...args) {
      if (file === part) throw Object.assign(Error("injected unlink denial"), { code: "EACCES" });
      return unlink.call(this, file, ...args);
    };
    const cleanup = first.cleanupArtifacts(job.id);
    assert.deepEqual(cleanup, { status: "failed", removed: 0, retained: 1, errors: ["EACCES"] });
    assert.deepEqual(first.get(job.id).cleanup, cleanup);
    assert.equal(fs.existsSync(part), true); assert.equal(entry(w, job.id, part).state, "owned");
    assert.deepEqual(entry(w, job.id, part).identity, identity); assert.equal(entry(w, job.id, part).error, "EACCES");
    first.shutdown();
  } finally { fs.unlinkSync = unlink; }
  const names = receiptNames(w), restored = open(t, w);
  assert.equal(restored.get(job.id).status, "interrupted");
  assert.deepEqual(restored.get(job.id).cleanup, { status: "complete", removed: 1, retained: 0, errors: [] });
  assert.equal(fs.existsSync(part), false); assert.equal(entry(w, job.id, part).state, "removed");
  assert.deepEqual(receiptNames(w), names);
});

test("exclusive creation before durable identity leaves a planned existing artifact unknown and untouched", t => {
  const w = workspace(t), first = open(t, w), job = running(first);
  const part = path.join(w.artifactRoot, "creation-gap.part.mp4"), openSync = fs.openSync, fstatSync = fs.fstatSync;
  let artifactFd;
  try {
    fs.openSync = function (file, ...args) {
      const fd = openSync.call(this, file, ...args);
      if (file === part) artifactFd = fd;
      return fd;
    };
    fs.fstatSync = function (fd, ...args) {
      if (fd === artifactFd) throw Object.assign(Error("injected failure after create, before identity persistence"), { code: "EIO" });
      return fstatSync.call(this, fd, ...args);
    };
    assert.throws(() => first.createArtifact(job.id, "creation-gap", part, "part"), { code: "EIO" });
  } finally { fs.openSync = openSync; fs.fstatSync = fstatSync; }
  fs.appendFileSync(part, "existing but unconfirmed bytes");
  assert.equal(entry(w, job.id, part).state, "planned"); assert.equal(entry(w, job.id, part).identity, undefined);
  first.shutdown();
  const names = receiptNames(w), restored = open(t, w), cleanup = restored.get(job.id).cleanup;
  assert.equal(cleanup.status, "unknown"); assert.equal(cleanup.removed, 0); assert.equal(cleanup.retained, 1);
  assert.equal(fs.readFileSync(part, "utf8"), "existing but unconfirmed bytes");
  assert.equal(entry(w, job.id, part).state, "planned"); assert.match(entry(w, job.id, part).error, /not durably confirmed/);
  restored.shutdown();
  const second = open(t, w);
  assert.equal(second.get(job.id).cleanup.status, "unknown"); assert.deepEqual(receiptNames(w), names);
  assert.equal(fs.readFileSync(part, "utf8"), "existing but unconfirmed bytes");
});

test("zero filesystem identity stays unconfirmed and cannot authorize cleanup", t => {
  const w = workspace(t), jobs = open(t, w), job = running(jobs);
  const part = path.join(w.artifactRoot, "zero-identity.part.mp4"), openSync = fs.openSync, fstatSync = fs.fstatSync;
  let artifactFd;
  try {
    fs.openSync = function (file, ...args) {
      const fd = openSync.call(this, file, ...args);
      if (file === part) artifactFd = fd;
      return fd;
    };
    fs.fstatSync = function (fd, ...args) {
      const stat = fstatSync.call(this, fd, ...args);
      return fd === artifactFd ? { ...stat, dev: 0n } : stat;
    };
    assert.equal(jobs.createArtifact(job.id, "zero-identity", part, "part"), part);
  } finally { fs.openSync = openSync; fs.fstatSync = fstatSync; }
  fs.appendFileSync(part, "unconfirmed identity bytes");
  const record = entry(w, job.id, part);
  assert.equal(record.state, "unconfirmed"); assert.equal(record.identity, null);
  assert.match(record.error, /filesystem identity unavailable/);
  const names = receiptNames(w), cleanup = jobs.cleanupArtifacts(job.id);
  assert.equal(cleanup.status, "unknown"); assert.equal(cleanup.removed, 0); assert.equal(cleanup.retained, 1);
  assert.match(cleanup.errors.join(" "), /not durably confirmed/);
  assert.deepEqual(jobs.get(job.id).cleanup, cleanup); assert.deepEqual(receipt(w, job.id).cleanup, cleanup);
  assert.equal(entry(w, job.id, part).state, "unconfirmed"); assert.equal(entry(w, job.id, part).identity, null);
  assert.equal(fs.readFileSync(part, "utf8"), "unconfirmed identity bytes"); assert.deepEqual(receiptNames(w), names);
});
