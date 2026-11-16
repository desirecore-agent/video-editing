"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const Emphasis = require("../text-emphasis"), Store = require("../project-store");
const { makeDataDir, seedProject, readProject } = require("./helpers");
test("Chinese keywords are static literal matches, including repetitions and overlapping rules", () => {
  const rules = [{ text: "水", color: "#ff0000" }, { text: "白开水", color: "#ffd166" }];
  assert.deepEqual(Emphasis.ranges("白开水不是水，白开水。", rules), [
    { start: 0, end: 3, color: "#ffd166" }, { start: 5, end: 6, color: "#ff0000" }, { start: 7, end: 10, color: "#ffd166" }]);
  assert.deepEqual(Emphasis.ranges("A+B", [{ text: "+", color: "#ffffff" }]), [{ start: 1, end: 2, color: "#ffffff" }]);
  assert.equal(Emphasis.ranges("NEWS", [{ text: "news", color: "#abcdef" }], true)[0].color, "#abcdef");
  assert.equal(Emphasis.ranges("😀白开水", rules)[0].start, 2);
});
test("malformed emphasis cannot be saved; static colours survive a complete project round trip", t => {
  const path = require("node:path");
  const dir = makeDataDir(t, seedProject()), file = path.join(dir, "project.json");
  const doc = readProject(dir); doc.revision++;
  doc.clips.push({ id: "caption", kind: "text", track: "V2", start: 0, duration: 5,
    props: { text: "生活就像一杯白开水", textAnim: "none", emphasis: [{ text: "白开水", color: "#ffd166" }] } });
  Store.commit(file, doc, 1);
  assert.deepEqual(readProject(dir).clips[1].props.emphasis, doc.clips[1].props.emphasis);
  for (const rules of [[{ text: "", color: "#ffffff" }], [{ text: "水", color: "red" }], [{ text: "水", color: "#ffffff", script: "bad" }], {}]) {
    const next = readProject(dir); next.revision++; next.clips[1].props.emphasis = rules;
    assert.throws(() => Store.commit(file, next, 2), /emphasis/);
    assert.equal(readProject(dir).revision, 2);
  }
});
