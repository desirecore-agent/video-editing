"use strict";
const fs = require("node:fs"), path = require("node:path");
const { createBrowserProcess } = require("../../browser-process");
const directory = process.argv[2];
// Safe when discovered as a file by CI's bare node --test invocation.
if (directory) {
const profileDir = path.join(directory, "profile");
fs.mkdirSync(profileDir);
const browser = createBrowserProcess(process.execPath,
  [path.join(__dirname, "browser-lifecycle-child.cjs"), directory, "ordinary"], { profileDir });
browser.proc.on("error", error => { process.stderr.write(error.stack); process.exitCode = 1; });
process.on("message", () => browser.close());
}
