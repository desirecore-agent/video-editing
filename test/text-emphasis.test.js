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

test("source matches survive wrapping, expanded spaces, Unicode and fragment slices without rematching", () => {
  const color = "#abcdef", source = "😀 hot water hot\n白开水和白开";
  const lines = ["😀  hot", "water hot", "白开水和白开"];
  const mapped = Emphasis.forLines(source, [{ text: "hot water", color }, { text: "白开水", color }], lines);
  const selected = (text, ranges) => ranges.map(r => text.slice(r.start, r.end)).join("").replace(/\s/g, "");
  assert.deepEqual(lines.map((line, i) => selected(line, mapped[i])), ["hot", "water", "白开水"]);
  assert.equal(selected("白开", Emphasis.slice(mapped[2], 0, 2)), "白开");
  assert.deepEqual(Emphasis.slice(mapped[1], 6, 9), [], "the later, unselected 'hot' must stay uncoloured");
  assert.equal(selected("SS WATER", Emphasis.forLines("SS WATER", [{ text: "ß water", color }], ["SS WATER"], true)[0]), "SSWATER");
});

// Exercise the production compositor without a browser or media export. A
// fixed-width recording Canvas observes which visible characters receive the
// selected fill, including the clip used to recolour an intact shaped run.
function compositor() {
  const fs = require("node:fs"), path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const start = source.indexOf("function lineDirections("), end = source.indexOf("/* ═══════════════════════════ FONTS", start);
  const pathStart = source.indexOf("function drawTextOnPath("), pathEnd = source.indexOf("function textPathSectionHtml(", pathStart);
  assert.ok(start >= 0 && end > start && pathStart >= 0 && pathEnd > pathStart);
  const animations = JSON.parse(source.match(/const TEXT_ANIMS = (\[[\s\S]*?\]);/)[1]);
  const state = { fillStyle: "", direction: "ltr", globalAlpha: 1, clip: null }, stack = [], selected = [];
  let rect;
  const ctx = new Proxy(state, { get(target, key) {
    if (key === "measureText") return text => ({ width: text.length * 10 });
    if (key === "save") return () => stack.push({ ...target });
    if (key === "restore") return () => Object.assign(target, stack.pop());
    if (key === "beginPath") return () => { rect = null; };
    if (key === "rect") return (x, y, w) => { rect = [x, x + w]; };
    if (key === "clip") return () => { if (rect) target.clip = rect; };
    if (key === "fillText") return (text, x) => {
      if (target.fillStyle !== "#abcdef" || target.globalAlpha <= 0) return;
      for (let i = 0; i < text.length; i++) {
        const centre = x - text.length * 5 + i * 10 + 5;
        if (!target.clip || centre >= target.clip[0] && centre < target.clip[1]) selected.push(text[i]);
      }
    };
    return key in target ? target[key] : () => {};
  } });
  const env = { TextEmphasis: Emphasis, ctx2d: ctx, project: { width: 1280 }, TEXT_ANIMS: animations, FONT_CUT_DEFAULT: ["Arial"],
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)), EASE: { "ease-out": x => x }, ensureFont() {},
    detectTextDirection: () => "ltr", clipTextPath: () => true, textPathAt: () => ({}),
    Motion: { itemMatrix: () => [1, 0, 0, 1, 0, 0], outline: () => ({}),
      pathSampler: () => ({ length: 1000, at: x => ({ x, y: 0, angle: 0 }) }) } };
  const draw = new Function(...Object.keys(env), source.slice(start, end) + source.slice(pathStart, pathEnd) + ";return drawText;")(...Object.values(env));
  return { animations, draw(text, keyword, animation, extra = {}, time = 4) {
    selected.length = 0; state.clip = null;
    draw({ start: 0, duration: 5 }, { text, textAnim: animation, fontSize: 10, color: "#ffffff", textShadow: 0,
      highlightColor: "#ff0000", direction: "ltr", emphasis: [{ text: keyword, color: "#abcdef" }], ...extra }, time);
    return selected.join("").replace(/\s/g, "");
  } };
}

test("the shared compositor retains only source-selected colours across every text animation and wrapping", () => {
  const c = compositor();
  for (const animation of c.animations) {
    assert.equal(c.draw("头白开水尾白开", "白开水", animation), "白开水", animation + " Chinese");
    assert.equal(c.draw("hot water and hot", "hot water", animation), "hotwater", animation + " phrase");
    assert.equal(c.draw("x hot water y", "hot water", animation, { boxW: 70, boxH: 100 }), "hotwater", animation + " wrapped");
  }
  for (const time of [0.16, 0.35, 4])
    assert.equal(c.draw("hot water tail", "hot water", "highlight", {}, time), "hotwater", "static colour wins over changing current-word highlight");
  assert.equal(c.draw("白开水尾", "白开水", "typewriter", {}, 0.08), "白开", "revealed fragments retain the full keyword's colour");
  assert.equal(c.draw("hot water and hot", "hot water", "wave", { align: "justify", boxW: 240, boxH: 100 }), "hotwater");
  assert.equal(c.draw("头白开水尾白开", "白开水", "wave", { textPath: true }), "白开水", "path glyphs share source offsets");
  assert.equal(c.draw("hot\nwater and hot", "hot\nwater", "letter-pop", { textPath: true }), "hotwater", "path lines retain a literal cross-line rule");
});
