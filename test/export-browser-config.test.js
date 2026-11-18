/* Unit ownership/configuration check; this does not simulate native pixels. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const file = path.join(__dirname, "..", "export-jobs.js");
const nativeRequire = createRequire(file);

for (const platform of ["win32", "darwin", "linux"]) {
  test(`owned ${platform} browser keeps GPU effects and uses the supported video decoder`, t => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-browser-config-"));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    let launched;
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
      module, exports: module.exports,
      require(name) {
        if (name === "./browser-process") return {
          createBrowserProcess(exe, args, options) {
            launched = { exe, args, options };
            return { proc: new EventEmitter(), close() {} };
          },
        };
        return nativeRequire(name);
      },
      process: { platform, env: { FABLECUT_CHROME: __filename } },
      setInterval, clearInterval, setTimeout, clearTimeout, Buffer,
    }, { filename: file });
    const jobs = module.exports.createExportJobs({
      url: id => `http://127.0.0.1:1234/?exportJob=${id}`,
      editors: () => 0, broadcast() {}, keepProfile: () => profile,
    });
    t.after(() => jobs.shutdown());
    const job = jobs.request({ kind: "scopes", where: "headless", time: 20 });
    assert.equal(job.via, "headless");
    assert.ok(launched.args.includes("--enable-gpu"), "segmentation still has GPU/WebGL");
    assert.equal(launched.args.includes("--disable-accelerated-video-decode"), platform === "win32",
      "Windows decoding avoids the reproduced GPU context loss without changing other platforms");
    assert.ok(launched.args.includes("--window-size=800,600"));
    assert.ok(!launched.args.includes("--disable-gpu"));
    assert.ok(!launched.args.includes("--no-sandbox"));
    assert.ok(launched.args.includes(`http://127.0.0.1:1234/?exportJob=${job.id}`));
  });
}
