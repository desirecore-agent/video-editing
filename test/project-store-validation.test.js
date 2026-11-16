"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Store = require("../project-store"), { seedProject } = require("./helpers");
test("incomplete, malformed and dangling replacements leave the old project bytes intact", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-admission-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "project.json"), original = seedProject({ projectId: "p_fixture" });
  fs.writeFileSync(file, JSON.stringify(original));
  const bytes = fs.readFileSync(file);
  const changes = [d => delete d.name, d => delete d.media, d => delete d.clips,
    d => d.clips = {}, d => d.width = 0, d => d.height = 0.5, d => d.fps = Infinity,
    d => d.clips.push(structuredClone(d.clips[0])), d => d.media[0] = null,
    d => d.clips[0].duration = -1, d => d.clips[0].mediaId = "missing", d => d.clips[0].props = []];
  for (const change of changes) {
    const doc = { ...structuredClone(original), revision: 2 }; change(doc);
    assert.throws(() => Store.commit(file, doc, 1, { projectId: "p_fixture" }));
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  const valid = { ...original, revision: 2, clips: [], customMetadata: { preserved: true } };
  assert.equal(Store.commit(file, valid, 1, { mutationId: "fixture-mutation" }).revision, 2);
  assert.equal(Store.commit(file, valid, 1, { mutationId: "fixture-mutation" }).replayed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).customMetadata, { preserved: true });
});
