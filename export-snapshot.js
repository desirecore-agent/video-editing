"use strict";
/* Freeze the submitted JSON and its declared local media by copying bytes,
   never hard-linking. The live UI can keep editing its ordinary project.
   Dynamic SVG/network links and OS fonts are explicitly outside this closure. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const COPY_CHUNK_BYTES = 256 * 1024;
const changed = () => Object.assign(new Error("media changed while its export snapshot was being copied; submit again deliberately"), {code:409});
const sameFile = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => a[key] === b[key]);
function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error("editor service stopped during export snapshot capture"), {code:503});
}

/* Keep memory bounded independently of the input's size. Read one opened file
   into one fixed buffer, hash the bytes actually written, and refuse a file
   replaced or modified during this copy. This is per-file capture, not a
   transaction across all project files. */
async function copyMedia(source, target, signal) {
  checkAbort(signal);
  const input = await fs.promises.open(source, "r");
  let output;
  try {
    const before = await input.stat({bigint:true});
    if (!before.isFile()) throw new Error("snapshot media must be a regular file");
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Object.assign(new Error("snapshot media size is not supported"), {code:400});
    output = await fs.promises.open(target, "wx");
    const size = Number(before.size), buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    const hash = crypto.createHash("sha256");
    let copied = 0;
    while (copied < size) {
      checkAbort(signal);
      const {bytesRead} = await input.read(buffer, 0, Math.min(buffer.length, size - copied), null);
      checkAbort(signal);
      if (!bytesRead) throw changed();
      let written = 0;
      while (written < bytesRead) {
        const {bytesWritten} = await output.write(buffer, written, bytesRead - written, null);
        if (!bytesWritten) throw new Error("could not write export snapshot media");
        written += bytesWritten;
      }
      hash.update(buffer.subarray(0, bytesRead));
      copied += bytesRead;
    }
    const after = await input.stat({bigint:true});
    let current;
    try { current = await fs.promises.stat(source, {bigint:true}); } catch { throw changed(); }
    if (!sameFile(before, after) || !sameFile(before, current)) throw changed();
    checkAbort(signal);
    await output.sync();
    return {bytes:copied, sha256:hash.digest("hex")};
  } finally {
    try { await output?.close(); } finally { await input.close(); }
  }
}

async function discard(dataDir, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid export snapshot id");
  await fs.promises.rm(path.join(dataDir, "exports", "snapshots", id), {recursive:true, force:true});
}

async function capture(dataDir, doc, {signal} = {}) {
  checkAbort(signal);
  const id = crypto.randomUUID(), dir = path.join(dataDir, "exports", "snapshots", id);
  // Capture JSON before the first await; a caller's later edits cannot change
  // the document, metadata or digest that belongs to this admission attempt.
  const submitted = structuredClone(doc), originalBytes = Buffer.from(JSON.stringify(submitted));
  await fs.promises.mkdir(dir, {recursive:true});
  try {
    const frozen = structuredClone(submitted), files = [];
    for (const media of frozen.media || []) {
      if (!/^\/(media|library)\//.test(media.src || "")) throw Error("snapshot requires declared local media: " + media.id);
      const relative = decodeURIComponent(media.src.slice(1));
      const file = path.resolve(dataDir, relative);
      if (!file.startsWith(path.resolve(dataDir)+path.sep)) throw Error("snapshot source escapes application data");
      const name = files.length + path.extname(file);
      const copied = await copyMedia(file, path.join(dir, name), signal);
      files.push({source:media.src, file:name, ...copied});
      media.src = `/api/export/snapshot/${id}/${name}`;
    }
    const receipt = {schemaVersion:1, id, projectRevision:submitted.revision, projectName:submitted.name,
      projectSha256:sha(originalBytes), projectId:submitted.projectId || null, files,
      consistency:"project identity/revision checked at admission; media copied per-file, not a global filesystem transaction",
      closure:"declared local media; dynamic SVG/network dependencies and OS/library fonts are not frozen"};
    checkAbort(signal);
    await fs.promises.writeFile(path.join(dir,"project.json"), JSON.stringify(frozen), {flag:"wx"});
    await fs.promises.writeFile(path.join(dir,"receipt.json"), JSON.stringify(receipt,null,2), {flag:"wx"});
    return {id, projectUrl:`/api/export/snapshot/${id}/project.json`, receipt};
  } catch(e) { await discard(dataDir, id); throw e; }
}
function resolveFile(dataDir, urlPath) {
  const match = /^\/api\/export\/snapshot\/([a-f0-9-]{36})\/(project\.json|receipt\.json|\d+\.[a-zA-Z0-9]+)$/.exec(urlPath);
  return match ? path.join(dataDir,"exports","snapshots",match[1],match[2]) : null;
}
module.exports = {capture, discard, resolveFile};
