"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { setImmediate: tick } = require("node:timers/promises");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const start = app.indexOf("function createExportUploader(");
const end = app.indexOf("/* ── Fast / WebCodecs frame sync", start);
assert(start > 0 && end > start);
const create = new Function("fetch", "renderCancelled", app.slice(start, end) + ";return createExportUploader;");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function uploader(fetcher) {
  let error;
  const up = create(fetcher, false)("owned-test", { batchItems: 1, batchBytes: 1,
    getError: () => error, setError: value => { error ||= value; } });
  return { up, error: () => error };
}
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port;
}

test("ordered frame uploads wait for the real response body and preserve bytes", async t => {
  const gate = deferred(), headers = deferred(), received = [];
  t.after(() => gate.resolve());
  const base = await listen(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks));
    res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"ok":');
    if (received.length === 1) await gate.promise;
    res.end("true}");
  });
  const { up, error } = uploader(async (url, opts) => {
    const response = await fetch(base + url, opts); headers.resolve(); return response;
  });
  const first = Uint8Array.of(1, 2, 3, 4), second = Uint8Array.of(5, 6, 7, 8);
  up.push(first); up.push(second); const completed = up.done();
  await headers.promise; await tick(); await tick();
  assert.equal(up.inFlight(), 2, "response headers alone do not release this upload or admit the next one");
  assert.equal(received.length, 1);
  gate.resolve(); await completed;
  assert.equal(error(), undefined);
  assert.deepEqual(received.map(x => [...x]), [[1, 2, 3, 4], [5, 6, 7, 8]]);
  assert.equal(up.inFlight(), 0);
});

test("a rejected HTTP frame retains the original server error", async t => {
  const received = [];
  const base = await listen(t, async (req, res) => {
    for await (const chunk of req) received.push(...chunk);
    res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"error":"original encoder stopped"}');
  });
  const { up, error } = uploader((url, opts) => fetch(base + url, opts));
  const payload = Uint8Array.of(9, 10, 11); up.push(payload); await up.done();
  assert.deepEqual(received, [9, 10, 11]);
  assert.match(error().message, /original encoder stopped/);
  assert.equal(up.inFlight(), 0);
});

test("transport rejection retains the original error and settles the queue", async () => {
  const original = new Error("original transport rejection");
  const { up, error } = uploader(async () => { throw original; });
  const payload = Uint8Array.of(12, 13); up.push(payload); await up.done();
  assert.equal(error(), original); assert.equal(up.inFlight(), 0);
});

test("a subarray payload leaves its shared backing store available for another owner", async () => {
  const owner = Uint8Array.of(21, 22, 23, 24), payload = owner.subarray(1, 3), received = [];
  const { up, error } = uploader(async (_url, opts) => {
    received.push(...opts.body); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  up.push(payload); await up.done(); assert.equal(error(), undefined);
  assert.deepEqual(received, [22, 23]); assert.deepEqual([...owner], [21, 22, 23, 24]);
});
