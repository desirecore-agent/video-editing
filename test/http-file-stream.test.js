const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { streamFileResponse } = require("../http-file-stream");

async function fixture(t, handler) {
  const parent = await fsp.realpath(os.tmpdir());
  const directory = await fsp.mkdtemp(path.join(parent, "video-editing-file-stream-"));
  const real = await fsp.realpath(directory);
  assert.equal(path.dirname(real), parent);
  const small = path.join(real, "small.bin"), large = path.join(real, "large.bin");
  const bytes = Buffer.from("A real file response, including a selected byte range.");
  await fsp.writeFile(small, bytes);
  const handle = await fsp.open(large, "wx");
  await handle.truncate(16 * 1024 * 1024);
  await handle.close();
  const readers = [];
  const server = http.createServer((req, res) => handler({ req, res, small, large, bytes, readers }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const reader of readers) reader?.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(await fsp.realpath(real)), parent);
    await fsp.rm(real, { recursive: true });
  });
  return { url: "http://127.0.0.1:" + server.address().port, readers, bytes };
}

function closed(reader) {
  if (reader.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("file remained open after HTTP response closed")), 1500);
    reader.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

test("complete and byte-range responses preserve bytes and close their files", async t => {
  const f = await fixture(t, ({ req, res, small, bytes, readers }) => {
    const range = req.url === "/range";
    res.writeHead(range ? 206 : 200, { "Content-Length": range ? 9 : bytes.length });
    readers.push(streamFileResponse(res, small, range ? { start: 7, end: 15 } : undefined));
  });
  assert.deepEqual(Buffer.from(await (await fetch(f.url + "/full")).arrayBuffer()), f.bytes);
  const range = await fetch(f.url + "/range");
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), f.bytes.subarray(7, 16));
  for (const reader of f.readers) { await closed(reader); assert.equal(reader.fd, null); }
});

test("repeated cancelled video ranges release each reader instead of accumulating descriptors", async t => {
  const f = await fixture(t, ({ res, large, readers }) => {
    res.writeHead(206, { "Content-Length": 16 * 1024 * 1024 });
    readers.push(streamFileResponse(res, large, { start: 0, end: 16 * 1024 * 1024 - 1 }));
  });
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve, reject) => {
      const request = http.get(f.url + "/video", response => {
        response.once("data", () => { response.destroy(); request.destroy(); resolve(); });
        response.on("error", () => {});
      });
      request.on("error", reject);
    });
    const reader = f.readers[i];
    await closed(reader);
    assert.equal(reader.destroyed, true);
    assert.equal(reader.fd, null);
  }
  assert.equal(f.readers.length, 12);
});

test("an asynchronous EMFILE open error fails only that transfer and later requests still work", async t => {
  const f = await fixture(t, ({ req, res, small, bytes, readers }) => {
    res.writeHead(200, { "Content-Length": bytes.length });
    const options = req.url === "/fail" ? { fs: {
      open(_file, _flags, _mode, callback) {
        queueMicrotask(() => callback(Object.assign(new Error("fixture open failure"), { code: "EMFILE" })));
      }, read: fs.read, close: fs.close,
    } } : undefined;
    readers.push(streamFileResponse(res, small, options));
  });
  await assert.rejects(fetch(f.url + "/fail"));
  assert.deepEqual(Buffer.from(await (await fetch(f.url + "/healthy")).arrayBuffer()), f.bytes);
  for (const reader of f.readers) await closed(reader);
});

test("a response already closed before piping cannot retain a newly opened file", async t => {
  const f = await fixture(t, ({ res, large, readers }) => {
    res.destroy();
    readers.push(streamFileResponse(res, large));
  });
  await assert.rejects(fetch(f.url));
  assert.equal(f.readers[0], null);
});
