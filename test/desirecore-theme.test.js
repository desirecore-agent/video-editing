"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { HOST_PROPERTIES, PALETTE_PROPERTIES, parseAppearance, install } = require("../desirecore-theme.js");

const makeAppearance = (colorScheme = "dark", color = "rgb(248, 248, 252)") => ({
  schemaVersion: 1, colorScheme,
  tokens: Object.fromEntries(Object.entries(HOST_PROPERTIES).map(([name, prop]) => [name,
    prop === "color" ? color : prop === "font-family" ? "system-ui, sans-serif" : prop === "border-radius" ? "7px" : "0 1px 2px rgba(0, 0, 0, .2)"])),
});
function harness({ dark = false, bridge, topLevel = true } = {}) {
  const values = new Map(), listeners = new Map(), events = [], log = [], probes = [];
  const style = { setProperty: (k, v) => values.set(k, v), removeProperty: (k) => values.delete(k) };
  const target = { dataset: {}, style, appendChild: (el) => probes.push(el) };
  const media = { matches: dark, addEventListener: (_, fn) => { media.listener = fn; }, removeEventListener: () => { media.listener = null; } };
  const meta = {};
  const win = {
    document: { documentElement: target, querySelector: () => meta,
      createElement: () => ({ style: {}, setAttribute() {}, remove() {} }) },
    matchMedia: (query) => { assert.equal(query, "(prefers-color-scheme: dark)"); return media; },
    CSS: { supports: () => true },
    getComputedStyle(el) {
      return { color: values.get("--host-sys-label") || (target.dataset.theme === "dark" ? "rgb(248, 248, 252)" : "rgb(29, 29, 31)"),
        getPropertyValue: (name) => name === "--ui-font-mono" ? "Consolas, monospace" : "" };
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    dispatchEvent: (event) => events.push(event),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    desirecoreApp: bridge,
  };
  win.top = topLevel ? win : {};
  return { win, target, values, media, events, listeners, log, probes, meta };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("appearance v1 is closed and validates every value using the correct CSS property", () => {
  const seen = [];
  assert.equal(Object.keys(HOST_PROPERTIES).length, 43);
  const value = makeAppearance();
  assert.deepEqual(parseAppearance(value, (p, v) => { seen.push([p, v]); return true; }), value);
  assert.equal(seen.length, 43);
  assert.ok(seen.some(([p]) => p === "font-family"));
  assert.ok(seen.some(([p]) => p === "box-shadow"));
  assert.equal(parseAppearance(value, () => false), null);
});

test("malformed snapshots and CSS references/resources are rejected atomically", () => {
  for (const raw of ["", "#fff; color:red", "url(https://example.test/a)", "var(--secret)", "env(color)", "expression(1)", "inherit", "unset", "revert-layer", "red\nblue", "#fff{}", "red\\blue", "x".repeat(1025)]) {
    const value = makeAppearance(); value.tokens["--sys-label"] = raw;
    assert.equal(parseAppearance(value, () => true), null, raw);
  }
  const cases = [null, [], { ...makeAppearance(), schemaVersion: 2 }, { ...makeAppearance(), colorScheme: "system" }, { ...makeAppearance(), extra: true }];
  const missing = makeAppearance(); delete missing.tokens["--sys-label"]; cases.push(missing);
  const extra = makeAppearance(); extra.tokens["--credential"] = "red"; cases.push(extra);
  for (const value of cases) assert.equal(parseAppearance(value, () => true), null);
});

test("standalone preview follows live system appearance without persistent preferences", () => {
  const h = harness(); const api = install(h.win);
  assert.equal(api.snapshot().theme, "light");
  assert.equal(api.snapshot().source, "system");
  assert.ok(Object.isFrozen(api.snapshot().palette));
  assert.deepEqual(Object.keys(api.snapshot().palette), [...Object.keys(PALETTE_PROPERTIES), "fontMono"]);
  h.media.matches = true; h.media.listener();
  assert.equal(api.snapshot().theme, "dark");
  assert.equal(h.events.at(-1).type, "desirecore:themechange");
  assert.equal(h.events.at(-1).detail, api.snapshot());
  assert.equal(install(h.win), api);
  assert.equal(h.listeners.has("message"), false);
});

test("new host events win over old connect replies, and same-scheme token changes invalidate Canvas palette", async () => {
  let listener, resolveConnect;
  const order = [];
  const h = harness({ bridge: {
    onEvent(fn) { order.push("subscribe"); listener = fn; return () => order.push("unsubscribe"); },
    call(method) { assert.equal(method, "connect"); order.push(method); return new Promise((resolve) => { resolveConnect = resolve; }); },
  } });
  const api = install(h.win); await flush();
  assert.deepEqual(order, ["subscribe", "connect"]);
  listener({ type: "appearance-changed", appearance: makeAppearance("light", "rgb(1, 2, 3)") });
  const first = api.snapshot();
  resolveConnect({ appearance: makeAppearance("dark") }); await flush();
  assert.equal(api.snapshot(), first);
  assert.equal(api.snapshot().theme, "light");
  assert.equal(api.snapshot().source, "host");
  listener({ type: "appearance-changed", appearance: makeAppearance("light", "rgb(4, 5, 6)") });
  assert.ok(api.snapshot().revision > first.revision);
  assert.notDeepEqual(api.snapshot().palette, first.palette);
  const current = api.snapshot();
  listener({ type: "appearance-changed", appearance: { ...makeAppearance(), tokens: {} } });
  assert.equal(api.snapshot(), current);
  h.media.matches = true; h.media.listener();
  assert.equal(api.snapshot(), current);
});

test("rejected connect and a subframe retain system fallback, with no parent DOM inspection", async () => {
  const h = harness({ dark: true, bridge: { call() { return Promise.reject(new Error("unavailable")); } } });
  const api = install(h.win); await flush(); assert.equal(api.snapshot().source, "system");
  assert.equal(api.snapshot().theme, "dark");
  let called = false;
  const sub = harness({ topLevel: false, bridge: { call() { called = true; } } });
  install(sub.win); await flush(); assert.equal(called, false);
});

test("pagehide removes host tokens and subscriptions, and rejects a late connect result", async () => {
  let listener, resolveConnect, unsubscribed = false;
  const h = harness({ bridge: {
    onEvent(fn) { listener = fn; return () => { unsubscribed = true; }; },
    call() { return new Promise((resolve) => { resolveConnect = resolve; }); },
  } });
  const api = install(h.win); await flush();
  listener({ type: "appearance-changed", appearance: makeAppearance() });
  assert.equal(h.values.size, 43);
  h.listeners.get("pagehide")();
  assert.equal(h.values.size, 0); assert.equal(unsubscribed, true);
  assert.equal(h.media.listener, null); assert.equal(api.snapshot().source, "system");
  resolveConnect({ appearance: makeAppearance() }); await flush();
  listener({ type: "appearance-changed", appearance: makeAppearance() });
  assert.equal(api.snapshot().source, "system");
});

test("theme assets load before the editor and every Canvas palette property has a declared UI token", () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
  const html = read("index.html"), css = read("desirecore-theme.css"), style = read("style.css"), js = read("desirecore-theme.js");
  assert.ok(html.indexOf('href="desirecore-theme.css"') < html.indexOf('src="desirecore-theme.js"'));
  assert.ok(html.indexOf('src="desirecore-theme.js"') < html.indexOf('src="app.js"'));
  for (const property of Object.values(PALETTE_PROPERTIES)) assert.ok(css.includes(`${property}:`), property);
  for (const name of Object.keys(HOST_PROPERTIES)) assert.equal(css.split(`--fallback-${name.slice(2)}:`).length - 1, 3, name);
  assert.match(css, /--fallback-action-primary: #397455;/); assert.match(css, /--fallback-action-primary: #93c6a5;/);
  assert.match(html, /视频剪辑 · Video Editing/);
  assert.match(style, /scroll-snap-type: x mandatory/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|conveyor|\.require\(|postMessage|parent\.document/);
  assert.doesNotMatch(style, /#preview\s*\{[^}]*filter:/);
});
