/* Confidence refinement for the existing person mask. No inference or I/O. */
(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutBackgroundMask = api;
})(typeof self !== "undefined" ? self : this, function() {
  "use strict";
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Person mask confidence refinement",
    description: "Optional clip props applied to the current person mask before compositing and silhouette strokes; no change to the inference model.",
    type: "object", additionalProperties: true,
    properties: {
      bgThreshold: { type: "number", minimum: 0, maximum: 100, default: 0,
        description: "Person confidence below this percentage is transparent. Zero preserves the original soft mask." },
      bgSoftness: { type: "number", minimum: 0, maximum: 100, default: 10,
        description: "Confidence interval above bgThreshold that smoothly becomes opaque. Zero selects a hard edge. Ignored while bgThreshold is zero." },
    },
  };
  function settings(props = {}) {
    const values = {};
    for (const [key, rule] of Object.entries(schema.properties)) {
      const value = props[key] === undefined ? rule.default : props[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < rule.minimum || value > rule.maximum)
        throw Error(`${key} must be a finite number from ${rule.minimum} to ${rule.maximum}`);
      values[key] = value / 100;
    }
    return { threshold: values.bgThreshold, softness: values.bgSoftness };
  }
  function alpha(value, { threshold, softness }) {
    if (!threshold) return value;
    const high = Math.min(1, threshold + softness);
    if (high <= threshold) return value >= threshold ? 1 : 0;
    const t = Math.max(0, Math.min(1, (value - threshold) / (high - threshold)));
    return t * t * (3 - 2 * t);
  }
  return { schema, settings, alpha };
});
