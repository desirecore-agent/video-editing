/* UI-only appearance bridge. Project/compositor code must never import theme
   colors as document defaults. Uses only app-authoring-v1's finite public SDK. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window === "undefined" ? null : window, function () {
  "use strict";

  // Closed app-authoring-v1 appearance vocabulary; each token is checked as its
  // actual CSS property, then written as one value, never as executable CSS text.
  const HOST_PROPERTIES = Object.freeze({
    "--sys-label": "color", "--sys-secondary": "color", "--sys-tertiary": "color", "--sys-quaternary": "color",
    "--sys-separator": "color", "--sys-fill": "color",
    "--glass-white": "color", "--glass-card": "color", "--glass-hover": "color", "--glass-active": "color",
    "--glass-border": "color", "--glass-highlight": "color", "--glass-dim": "color", "--glass-solid": "color", "--glass-modal": "color",
    "--action-primary": "color", "--action-hover": "color", "--action-solid": "color", "--action-solid-hover": "color",
    "--action-foreground": "color", "--action-soft": "color", "--action-border": "color",
    "--accent-green": "color", "--accent-blue": "color", "--accent-purple": "color", "--accent-orange": "color", "--accent-red": "color",
    "--font-sans": "font-family",
    "--radius-sm": "border-radius", "--radius-md": "border-radius", "--radius-base": "border-radius", "--radius-lg": "border-radius",
    "--radius-xl": "border-radius", "--radius-2xl": "border-radius", "--radius-input": "border-radius", "--radius-pill": "border-radius",
    "--shadow-glass": "box-shadow", "--shadow-glass-btn": "box-shadow", "--shadow-float": "box-shadow",
    "--shadow-contained-card": "box-shadow", "--shadow-contained-popover": "box-shadow",
    "--scroll-thumb": "color", "--scroll-thumb-hover": "color",
  });
  const record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  function parseAppearance(value, supports) {
    if (!record(value) || value.schemaVersion !== 1 || !["light", "dark"].includes(value.colorScheme)
      || Object.keys(value).some((k) => !["schemaVersion", "colorScheme", "tokens"].includes(k)) || !record(value.tokens)) return null;
    const names = Object.keys(HOST_PROPERTIES), input = value.tokens, tokens = {};
    if (Object.keys(input).length !== names.length || Object.keys(input).some((k) => !Object.hasOwn(HOST_PROPERTIES, k))) return null;
    for (const name of names) {
      const raw = input[name];
      if (typeof raw !== "string" || !raw.trim() || raw.length > 1024 || /[;{}<>\\\r\n]|\b(?:url|expression|var|env)\s*\(/i.test(raw)
        || /^(?:inherit|initial|unset|revert(?:-layer)?)$/i.test(raw.trim()) || !supports(HOST_PROPERTIES[name], raw)) return null;
      tokens[name] = raw.trim();
    }
    return { schemaVersion: 1, colorScheme: value.colorScheme, tokens };
  }

  // These are editor chrome, not clip/marker identities or exported pixel data.
  // Stable names also let the OffscreenCanvas ruler receive a serializable copy.
  const PALETTE_PROPERTIES = Object.freeze({
    text: "--text", secondary: "--dim", border: "--border", surface: "--panel", well: "--well",
    rulerTick: "--ui-ruler-tick", rulerText: "--ui-ruler-text", outsideRange: "--ui-outside-range",
    markerLabelBackground: "--ui-marker-label-bg", waveform: "--ui-waveform",
    grid: "--ui-grid", curve: "--accent", keyframe: "--ui-keyframe", playhead: "--ui-playhead",
    rangeIn: "--ui-range-in", rangeOut: "--ui-range-out", focus: "--accent", selection: "--ui-selection",
    handle: "--ui-handle", handleBorder: "--ui-handle-border",
    // Scopes and controls over the picture intentionally retain calibrated dark
    // plates and high-contrast handles in both appearances, like the host viewer.
    scopeBackground: "--ui-scope-bg", scopeGrid: "--ui-scope-grid", scopeText: "--ui-scope-text",
    scopeLine: "--ui-scope-line", scopeHandle: "--ui-scope-handle", scopeHandleBorder: "--ui-scope-handle-border",
    overlayText: "--ui-picture-fg", overlayMuted: "--ui-picture-muted", overlayBackground: "--ui-picture-plate",
    meterOff: "--ui-meter-off",
  });

  function install(win) {
    if (win.DesireCoreTheme) return win.DesireCoreTheme;
    const doc = win.document, target = doc.documentElement;
    const system = win.matchMedia("(prefers-color-scheme: dark)");
    let source = "system", revision = 0, eventVersion = 0, disposed = false, cached = null, unsubscribe;
    const supports = (property, value) => !!win.CSS?.supports(property, value);
    // Resolve CSS color-mix/alpha values through a real color property once per
    // appearance revision. Canvas receives computed colors, not CSS variables.
    function snapshot() {
      if (cached) return cached;
      const probe = doc.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none";
      target.appendChild(probe);
      const palette = {};
      for (const [name, property] of Object.entries(PALETTE_PROPERTIES)) {
        probe.style.color = `var(${property})`;
        palette[name] = win.getComputedStyle(probe).color;
      }
      probe.remove();
      palette.fontMono = win.getComputedStyle(target).getPropertyValue("--ui-font-mono").trim();
      cached = Object.freeze({ theme: target.dataset.theme, source, revision, palette: Object.freeze(palette) });
      return cached;
    }
    function changed() {
      revision += 1;
      target.dataset.hostAppearanceRevision = String(revision);
      cached = null;
      const themeColor = doc.querySelector('meta[name="theme-color"]');
      if (themeColor) themeColor.content = snapshot().palette.surface;
      win.dispatchEvent(new win.CustomEvent("desirecore:themechange", { detail: snapshot() }));
    }
    function fallback() {
      if (source === "host" || disposed) return;
      target.dataset.theme = system.matches ? "dark" : "light";
      changed();
    }
    function apply(value) {
      const appearance = parseAppearance(value, supports);
      if (!appearance || disposed) return false;
      for (const [name, value] of Object.entries(appearance.tokens)) target.style.setProperty(`--host-${name.slice(2)}`, value);
      source = "host";
      target.dataset.theme = appearance.colorScheme;
      target.dataset.hostAppearance = "true";
      changed();
      return true;
    }
    function dispose() {
      if (disposed) return;
      unsubscribe?.();
      system.removeEventListener("change", fallback);
      win.removeEventListener("pagehide", dispose);
      for (const name of Object.keys(HOST_PROPERTIES)) target.style.removeProperty(`--host-${name.slice(2)}`);
      delete target.dataset.hostAppearance;
      source = "system";
      fallback();
      disposed = true;
    }
    const publicApi = Object.freeze({ snapshot });
    win.DesireCoreTheme = publicApi;
    fallback();
    system.addEventListener("change", fallback);
    win.addEventListener("pagehide", dispose, { once: true });
    // Public bridge is available only in the native top-level application page.
    // No cross-origin parent DOM, arbitrary message listener or privileged API.
    const bridge = win.top === win ? win.desirecoreApp : null;
    if (bridge && typeof bridge.call === "function") {
      const connectedAt = eventVersion;
      try {
        unsubscribe = bridge.onEvent?.((event) => {
          if (record(event) && event.type === "appearance-changed" && apply(event.appearance)) eventVersion += 1;
        });
      } catch { /* A host without events may still provide its initial snapshot. */ }
      Promise.resolve().then(() => disposed ? null : bridge.call("connect")).then((connection) => {
        if (!disposed && connectedAt === eventVersion && record(connection)) apply(connection.appearance);
      }, () => { /* Independent preview remains on its system fallback. */ });
    }
    return publicApi;
  }
  return { HOST_PROPERTIES, PALETTE_PROPERTIES, parseAppearance, install };
});
