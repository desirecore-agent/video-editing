// Unit-only synchronous factory gate/failure. No native runtime or OS-signal claim.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), Module = require("node:module");
const gate = process.env.FABLECUT_STARTUP_UNIT_GATE, kind = process.env.FABLECUT_STARTUP_UNIT_KIND;
if (gate) {
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    const mod = load.call(this, request, parent, ...rest);
    if (request !== "./export-jobs" || !parent?.filename.endsWith("server.js")) return mod;
    return { ...mod, createExportJobs: options => {
      fs.writeFileSync(path.join(gate, "factory-started.json"), JSON.stringify({ pid: process.pid, port: Number(process.env.PORT), at: Date.now() }), { flag: "wx" });
      if (kind === "throw") throw Error("unit export factory initialization failure");
      if (kind === "gate") {
        const deadline = Date.now() + 12000, cell = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(path.join(gate, "release"))) {
          if (Date.now() > deadline) throw Error("unit synchronous startup gate expired");
          Atomics.wait(cell, 0, 0, 10);
        }
      }
      const jobs = mod.createExportJobs(options);
      fs.writeFileSync(path.join(gate, "factory-complete"), "unit", { flag: "wx" });
      return jobs;
    } };
  };
  if (kind === "signal-before-init") {
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      args[args.length - 1] = () => {
        fs.writeFileSync(path.join(gate, "bound-before-signal.json"), JSON.stringify({ pid: process.pid, port: Number(process.env.PORT) }), { flag: "wx" });
        // Deliver the real registered shutdown handler synchronously. This unit
        // event is deliberately not described as native OS signal validation.
        process.emit("SIGTERM");
      };
      return listen.apply(this, args);
    };
  }
}
