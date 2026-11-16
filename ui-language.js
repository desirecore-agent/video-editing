/* Localize editor-owned copy. Media names, project text and export data do not
   participate in this mapping. The host's selected language wins. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.VideoEditorLocale = factory(root, root.VideoEditorChineseCopy);
})(globalThis, function (win, chineseCopy) {
  "use strict";
  const doc = win.document;
  const valid = (locale) => locale === "zh-CN" || locale === "en-US";
  const requested = new URL(win.location.href).searchParams.get("lang");
  const authored = win.DesireCoreTheme?.hostLocale?.();
  let locale = valid(authored) ? authored : valid(requested) ? requested : "zh-CN";
  const staticCopy = [];
  const boundLabels = new Map();

  function text(source, values = {}) {
    const localized = locale === "zh-CN" && Object.hasOwn(chineseCopy, source) ? chineseCopy[source] : source;
    return localized.replace(/\{([\w]+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
  }

  function bind(node, source, values, attribute) {
    if (!node) return;
    let labels = boundLabels.get(node);
    if (!labels) {
      labels = new Map();
      boundLabels.set(node, labels);
    }
    labels.set(attribute, { source, values });
    write(node, text(source, values), attribute);
  }

  function write(node, value, attribute) {
    if (attribute) node.setAttribute(attribute, value);
    else node.textContent = value;
  }

  function remember(node, source, attribute) {
    const key = source.trim().replace(/\s+/g, " ");
    if (!Object.hasOwn(chineseCopy, key)) return;
    staticCopy.push({ node, source, key, attribute, applied: source });
  }

  // This script runs before the editor renders user data. Only the authored
  // page is captured, and later strings assigned by the editor are respected.
  const walker = doc.createTreeWalker(doc.documentElement, win.NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("script, style, textarea")) remember(node, node.nodeValue);
  }
  for (const element of doc.querySelectorAll("[title],[aria-label],[placeholder],[alt]")) {
    for (const attribute of ["title", "aria-label", "placeholder", "alt"]) {
      if (element.hasAttribute(attribute)) remember(element, element.getAttribute(attribute), attribute);
    }
  }

  function renderLanguage() {
    doc.documentElement.lang = locale;
    for (const label of staticCopy) {
      const { node, source, key, attribute } = label;
      const current = attribute ? node.getAttribute(attribute) : node.nodeValue;
      if (!node.isConnected || current !== label.applied) continue;
      const next = locale === "en-US" ? source : source.replace(/\S(?:[\s\S]*\S)?/, () => text(key));
      if (attribute) node.setAttribute(attribute, next);
      else node.nodeValue = next;
      label.applied = next;
    }
    for (const [node, labels] of boundLabels) {
      if (!node.isConnected) { boundLabels.delete(node); continue; }
      for (const [attribute, { source, values }] of labels) write(node, text(source, values), attribute);
    }
    for (const label of doc.querySelectorAll("[data-editor-label]")) {
      label.textContent = text(label.dataset.editorLabel);
    }
  }

  renderLanguage();
  win.addEventListener("desirecore:localechange", ({ detail }) => {
    if (!valid(detail) || detail === locale) return;
    locale = detail;
    renderLanguage();
    win.dispatchEvent(new win.CustomEvent("video-editor:localechange"));
  });
  return Object.freeze({ text, bind });
});
