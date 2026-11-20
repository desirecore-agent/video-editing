"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const a = source.indexOf("const compositorReadback = "), b = source.indexOf("let ctx2d = ", a);
assert(a >= 0 && b > a);
function factory(search) {
  const context = { URLSearchParams, location: { search } };
  vm.runInNewContext(source.slice(a, b) + ";globalThis.create = compositorContext;", context);
  return context.create;
}
function canvas() {
  const calls = [], context = {};
  return { calls, context, getContext(...args) { calls.push(args); return context; } };
}
test("interactive compositor preserves absent options and caller settings", () => {
  for (const search of ["", "?project=x", "?exportJob="]) {
    const create = factory(search), cv = canvas();
    assert.equal(create(cv), cv.context);
    assert.deepEqual(cv.calls[0], ["2d", undefined]);
    const options = { alpha: false, willReadFrequently: false, colorSpace: "display-p3" };
    create(cv, options);
    assert.equal(cv.calls[1][1], options, "do not turn the editor's default into an explicit readback policy");
  }
});
test("frozen export compositor requests readback on first creation without losing other options", () => {
  const create = factory("?exportJob=x_owned"), cv = canvas();
  create(cv);
  assert.deepEqual(JSON.parse(JSON.stringify(cv.calls[0])), ["2d", { willReadFrequently: true }]);
  const options = { alpha: false, willReadFrequently: false, colorSpace: "srgb" };
  create(cv, options);
  assert.deepEqual(JSON.parse(JSON.stringify(cv.calls[1])), ["2d", { alpha: false, willReadFrequently: true, colorSpace: "srgb" }]);
  assert.equal(options.willReadFrequently, false, "do not mutate shared caller options");
});
