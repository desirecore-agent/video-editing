"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const createLocale = require("../ui-language.js");
const copy = require("../ui-copy.zh-CN.js");

function harness({ browser = "en-US", host, query = "" } = {}) {
  const button = { nodeValue: "⬇ Export", isConnected: true };
  const captured = [button][Symbol.iterator]();
  const win = new EventTarget();
  Object.assign(win, {
    location: { href: "https://editor.invalid/" + query },
    navigator: { language: browser },
    DesireCoreTheme: { hostLocale: () => host },
    CustomEvent,
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      documentElement: {},
      createTreeWalker: () => ({ nextNode: () => captured.next().value }),
      querySelectorAll: () => [],
    },
  });
  const language = createLocale(win, copy);
  const switchHost = (locale) =>
    win.dispatchEvent(new CustomEvent("desirecore:localechange", { detail: locale }));
  return { win, language, button, switchHost };
}

test("DesireCore's language takes precedence over browser locale and the standalone preference", () => {
  for (const [host, other, exportLabel] of [
    ["zh-CN", "en-US", "⬇ 导出"],
    ["en-US", "zh-CN", "⬇ Export"],
  ]) {
    const { win, button } = harness({ browser: other, host, query: "?lang=" + other });
    assert.equal(win.document.documentElement.lang, host);
    assert.equal(button.nodeValue, exportLabel);
  }
});

test("a language event updates authored and bound copy while preserving user text", () => {
  const { win, language, button, switchHost } = harness({ host: "zh-CN" });
  const title = { isConnected: true, textContent: "" };
  const input = { isConnected: true, value: "Export" };
  language.bind(title, "{name}  ·  🟢 connected", { name: input.value });
  assert.equal(title.textContent, "Export  ·  🟢 已连接");
  switchHost("en-US");
  assert.equal(win.document.documentElement.lang, "en-US");
  assert.equal(title.textContent, "Export  ·  🟢 connected");
  assert.equal(input.value, "Export");
  assert.equal(button.nodeValue, "⬇ Export");
  switchHost("invalid");
  assert.equal(win.document.documentElement.lang, "en-US");
  switchHost("zh-CN");
  assert.equal(button.nodeValue, "⬇ 导出");
});

test("standalone defaults to Simplified Chinese with an explicit English option", () => {
  assert.equal(harness().button.nodeValue, "⬇ 导出");
  assert.equal(harness({ query: "?lang=en-US" }).button.nodeValue, "⬇ Export");
});
