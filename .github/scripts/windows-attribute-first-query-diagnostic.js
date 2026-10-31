"use strict";
// A separate failure-only job. Its first declared query is not a replay of the
// failed native test, and the larger diagnostic deadline is not a product pass.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const crypto = require("node:crypto"), { spawnSync } = require("node:child_process");
const EXPECTED_SCRIPT_SHA = "bb44dfe2b083b361887fdb631bd8570a522778f8b01db3ddc208c5ce4f709c9b";
const TIMEOUT_MS = 9000, MAX_BUFFER = 1024 * 1024, PREVIEW = 4096;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const emit = value => console.log("WINDOWS_ATTRIBUTE_FIRST_QUERY " + JSON.stringify(value));
const textView = value => {
  const text = String(value ?? ""), bytes = Buffer.from(text, "utf8"), prefix = bytes.subarray(0, PREVIEW);
  return { chars: text.length, returnedUtf8Bytes: bytes.length, returnedUtf8Sha256: sha(bytes),
    returnedUtf8Base64Prefix: prefix.toString("base64"), preview: prefix.toString("utf8"), truncated: bytes.length > PREVIEW };
};
const errorView = error => error ? { name: error.name, code: error.code ?? null, message: textView(error.message) } : null;
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error("Expected exactly one known production statement");
  return source.replace(before, after);
}
function tracedScript(source) {
  let script = replaceOnce(source, '$ErrorActionPreference="Stop";', '$ErrorActionPreference="Stop"; [Console]::Error.WriteLine("TRACE:entry"); [Console]::Error.WriteLine(("TRACE:metadata="+(ConvertTo-Json -InputObject ([ordered]@{version=$PSVersionTable.PSVersion.ToString();psHome=$PSHOME;hostName=$Host.Name;processPath=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName;inputCodePage=[Console]::InputEncoding.CodePage;outputCodePage=[Console]::OutputEncoding.CodePage}) -Compress)));');
  script = replaceOnce(script, '[Console]::InputEncoding=[Text.Encoding]::UTF8;', '[Console]::Error.WriteLine("TRACE:before-input-encoding"); [Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::Error.WriteLine(("TRACE:after-input-encoding="+[Console]::InputEncoding.CodePage));');
  script = replaceOnce(script, '$paths=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd());', '[Console]::Error.WriteLine("TRACE:before-read"); $raw=[Console]::In.ReadToEnd(); [Console]::Error.WriteLine(("TRACE:after-read-chars="+$raw.Length)); [Console]::Error.WriteLine("TRACE:before-json"); $paths=ConvertFrom-Json -InputObject $raw; [Console]::Error.WriteLine(("TRACE:after-json-count="+@($paths).Count));');
  script = replaceOnce(script, '$item=Get-Item -LiteralPath $p -Force -ErrorAction Stop;', '[Console]::Error.WriteLine(("TRACE:path64="+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p)))); [Console]::Error.WriteLine("TRACE:before-get-item"); $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop; [Console]::Error.WriteLine("TRACE:after-get-item");');
  return replaceOnce(script, '[Console]::Write((ConvertTo-Json -InputObject $result -Compress))', '[Console]::Error.WriteLine("TRACE:before-output"); [Console]::Write((ConvertTo-Json -InputObject $result -Compress)); [Console]::Error.WriteLine("TRACE:after-output")');
}
function main() {
  if (process.platform !== "win32") throw Error("A separate Windows diagnostic runner is required");
  const source = fs.readFileSync(path.resolve(__dirname, "../../export-jobs.js"));
  const match = /const names=\[\.\.\.paths\],script='([^'\r\n]+)';/.exec(source.toString("utf8"));
  if (!match || sha(Buffer.from(match[1])) !== EXPECTED_SCRIPT_SHA) throw Error("Exact production bb44 script unavailable");
  const production = match[1], trace = tracedScript(production), owned = [], records = [];
  let cleanupComplete = true, complete = false;
  function own(directory) {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev <= 0n || stat.ino <= 0n || stat.birthtimeNs <= 0n) throw Error("Fixture directory identity is unconfirmed");
    owned.push({ path: directory, identity: identity(stat) });
  }
  function query(name, script, input, first) {
    if (records.length >= 2) throw Error("Only two distinct diagnostic queries are permitted");
    const args = ["-NoProfile", "-NonInteractive", "-Command", script], at = new Date().toISOString(), started = process.hrtime.bigint();
    let result;
    try { result = spawnSync("powershell.exe", args, { input, encoding: "utf8", windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }); }
    catch (error) {
      records.push({ name, at, firstDeclaredDriverQuery: first, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, thrownNodeError: errorView(error) });
      emit({ kind: "query-threw", ...records[records.length - 1], qualification: false }); return null;
    }
    const record = { kind: "query", name, at, firstDeclaredDriverQuery: first, command: "powershell.exe", args,
      scriptSha256: sha(Buffer.from(script)), input: textView(input), encoding: "utf8", timeoutMs: TIMEOUT_MS,
      windowsHide: true, maxBuffer: MAX_BUFFER, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
      pid: result.pid ?? null, status: result.status, signal: result.signal, error: errorView(result.error),
      stdout: textView(result.stdout), stderr: textView(result.stderr), qualification: false };
    records.push(record); emit(record); return result;
  }
  try {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-editing-属性-'[$]-")));
    own(root);
    const exportsRoot = path.join(root, "exports"), jobsRoot = path.join(exportsRoot, "jobs");
    fs.mkdirSync(exportsRoot); own(exportsRoot); fs.mkdirSync(jobsRoot); own(jobsRoot);
    const input = JSON.stringify([exportsRoot]);
    emit({ kind: "scope", at: new Date().toISOString(), node: process.version, arch: process.arch, osRelease: os.release(),
      sourceSha256: sha(source), productionScriptSha256: EXPECTED_SCRIPT_SHA, fixture: owned,
      existsBeforeFirst: fs.existsSync(exportsRoot), firstQueryBeforeAnyPowerShellVersionOrExecutableHash: true,
      queryLimit: 2, perQueryTimeoutMs: TIMEOUT_MS, originalProductTimeoutMs: 2500,
      qualification: false, originalColdTiming: false, driverContext: "plain Node in a separate failure-only job, not the original node --test child" });
    // No version command, PE hash, PATH probe or other PowerShell invocation has
    // occurred in this driver before this exact-script first query.
    const first = query("first-exact-production-existing-Unicode-root", production, input, true);
    let candidate = null;
    for (const directory of String(process.env.PATH || process.env.Path || "").split(path.delimiter)) {
      const file = path.resolve(directory.replace(/^"(.*)"$/, "$1") || ".", "powershell.exe");
      let stat; try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      candidate = { kind: "path-candidate-after-first", path: file, realPath: fs.realpathSync(file), bytes: stat.size,
        sha256: stat.size <= 16 * 1024 * 1024 ? sha(fs.readFileSync(file)) : null, actualFirstProcessPathClaimed: false };
      emit(candidate); break;
    }
    const second = query("phase-traced-same-guard-existing-Unicode-root", trace, input, false);
    const valid = result => {
      try { const flags = JSON.parse(result.stdout.trim()); return result.status === 0 && !result.error && Array.isArray(flags) && flags.length === 1 && flags[0] === 0; }
      catch { return false; }
    };
    complete = valid(first) && valid(second) && records.every(record => record.elapsedMs <= 10000);
    emit({ kind: "observations", queryCount: records.length, complete, qualification: false,
      firstQueryIsOriginalColdReplay: false, phaseTraceCanChangeTiming: true, outputEncodingChangedByTrace: false,
      noBusinessJob: true, note: "A successful nine-second diagnostic is not a pass under the production2500ms deadline. The original Native test stays independent and red." });
  } finally {
    for (const item of owned.reverse()) {
      try {
        const stat = fs.lstatSync(item.path, { bigint: true }), observed = identity(stat);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(item.path) !== item.path || Object.keys(item.identity).some(key => item.identity[key] !== observed[key])) throw Error("Fixture directory identity changed; retained");
        fs.rmdirSync(item.path); emit({ kind: "cleanup", path: item.path, removed: true });
      } catch (error) { cleanupComplete = false; emit({ kind: "cleanup", path: item.path, removed: false, error: errorView(error) }); }
    }
    emit({ kind: "summary", complete, cleanupComplete, queryCount: records.length, qualification: false, originalNativeResultUnchanged: true });
    if (!complete || !cleanupComplete) process.exitCode = 1;
  }
}
try { main(); }
catch (error) { emit({ kind: "diagnostic-failed", qualification: false, error: errorView(error) }); process.exitCode = 1; }
