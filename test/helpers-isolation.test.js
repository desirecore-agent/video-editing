"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDataDir, seedProject, readProject, startServer, startMcp, startManagedMcp } = require("./helpers");

// These are newly created sentinels, never a real application home. Include
// the directory tree as well as bytes: seeding a library or lease is a write.
function snapshot(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => [
    entry.name,
    entry.isDirectory() ? snapshot(path.join(root, entry.name)) : fs.readFileSync(path.join(root, entry.name)).toString("base64"),
  ]);
}

async function pollutedParent(roots, run) {
  const keys = ["APP_DATA_DIR", "APP_DATA_ROOT"];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) {
    if (roots[key] === undefined) delete process.env[key];
    else process.env[key] = roots[key];
  }
  try { await run(); }
  finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
}

test("startServer and raw startMcp keep their private root under polluted parent and per-call roots", { timeout: 20_000 }, async (t) => {
  const foreignDir = makeDataDir(t, seedProject({ name: "APP_DATA_DIR sentinel" }));
  const foreignRoot = makeDataDir(t, seedProject({ name: "APP_DATA_ROOT sentinel" }));
  const beforeDir = snapshot(foreignDir), beforeRoot = snapshot(foreignRoot);
  const dir = makeDataDir(t, seedProject({ name: "Private standalone project" }));
  const roots = { APP_DATA_DIR: foreignDir, APP_DATA_ROOT: foreignRoot, FABLECUT_DATA_DIR: foreignDir };
  await pollutedParent(roots, async () => {
    const service = await startServer(t, dir, { ...roots, FABLECUT_NO_FS_WATCH: "1" });
    const owner = await (await fetch(service.base + "/api/desirecore/instance")).json();
    assert.equal(owner.dataDir, fs.realpathSync(dir));
    assert.equal(owner.port, service.port);
    assert.equal(owner.pid, service.child.pid);
    const mcp = startMcp(t, dir, { ...roots, PORT: String(service.port), FABLECUT_NO_AUTOSTART: "1" });
    await mcp.request("initialize", { protocolVersion: "2025-11-25" });
    const loaded = await mcp.callTool("fablecut_get_project");
    assert.equal(loaded.isError, false, loaded.text);
    assert.deepEqual(JSON.parse(loaded.text), readProject(dir));
    assert.equal(JSON.parse(loaded.text).name, "Private standalone project", "MCP must not read either sentinel");
    const patched = await mcp.callTool("fablecut_patch_project", { ops: [{ op: "setProject", set: { name: "Private standalone edit" } }] });
    assert.equal(patched.isError, false, patched.text);
    assert.equal(readProject(dir).name, "Private standalone edit");
  });
  assert.deepEqual(snapshot(foreignDir), beforeDir, "the parent's APP_DATA_DIR tree stays byte-identical");
  assert.deepEqual(snapshot(foreignRoot), beforeRoot, "the parent's APP_DATA_ROOT tree stays byte-identical");
});

test("startManagedMcp binds its own actual owner under a polluted parent APP_DATA_ROOT", { timeout: 20_000 }, async (t) => {
  const foreignRoot = makeDataDir(t, seedProject({ name: "Inherited fallback sentinel" }));
  const before = snapshot(foreignRoot);
  const dir = makeDataDir(t, seedProject({ name: "Private managed project" }));
  await pollutedParent({ APP_DATA_ROOT: foreignRoot }, async () => {
    const mcp = await startManagedMcp(t, dir);
    await mcp.request("initialize", { protocolVersion: "2025-11-25" });
    const owner = JSON.parse(fs.readFileSync(path.join(dir, ".fablecut-service.lockdir", "owner.json"), "utf8"));
    assert.equal(owner.dataDir, fs.realpathSync(dir));
    assert.equal(owner.managed, true);
    const actual = await (await fetch(`http://127.0.0.1:${owner.port}/api/desirecore/instance`)).json();
    assert.deepEqual(actual, owner, "the private lease is the live service identity");
    const loaded = await mcp.callTool("fablecut_get_project");
    assert.equal(loaded.isError, false, loaded.text);
    assert.deepEqual(JSON.parse(loaded.text), readProject(dir));
    assert.equal(JSON.parse(loaded.text).name, "Private managed project", "MCP must not read the sentinel");
    const patched = await mcp.callTool("fablecut_patch_project", { ops: [{ op: "setProject", set: { name: "Private managed edit" } }] });
    assert.equal(patched.isError, false, patched.text);
    assert.equal(readProject(dir).name, "Private managed edit");
  });
  assert.deepEqual(snapshot(foreignRoot), before, "the inherited root stays byte-identical");
});
