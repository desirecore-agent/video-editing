/* Executes the production attribute query with the installed Windows PowerShell.
   Filesystem/PowerShell regression only: no browser, encoder or native GUI claim. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");

test("Windows PowerShell reads exact UTF-8 paths for creation and original-job recovery", { skip: process.platform !== "win32" }, t => {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-editing-属性-'[$]-")));
  const artifactRoot = path.join(dataRoot, "exports"), storeDir = path.join(artifactRoot, "jobs"), handles = [];
  fs.mkdirSync(storeDir, { recursive: true });
  const modulePath = require.resolve("../export-jobs"), cached = require.cache[modulePath], nativeSpawnSync = cp.spawnSync, probes = [];
  t.after(() => {
    try { for (const jobs of handles.reverse()) jobs.shutdown(); }
    finally {
      cp.spawnSync = nativeSpawnSync; delete require.cache[modulePath];
      if (cached) require.cache[modulePath] = cached;
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
  // Observe real child results without substituting or changing their behavior.
  // In particular a missing literal path must not silently report a safe flag 0.
  const diagnosticText = value => {
    const text = String(value ?? ""), bytes = Buffer.from(text, "utf8");
    return { chars: text.length, utf8Bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      preview: bytes.subarray(0, 4096).toString("utf8"), truncated: bytes.length > 4096 };
  };
  const diagnosticError = error => error ? { name: error.name, code: error.code ?? null, message: diagnosticText(error.message) } : null;
  cp.spawnSync = (command, args, options) => {
    const paths = JSON.parse(options.input), exists = paths.map(file => fs.existsSync(file));
    const started = process.hrtime.bigint();
    let result;
    try { result = nativeSpawnSync(command, args, options); }
    catch (error) {
      t.diagnostic(JSON.stringify({ kind: "actual-powershell-attribute-probe", call: probes.length + 1, command,
        pathCount: paths.length, existsBeforeQuery: exists, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
        thrownNodeError: diagnosticError(error) }));
      throw error;
    }
    t.diagnostic(JSON.stringify({ kind: "actual-powershell-attribute-probe", call: probes.length + 1, command,
      pathCount: paths.length, existsBeforeQuery: exists, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
      error: diagnosticError(result.error), status: result.status ?? null, signal: result.signal ?? null,
      observedEncoding: options.encoding, stdout: diagnosticText(result.stdout), stderr: diagnosticText(result.stderr) }));
    probes.push({ command, paths, exists, result });
    return result;
  };
  delete require.cache[modulePath];
  const { createExportJobs } = require(modulePath);
  const options = { dataRoot, artifactRoot, storeDir, editors: () => 1, broadcast: () => {}, url: id => id };
  const open = () => { const jobs = createExportJobs(options); handles.push(jobs); return jobs; };
  const running = jobs => { const job = jobs.request({ where: "tab", revision: 17 }); assert.equal(jobs.claim(job.id), true); return job; };
  const read = id => JSON.parse(fs.readFileSync(path.join(storeDir, id + ".json"), "utf8"));
  const contents = file => fs.readFileSync(file).toString("hex");
  const jobs = open(), done = running(jobs), outside = path.join(dataRoot, "outside.part.mp4");

  // The invalid relative path leaves only the exports root in the native query.
  // It must pass the one-path transport and fail the independent path boundary.
  const originalReceipt = fs.readFileSync(path.join(storeDir, done.id + ".json"));
  assert.equal(fs.existsSync(outside), false, "the outside path starts absent");
  const rejectOutside = () => jobs.createArtifact(done.id, "native-done", outside, "part");
  let firstError;
  try { rejectOutside(); } catch (error) { firstError = error; }
  assert.ok(firstError, "the outside path must never be admitted");
  if (probes.length === 1 && probes[0].result.error?.code === "ETIMEDOUT") {
    // An overloaded cold Windows PowerShell can exceed the production budget.
    // Its fail-closed result is correct, but does not qualify the path boundary
    // or singleton transport. Preserve that original observation, prove this
    // invalid operation wrote nothing, and allow just one read-only retry.
    assert.equal(probes[0].command, "powershell.exe");
    assert.deepEqual(probes[0].paths, [artifactRoot]);
    assert.match(String(firstError), /reparse status is unsafe or unconfirmed/);
    assert.equal(fs.existsSync(outside), false);
    assert.deepEqual(fs.readFileSync(path.join(storeDir, done.id + ".json")), originalReceipt);
    probes[0].preparationTimeout = true;
    t.diagnostic(JSON.stringify({ kind: "initial-native-query-timeout", call: 1,
      qualification: false, failClosed: true, receiptUnchanged: true, outsideCreated: false,
      boundedReadOnlyRetries: 1, productionTimeoutMs: 5000 }));
    assert.throws(rejectOutside, /invalid export artifact path/);
  } else assert.match(String(firstError), /invalid export artifact path/);
  assert.equal(fs.existsSync(outside), false);
  assert.deepEqual(fs.readFileSync(path.join(storeDir, done.id + ".json")), originalReceipt);
  const donePart = path.join(artifactRoot, "done.part.mp4"), doneFile = path.join(artifactRoot, "done.mp4");
  assert.equal(jobs.createArtifact(done.id, "native-done", donePart, "part"), donePart);
  fs.appendFileSync(donePart, "finished native filesystem fixture");
  fs.renameSync(donePart, doneFile);
  jobs.report(done.id, { status: "done", src: "/exports/done.mp4" });

  const job = running(jobs), session = "native-recovery", dir = path.join(artifactRoot, "fablecut-" + session + "-random");
  assert.equal(jobs.createArtifact(job.id, session, dir, "directory"), dir);
  const audio = path.join(dir, "声音 '[x] é.wav");
  assert.equal(jobs.createArtifact(job.id, session, audio, "temp-file"), audio);
  jobs.writeArtifact(job.id, session, audio, Buffer.from("native UTF-8 artifact bytes", "utf8"));
  const parts = ["batch-one.part.mp4", "batch-two.part.webm"].map(name => path.join(artifactRoot, name));
  for (const file of parts) {
    assert.equal(jobs.createArtifact(job.id, session, file, "part"), file);
    fs.appendFileSync(file, "native batch part: " + path.basename(file));
  }
  const before = read(job.id);
  assert.equal(before.artifacts.entries.length, 4);
  assert.ok(before.artifacts.entries.every(e => e.state === "owned" && BigInt(e.identity.dev) > 0n && BigInt(e.identity.ino) > 0n && BigInt(e.identity.birthtimeNs) > 0n));
  const foreign = path.join(artifactRoot, "foreign.part.mp4");
  fs.writeFileSync(foreign, "unregistered foreign bytes");
  const preserved = [doneFile, foreign].map(file => [file, contents(file)]);
  jobs.shutdown();

  const restored = open(), original = restored.get(job.id);
  assert.equal(original.id, job.id); assert.equal(original.created, before.created); assert.equal(original.status, "interrupted");
  assert.deepEqual(original.cleanup, { status: "complete", removed: 4, retained: 0, errors: [] });
  for (const file of [audio, ...parts, dir]) assert.equal(fs.existsSync(file), false);
  for (const [file, bytes] of preserved) assert.equal(contents(file), bytes);
  assert.equal(restored.get(done.id).status, "done");
  assert.deepEqual(fs.readdirSync(storeDir).sort(), [done.id + ".json", job.id + ".json"].sort());
  const qualifiedProbes = probes.filter(probe => !probe.preparationTimeout);
  assert.ok(qualifiedProbes.some(probe => probe.paths.length === 1), "a successful one-path JSON array must remain one flag");
  assert.ok(qualifiedProbes.some(probe => probe.paths.length > 2), "recovery must exercise a real multi-path batch");
  assert.ok(qualifiedProbes.some(probe => probe.exists.includes(false)), "creation must query actually missing paths");
  for (const { command, exists, result } of qualifiedProbes) {
    assert.equal(command, "powershell.exe");
    assert.equal(result.error, undefined); assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), exists.map(found => found ? 0 : -1));
  }
});
