/* Literal keyword colours, independent of speech timing. Shared project data
 * for the GUI, MCP and compositor; never inferred from the current word. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutTextEmphasis = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#", type: "array", maxItems: 64,
    description: "props.emphasis: literal keywords remain coloured for the entire visible caption, independently of wordTimes and playback position. Longest match wins; equal-length rules use list order.",
    items: { type: "object", required: ["text", "color"], additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 1, maxLength: 256, description: "Exact keyword or phrase, including Chinese without spaces. All matching occurrences are coloured; no regular expressions or markup." },
        color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", default: "#ffd166", description: "Persistent RGB text colour. It takes precedence over the transient current-word highlight." },
      } },
  };
  const DEFAULT_COLOR = schema.items.properties.color.default;
  function validate(rules) {
    if (!Array.isArray(rules) || rules.length > schema.maxItems) throw Error("emphasis must be an array of at most 64 {text, color} rules");
    for (const rule of rules) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule) || Object.keys(rule).some(k => !["text", "color"].includes(k))
        || typeof rule.text !== "string" || !rule.text.trim() || rule.text.length > schema.items.properties.text.maxLength
        || typeof rule.color !== "string" || !new RegExp(schema.items.properties.color.pattern).test(rule.color))
        throw Error("each emphasis rule needs non-empty text (at most 256 characters) and color #RRGGBB");
    }
    return rules;
  }
  function ranges(text, rules, uppercase = false) {
    if (!Array.isArray(rules) || !rules.length) return [];
    const candidates = rules.filter(r => r && typeof r.text === "string" && r.text.length && typeof r.color === "string")
      .map((r, index) => ({ text: uppercase ? r.text.toUpperCase() : r.text, color: r.color, index }))
      .sort((a, b) => b.text.length - a.text.length || a.index - b.index);
    const out = [];
    for (let i = 0; i < text.length;) {
      const rule = candidates.find(r => text.startsWith(r.text, i));
      if (rule) { out.push({ start: i, end: i + rule.text.length, color: rule.color }); i += rule.text.length; }
      else i += String.fromCodePoint(text.codePointAt(i)).length;
    }
    return out;
  }
  return { schema, DEFAULT_COLOR, validate, ranges };
});
