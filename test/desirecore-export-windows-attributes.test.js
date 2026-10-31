/* Node/fs unit contract for the Windows attribute batch, using a spawnSync
   substitute only. This is not Windows, PowerShell, GUI or native evidence. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const MODULE = require.resolve("../export-jobs");
const serial = { concurrency: false };

function workspace(t) {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-win-attributes-'[$]-")));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const artifactRoot = path.join(dataRoot, "exports"), storeDir = path.join(artifactRoot, "jobs");
  fs.mkdirSync(storeDir, { recursive: true });
  const project = path.join(dataRoot, "project.json");
  fs.writeFileSync(project, '{"name":"attribute unit fixture","revision":17}\n');
  return { dataRoot, artifactRoot, storeDir, project };
}

function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  assert.ok(stat.dev > 0n && stat.ino > 0n && stat.birthtimeNs > 0n, "fixture needs actual nonzero filesystem identities");
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}

function seed(w, sid, { missing = false, removed = false } = {}) {
  const id = "x_" + sid, dir = path.join(w.artifactRoot, "fablecut-" + sid + "-random");
  fs.mkdirSync(dir, { mode: 0o700 });
  const audio = path.join(dir, "audio.wav"), part = path.join(w.artifactRoot, sid + ".part.mp4");
  for (const file of [audio, part]) fs.writeFileSync(file, "owned unit bytes: " + path.basename(file), { flag: "wx", mode: 0o600 });
  const record = (file, kind) => ({ sessionId: sid, path: path.relative(w.artifactRoot, file).split(path.sep).join("/"),
    kind, state: "owned", identity: identity(file) });
  const entries = [record(dir, "directory"), record(audio, "temp-file"), record(part, "part")];
  let missingFile, removedFile;
  if (missing) {
    missingFile = path.join(w.artifactRoot, sid + "-missing.part.mp4");
    fs.writeFileSync(missingFile, "gone before startup", { flag: "wx" });
    entries.push(record(missingFile, "part")); fs.unlinkSync(missingFile);
  }
  if (removed) {
    removedFile = path.join(w.artifactRoot, sid + "-removed.part.mp4");
    fs.writeFileSync(removedFile, "old removed artifact", { flag: "wx" });
    entries.push({ ...record(removedFile, "part"), state: "removed" });
    fs.unlinkSync(removedFile); fs.writeFileSync(removedFile, "foreign occupant after a historical removal", { flag: "wx" });
  }
  const job = { id, kind: "export", status: "running", via: "tab", created: Date.now(), updated: Date.now(), progress: 0.25,
    snapshot: { receipt: { projectRevision: 17 } }, artifacts: { schemaVersion: 1, jobId: id, rootIdentity: identity(w.artifactRoot), entries } };
  fs.writeFileSync(path.join(w.storeDir, id + ".json"), JSON.stringify(job), { flag: "wx" });
  return { id, dir, audio, part, missingFile, removedFile, job };
}

const opts = w => ({ storeDir: w.storeDir, dataRoot: w.dataRoot, artifactRoot: w.artifactRoot,
  editors: () => 1, broadcast: () => assert.fail("restoring jobs must not broadcast new work"), url: id => id,
  launchBrowser: () => assert.fail("restoring jobs must not launch a browser") });
const receipt = (w, id) => JSON.parse(fs.readFileSync(path.join(w.storeDir, id + ".json"), "utf8"));
const contents = file => fs.readFileSync(file).toString("hex");
const regularFlags = paths => ({ status: 0, stdout: JSON.stringify(paths.map(file => fs.existsSync(file) ? 0 : -1)), stderr: "" });

async function withWindowsBatch(reply, body) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform"), spawnSync = cp.spawnSync;
  const cached = require.cache[MODULE], calls = [], handles = [];
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    cp.spawnSync = (command, args, options) => {
      const paths = JSON.parse(options.input);
      const call = { command, args, options, paths };
      calls.push(call);
      call.response = reply(paths, calls.length);
      return call.response;
    };
    delete require.cache[MODULE];
    const { createExportJobs } = require(MODULE);
    const create = options => { const jobs = createExportJobs(options); handles.push(jobs); return jobs; };
    return await body({ create, calls });
  } finally {
    try { for (const jobs of handles.reverse()) jobs.shutdown(); }
    finally {
      cp.spawnSync = spawnSync;
      Object.defineProperty(process, "platform", platform);
      delete require.cache[MODULE];
      if (cached) require.cache[MODULE] = cached;
    }
  }
}

function assertBatch(call, expected) {
  assert.equal(call.command, "powershell.exe");
  assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(call.args.length, 4); assert.match(call.args[3], /Get-Item -LiteralPath/); assert.match(call.args[3], /ReparsePoint/);
  assert.equal(call.options.timeout, 5000); assert.equal(call.options.encoding, "utf8"); assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.maxBuffer, 1024 * 1024); assert.equal(call.options.shell, undefined);
  assert.ok(Array.isArray(call.paths)); assert.equal(new Set(call.paths).size, call.paths.length, "one path appears only once in a batch");
  assert.deepEqual([...call.paths].sort(), [...expected].sort());
  assert.ok(call.paths.every(file => path.isAbsolute(file)));
  assert.ok(expected.every(file => !call.args[3].includes(file)), "exact paths travel through stdin, not interpolated PowerShell source");
}

test("startup checks all restored jobs and ancestors in one exact batch, including missing but excluding removed paths", serial, async t => {
  const w = workspace(t), first = seed(w, "first", { missing: true, removed: true }), second = seed(w, "second");
  const names = fs.readdirSync(w.storeDir).sort(), project = contents(w.project), removed = contents(first.removedFile);
  const expected = [w.artifactRoot, first.dir, first.audio, first.part, first.missingFile, second.dir, second.audio, second.part];
  await withWindowsBatch(regularFlags, ({ create, calls }) => {
    const jobs = create(opts(w));
    assert.equal(calls.length, 1, "startup must not launch one native query per job or ancestor"); assertBatch(calls[0], expected);
    const flags = JSON.parse(calls[0].response.stdout);
    assert.equal(flags[calls[0].paths.indexOf(first.missingFile)], -1, "the missing fixture exercises the -1 native flag");
    assert.equal(flags.filter(flag => flag === -1).length, 1);
    for (const item of [first, second]) {
      const original = jobs.get(item.id);
      assert.equal(original.status, "interrupted"); assert.equal(original.created, item.job.created);
      assert.deepEqual(original.snapshot, item.job.snapshot);
      assert.deepEqual(original.cleanup, { status: "complete", removed: item.job.artifacts.entries.length, retained: 0, errors: [] });
      for (const file of [item.dir, item.audio, item.part]) assert.equal(fs.existsSync(file), false);
    }
    assert.equal(contents(first.removedFile), removed); assert.equal(contents(w.project), project);
    assert.deepEqual(fs.readdirSync(w.storeDir).sort(), names);
  });
});

const invalidResponses = [
  ["short flag array", paths => ({ status: 0, stdout: JSON.stringify(paths.map(() => 0).slice(1)) }), /batch is incomplete/],
  ["extra flag array", paths => ({ status: 0, stdout: JSON.stringify([...paths.map(() => 0), 0]) }), /batch is incomplete/],
  ["scalar flag instead of array", () => ({ status: 0, stdout: "0" }), /batch is incomplete/],
  ["invalid flag value", paths => ({ status: 0, stdout: JSON.stringify(paths.map((_, i) => i === 0 ? 7 : 0)) }), /batch is incomplete/],
  ["invalid JSON", () => ({ status: 0, stdout: "not JSON" }), /batch is invalid/],
  ["native nonzero exit", () => ({ status: 4, stdout: "[]", stderr: "unit native failure" }), /unsafe or unconfirmed/],
  ["native timeout error", () => ({ status: null, error: Object.assign(Error("unit timeout"), { code: "ETIMEDOUT" }), stdout: "" }), /unsafe or unconfirmed/],
];
for (const [name, reply, error] of invalidResponses) test(`startup retains artifacts and reports failed for ${name}`, serial, async t => {
  const w = workspace(t), item = seed(w, "invalid"), preserved = [w.project, item.audio, item.part].map(file => [file, contents(file)]);
  await withWindowsBatch(reply, ({ create, calls }) => {
    let jobs;
    assert.doesNotThrow(() => { jobs = create(opts(w)); }, "an unsafe native response must become cleanup failure, not a startup crash");
    assert.equal(calls.length, 1); assertBatch(calls[0], [w.artifactRoot, item.dir, item.audio, item.part]);
    const cleanup = jobs.get(item.id).cleanup;
    assert.equal(cleanup.status, "failed"); assert.equal(cleanup.removed, 0); assert.equal(cleanup.retained, 3);
    assert.equal(cleanup.errors.length, 3); assert.ok(cleanup.errors.every(message => error.test(message)));
    assert.deepEqual(receipt(w, item.id).cleanup, cleanup); assert.equal(jobs.get(item.id).status, "interrupted");
    for (const [file, bytes] of preserved) assert.equal(contents(file), bytes);
    assert.equal(fs.statSync(item.dir).isDirectory(), true);
    assert.ok(receipt(w, item.id).artifacts.entries.every(record => record.state === "owned"));
  });
});

for (const flag of [1, -1]) test(`an existing artifact with native flag ${flag} is retained despite its regular lstat`, serial, async t => {
  const w = workspace(t), item = seed(w, "unsafe"), part = contents(item.part);
  await withWindowsBatch(paths => ({ status: 0, stdout: JSON.stringify(paths.map(file => file === item.part ? flag : 0)) }), ({ create, calls }) => {
    const jobs = create(opts(w)), cleanup = jobs.get(item.id).cleanup;
    assert.equal(calls.length, 1); assertBatch(calls[0], [w.artifactRoot, item.dir, item.audio, item.part]);
    assert.equal(cleanup.status, "failed"); assert.equal(cleanup.removed, 2); assert.equal(cleanup.retained, 1);
    assert.match(cleanup.errors.join(" "), /unsafe or unconfirmed/);
    assert.equal(fs.lstatSync(item.part).isFile(), true); assert.equal(contents(item.part), part);
    assert.equal(fs.existsSync(item.audio), false); assert.equal(fs.existsSync(item.dir), false);
    assert.deepEqual(receipt(w, item.id).cleanup, cleanup);
  });
});

test("a valid native batch cannot replace fresh lstat identity checks after the query", serial, async t => {
  const w = workspace(t), item = seed(w, "replaced"), original = path.join(w.artifactRoot, "original-identity-sentinel");
  const originalBytes = contents(item.part);
  await withWindowsBatch(paths => {
    fs.renameSync(item.part, original); fs.writeFileSync(item.part, "replacement after attribute query", { flag: "wx" });
    return regularFlags(paths);
  }, ({ create, calls }) => {
    const jobs = create(opts(w)), cleanup = jobs.get(item.id).cleanup;
    assert.equal(calls.length, 1); assertBatch(calls[0], [w.artifactRoot, item.dir, item.audio, item.part]);
    assert.equal(cleanup.status, "failed"); assert.equal(cleanup.removed, 2); assert.equal(cleanup.retained, 1);
    assert.match(cleanup.errors.join(" "), /replaced|identity/);
    assert.equal(fs.readFileSync(item.part, "utf8"), "replacement after attribute query"); assert.equal(contents(original), originalBytes);
    assert.deepEqual(receipt(w, item.id).cleanup, cleanup);
  });
});

test("cleanup after an await issues a fresh batch and never reuses the earlier safe attributes", serial, async t => {
  const w = workspace(t), item = seed(w, "fresh"), part = contents(item.part), unlink = fs.unlinkSync;
  let phase = "initial";
  await withWindowsBatch(paths => ({ status: 0, stdout: JSON.stringify(paths.map(file => phase === "blocked" && file === item.part ? 1 : 0)) }), async ({ create, calls }) => {
    let jobs;
    try {
      fs.unlinkSync = function (file, ...args) {
        if (file === item.part) throw Object.assign(Error("unit first-operation unlink denial"), { code: "EACCES" });
        return unlink.call(this, file, ...args);
      };
      jobs = create(opts(w));
    } finally { fs.unlinkSync = unlink; }
    assert.equal(jobs.get(item.id).cleanup.status, "failed"); assert.equal(contents(item.part), part);
    assert.equal(calls.length, 1); assertBatch(calls[0], [w.artifactRoot, item.dir, item.audio, item.part]);
    phase = "blocked"; await Promise.resolve();
    const blocked = jobs.cleanupArtifacts(item.id);
    assert.equal(calls.length, 2); assertBatch(calls[1], [w.artifactRoot, item.part]);
    assert.equal(blocked.status, "failed"); assert.equal(blocked.retained, 1); assert.equal(contents(item.part), part);
    assert.match(blocked.errors.join(" "), /unsafe or unconfirmed/);
    phase = "confirmed"; await Promise.resolve();
    const complete = jobs.cleanupArtifacts(item.id);
    assert.equal(calls.length, 3); assertBatch(calls[2], [w.artifactRoot, item.part]);
    assert.deepEqual(complete, { status: "complete", removed: 3, retained: 0, errors: [] });
    assert.equal(fs.existsSync(item.part), false); assert.deepEqual(receipt(w, item.id).cleanup, complete);
  });
});
