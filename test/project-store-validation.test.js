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

test("each composition and parked sequence has the same independent clip structure boundary", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-project-admission-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "project.json"), original = seedProject();
  fs.writeFileSync(file, JSON.stringify(original));
  const bytes = fs.readFileSync(file);
  for (const container of ["comp", "sequence"]) {
    for (const change of [clips => clips.push(structuredClone(clips[0])),
      clips => clips[0].duration = -1, clips => clips[0].start = Infinity,
      clips => clips[0].props = [], clips => clips[0].kind = "unknown"]) {
      const doc = { ...structuredClone(original), revision: 2 };
      const clips = [structuredClone(doc.clips[0])]; change(clips);
      if (container === "comp") doc.comps = [{ id: "nested", duration: 5, clips }];
      else { doc.sequence = "main"; doc.sequences = [{ id: "main" }, { id: "parked", clips }]; }
      assert.throws(() => Store.commit(file, doc, 1), /Invalid complete project|numeric start and duration/);
      assert.deepEqual(fs.readFileSync(file), bytes);
    }
  }
  const doc = { ...structuredClone(original), revision: 2,
    comps: [{ id: " nested ", duration: 5 }], sequence: "main",
    sequences: [{ id: "main", clips: [{ id: "discarded mirror" }] }, { id: "parked" }] };
  // Absent nested clips still normalize to []; the open entry isn't a second
  // timeline. The same clip identity may legally occur in different timelines.
  Store.commit(file, doc, 1);
  const saved = Store.read(file);
  assert.deepEqual(saved.comps[0].clips, []);
  assert.equal(saved.comps[0].id, "nested");
  assert.equal(saved.sequences[0].clips, undefined);
  assert.deepEqual(saved.sequences[1].clips, []);
  saved.revision++;
  saved.comps[0].clips = [structuredClone(saved.clips[0])];
  saved.sequences[1].clips = [structuredClone(saved.clips[0])];
  Store.commit(file, saved, 2);
  const result = Store.read(file);
  assert.equal(result.comps[0].clips[0].id, result.clips[0].id);
  assert.equal(result.sequences[1].clips[0].id, result.clips[0].id);
});
