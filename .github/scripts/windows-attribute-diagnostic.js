"use strict";
// Post-failure observations only. The required native test runs first and keeps
// its original failure; these later queries never qualify an export or cold run.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const EXPECTED_SCRIPT_SHA = "bb44dfe2b083b361887fdb631bd8570a522778f8b01db3ddc208c5ce4f709c9b";
const QUERY_TIMEOUT_MS = 9000; // Leave termination overhead below ten seconds.
const TOTAL_BUDGET_MS = 40000;
const MAX_BUFFER = 1024 * 1024, PREVIEW_BYTES = 4096;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const emit = value => console.log("WINDOWS_ATTRIBUTE_DIAGNOSTIC " + JSON.stringify(value));
const describe = value => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
  const prefix = bytes.subarray(0, PREVIEW_BYTES);
  return { bytes: bytes.length, sha256: sha(bytes), rawBase64Prefix: prefix.toString("base64"),
    utf8Preview: prefix.toString("utf8"), truncated: bytes.length > prefix.length };
};
const errorView = error => error ? { name: error.name, code: error.code ?? null, message: describe(error.message) } : null;

function main() {
  if (process.platform !== "win32") throw Error("This diagnostic must run on the failed Windows runner");
  const started = process.hrtime.bigint(), elapsedTotal = () => Number(process.hrtime.bigint() - started) / 1e6, records = [];
  const source = fs.readFileSync(path.resolve(__dirname, "../../export-jobs.js"));
  const match = /const names=\[\.\.\.paths\],script='([^'\r\n]+)';/.exec(source.toString("utf8"));
  if (!match || sha(Buffer.from(match[1], "utf8")) !== EXPECTED_SCRIPT_SHA) throw Error("Exact production attribute script is unavailable");
  const production = match[1], originalRead = "$paths=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd());";
  if (production.split(originalRead).length !== 2) throw Error("Production JSON reader must have exactly one known occurrence");
  const candidate = production.replace(originalRead,
    "$encoded=($input | Out-String).Trim(); $paths=ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)));");
  const root = fs.realpathSync(os.tmpdir()), missing = path.join(root, "video-editing-attrs-post-failure-属性-'[$]-" + crypto.randomUUID());
  if (!fs.lstatSync(root).isDirectory() || fs.existsSync(missing)) throw Error("Diagnostic requires one existing temporary root and one missing synthetic leaf");
  const paths = [root, missing], json = JSON.stringify(paths);
  emit({ kind: "scope", at: new Date().toISOString(), qualification: false, postFailure: true, originalColdTiming: false,
    node: process.version, arch: process.arch, osRelease: os.release(), sourceSha256: sha(source),
    productionScriptSha256: EXPECTED_SCRIPT_SHA, candidateScriptSha256: sha(Buffer.from(candidate, "utf8")),
    queryLimit: 3, queryTimeoutMs: QUERY_TIMEOUT_MS, totalBudgetMs: TOTAL_BUDGET_MS,
    paths, existsBeforeQueries: paths.map(file => fs.existsSync(file)),
    filesCreatedOrDeleted: false, businessJobCreated: false });

  // This filesystem lookup is only a PATH candidate. Query1 separately reports
  // its actual process executable; neither result is the original failed PID.
  let pathCandidate = null, unconfirmedPathEntries = 0;
  const directories = String(process.env.PATH || process.env.Path || "").split(path.delimiter);
  for (let index = 0; index < directories.length; index++) {
    if (elapsedTotal() >= TOTAL_BUDGET_MS - 1000) throw Error("Diagnostic budget exhausted during PATH lookup");
    const directory = directories[index].replace(/^"(.*)"$/, "$1");
    const file = path.resolve(directory || ".", "powershell.exe");
    let stat;
    try { stat = fs.statSync(file); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      unconfirmedPathEntries++;
      emit({ kind: "path-entry-unconfirmed", index, errorName: error.name, errorCode: error.code ?? null });
      continue;
    }
    if (!stat.isFile()) continue;
    pathCandidate = { kind: "path-candidate", observedBy: "Node filesystem lookup of PATH entries in order; candidate only",
      index, path: file, realPath: fs.realpathSync(file), bytes: stat.size,
      precedingEntriesUnconfirmed: unconfirmedPathEntries,
      sha256: stat.size <= 16 * 1024 * 1024 ? sha(fs.readFileSync(file)) : null,
      hashUnavailableReason: stat.size > 16 * 1024 * 1024 ? "executable exceeds bounded hash size" : null,
      actualProcessPathClaimed: false, metadataReadBeforeQueries: true };
    emit(pathCandidate);
    break;
  }
  if (!pathCandidate) emit({ kind: "path-candidate-unavailable", qualification: false });

  function query(name, script, input) {
    if (records.length >= 3) throw Error("Diagnostic query count exceeded");
    const remaining = Math.floor(TOTAL_BUDGET_MS - elapsedTotal() - 1000);
    if (remaining <= 0) throw Error("Diagnostic total budget exhausted before query");
    const timeout = Math.min(QUERY_TIMEOUT_MS, remaining), args = ["-NoProfile", "-NonInteractive", "-Command", script];
    const at = new Date().toISOString(), before = process.hrtime.bigint();
    let result;
    try {
      // Omit output encoding to retain raw buffers. String stdin uses the same
      // UTF-8 bytes as production; only the diagnostic deadline/output differ.
      result = spawnSync("powershell.exe", args, { input, windowsHide: true, timeout, maxBuffer: MAX_BUFFER });
    } catch (error) {
      const record = { kind: "query", name, at, executed: null, spawnAttempted: true, thrownNodeError: errorView(error),
        elapsedMs: Number(process.hrtime.bigint() - before) / 1e6 };
      records.push(record); emit(record);
      return null;
    }
    const record = { kind: "query", name, at, executed: true, command: "powershell.exe", args,
      scriptSha256: sha(Buffer.from(script, "utf8")), inputType: input === undefined ? "none" : "string",
      input: describe(input), timeoutMs: timeout, elapsedMs: Number(process.hrtime.bigint() - before) / 1e6,
      pid: result.pid ?? null, status: result.status, signal: result.signal, error: errorView(result.error),
      stdout: describe(result.stdout), stderr: describe(result.stderr), qualification: false };
    records.push(record); emit(record);
    return result;
  }

  const versionScript = '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write((ConvertTo-Json -InputObject ([ordered]@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;psHome=$PSHOME;hostName=$Host.Name;processPath=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName;pathResolvedCommand=(Get-Command powershell.exe -CommandType Application).Source;inputCodePage=[Console]::InputEncoding.CodePage;outputCodePage=[Console]::OutputEncoding.CodePage;inputRedirected=[Console]::IsInputRedirected;process64=[Environment]::Is64BitProcess}) -Compress))';
  const version = query("no-stdin-version-and-executable", versionScript, undefined);
  let executable = null;
  if (version && version.status === 0 && !version.error) {
    try {
      const facts = JSON.parse(version.stdout.toString("utf8").replace(/^\uFEFF/, "").trim());
      const file = facts.processPath;
      if (typeof file !== "string" || !/^[A-Za-z]:[\\/]/.test(file) || path.basename(file).toLowerCase() !== "powershell.exe") throw Error("Actual process executable is not a local powershell.exe");
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw Error("Actual PowerShell executable is not a bounded regular file");
      executable = { kind: "executable", observedBy: "new query1 current process and Get-Command PATH resolution; not the original timed-out process",
        facts, pathResolutionMatchesProcess: typeof facts.pathResolvedCommand === "string" && path.resolve(facts.pathResolvedCommand).toLowerCase() === path.resolve(file).toLowerCase(),
        realPath: fs.realpathSync(file), bytes: stat.size, sha256: sha(fs.readFileSync(file)) };
      emit(executable);
    } catch (error) { emit({ kind: "executable-unconfirmed", error: errorView(error) }); }
  }
  const direct = query("exact-production-Console-In-JSON", production, json);
  const alternate = query("candidate-pipeline-ASCII-base64-UTF8", candidate, Buffer.from(json, "utf8").toString("base64"));
  const parsedFlags = result => {
    try { return result && result.status === 0 && !result.error ? JSON.parse(result.stdout.toString("utf8").trim()) : null; }
    catch { return null; }
  };
  const directFlags = parsedFlags(direct), alternateFlags = parsedFlags(alternate), elapsedMs = elapsedTotal();
  const successful = record => record.executed && record.status === 0 && !record.error && record.elapsedMs <= 10000;
  const expected = flags => Array.isArray(flags) && flags.length === 2 && flags[0] === 0 && flags[1] === -1;
  const complete = records.length === 3 && records.every(successful) && executable !== null && expected(directFlags) && expected(alternateFlags) && elapsedMs <= TOTAL_BUDGET_MS;
  emit({ kind: "summary", queryCount: records.length, elapsedMs, diagnosticComplete: complete,
    pathCandidateKnown: pathCandidate !== null, directFlags, candidateFlags: alternateFlags, qualification: false, originalNativeFailureUnchanged: true,
    originalColdTiming: false, noWarmupBeforeNativeTest: true, noRetry: true, noBusinessJob: true,
    note: "These distinct post-failure queries can change shared initialization state. They do not measure the original cold completion time or turn the failed native test into a pass." });
  if (!complete) process.exitCode = 1;
}

try { main(); }
catch (error) { emit({ kind: "diagnostic-failed", qualification: false, error: errorView(error) }); process.exitCode = 1; }
