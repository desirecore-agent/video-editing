/* A real, finite OS process fixture, not Chromium. It implements the documented
   FD3 EOF close callback and owns a real descendant that shares only the read
   endpoint. No HTTP, rendering, encoding or native acceptance is exercised. */
"use strict";
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const [directory, mode] = process.argv.slice(2);
// The upstream CI discovers every test/**/*.cjs file. Standalone discovery
// must not launch a fixture; only our explicit subprocess invocation may do so.
if (directory && mode) {
const mark = (name, value = "observed") => fs.writeFileSync(path.join(directory, name), value);
const budget = setTimeout(() => { mark(mode + "-timeout"); process.exit(2); }, 15000);

if (mode === "descendant") {
  process.stdin.resume();
  process.stdin.on("end", () => { mark("descendant-eof"); clearTimeout(budget); });
  process.send({ ready: true });
  process.disconnect();
} else if (mode === "stubborn") {
  process.on("SIGTERM", () => mark("term"));
  fs.createReadStream(null, { fd: 3 }).on("error", () => {}).resume();
  mark("ready.json", JSON.stringify({ browser: process.pid, descendant: null }));
} else if (mode === "early-exit") {
  clearTimeout(budget);
  process.exit(7);
} else {
  // Chromium uses its own browser shutdown to close renderers. This fixture
  // duplicates only the browser-side read end to its descendant, so neither
  // child can accidentally keep the owner's exclusive write end alive.
  const child = spawn(process.execPath, [__filename, directory, "descendant"], {
    stdio: [3, "ignore", "ignore", "ipc"], windowsHide: true,
  });
  let eof = false, childClosed = false;
  const finish = () => { if (eof && childClosed) clearTimeout(budget); };
  child.on("message", () => {
    mark("ready.json", JSON.stringify({ browser: process.pid, descendant: child.pid }));
  });
  child.on("close", code => { mark("descendant-close", String(code)); childClosed = true; finish(); });
  const input = fs.createReadStream(null, { fd: 3 });
  input.on("error", error => { mark("pipe-error", error.code || error.message); process.exitCode = 1; });
  input.on("end", () => { mark("browser-eof"); eof = true; finish(); });
  input.resume();
}
}
