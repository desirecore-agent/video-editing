/* Real private server/TCP/HTTP/lease integration with unit-only synchronous
   export-factory delay/failure and signal delivery. No native GUI evidence. */
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), net = require("node:net"), http = require("node:http");
const { once } = require("node:events");
const { startServer, seedProject } = require("./helpers");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(file) {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file) && Date.now() < deadline) await pause(10);
  assert.equal(fs.existsSync(file), true, "actual startup marker must appear: " + file);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function setup(t, kind) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-editing-startup-"))), gate = path.join(dir, "startup-unit");
  fs.mkdirSync(gate); fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(seedProject()));
  const preload = ["export-api-unit.cjs", "export-startup-unit.cjs"].map(name => path.join(__dirname, "fixtures", name));
  const boot = startServer({ after() {} }, dir, { FABLECUT_NO_FS_WATCH: "1", NODE_OPTIONS: preload.map(file => '--require "' + file + '"').join(" "),
    FABLECUT_EXPORT_UNIT_GATE: path.join(dir, "native-stubs"), FABLECUT_EXPORT_UNIT_KIND: "no-gate",
    FABLECUT_STARTUP_UNIT_GATE: gate, FABLECUT_STARTUP_UNIT_KIND: kind });
  boot.catch(() => {});
  t.after(async () => {
    try {
      fs.writeFileSync(path.join(gate, "release"), "unit release");
      const service = await boot.catch(() => null); if (service) await service.stop();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  return { dir, gate, boot };
}
async function identitySocket(t, port, endpoint = "/api/desirecore/instance") {
  const socket = net.createConnection({ host: "127.0.0.1", port }); t.after(() => socket.destroy());
  const timer = setTimeout(() => socket.destroy(Error("TCP did not connect while factory was waiting")), 1500);
  try { await once(socket, "connect"); } finally { clearTimeout(timer); }
  socket.destroy();
  let received = 0, request;
  const response = new Promise((resolve, reject) => {
    request = http.get({ hostname: "127.0.0.1", port, path: endpoint, agent: false }, res => {
      received++; const chunks = [];
      res.on("data", bytes => { received += bytes.length; chunks.push(bytes); });
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
  });
  response.catch(() => {}); t.after(() => request.destroy());
  return { response, bytes: () => received };
}
async function portIsClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); reject(Error("startup port is still open")); });
    socket.once("error", error => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
}
test("TCP is bound during synchronous export initialization but identity waits for completion beyond three seconds", async t => {
  const { gate, boot } = setup(t, "gate"), entered = await until(path.join(gate, "factory-started.json"));
  const pending = await identitySocket(t, entered.port);
  const runtimeIdentity = await identitySocket(t, entered.port, "/api/desirecore/runtime-identity");
  assert.equal(fs.existsSync(path.join(gate, "factory-complete")), false);
  await pause(3100);
  assert.equal(pending.bytes(), 0, "no early identity or business HTTP response may escape initialization");
  assert.equal(runtimeIdentity.bytes(), 0, "the exact runtime identity route must also wait for initialization");
  assert.equal(fs.existsSync(path.join(gate, "factory-complete")), false);
  assert.ok(Date.now() - entered.at >= 3000);
  fs.writeFileSync(path.join(gate, "release"), "unit release");
  const service = await boot, reply = await pending.response;
  assert.equal(reply.status, 200); assert.equal(fs.existsSync(path.join(gate, "factory-complete")), true);
  const owner = JSON.parse(reply.body); assert.equal(owner.pid, service.child.pid); assert.equal(owner.port, entered.port);
  assert.equal((await runtimeIdentity.response).status, 404, "this standalone fixture has no platform proof; its response must still wait");
});
test("export factory initialization failure exits nonzero and closes its port and original lease", async t => {
  const { dir, gate, boot } = setup(t, "throw"), entered = await until(path.join(gate, "factory-started.json"));
  await assert.rejects(boot, error => /exit=1/.test(error.message) && /Video Editing export initialization failed/.test(error.message) && /unit export factory initialization failure/.test(error.message));
  assert.equal(fs.existsSync(path.join(dir, ".fablecut-service.lockdir")), false);
  await portIsClosed(entered.port);
});
test("shutdown signal handler before export initialization does not dereference a missing factory", async t => {
  const { dir, gate, boot } = setup(t, "signal-before-init"), bound = await until(path.join(gate, "bound-before-signal.json"));
  await assert.rejects(boot, error => /exit=0/.test(error.message) && !/ReferenceError|TypeError/.test(error.message));
  assert.equal(fs.existsSync(path.join(gate, "factory-started.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".fablecut-service.lockdir")), false);
  await portIsClosed(bound.port);
});
