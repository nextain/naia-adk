"use strict";

// Order is canonical and shared with the versioned gateway runner.
const PAIRS = Object.freeze([
  ["AZURE_TTS_KEY", "azure-tts-key-v1"],
  ["AZURE_TTS_REGION", "azure-tts-region-v1"],
]);
function additionsSpec(value) {
  if (value === undefined) return "-";
  if (!Array.isArray(value)) return null;
  let last = -1;
  const ids = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "name,source_id") return null;
    const index = PAIRS.findIndex(([name, source]) => item.name === name && item.source_id === source);
    if (index <= last) return null;
    last = index;
    ids.push(item.source_id);
  }
  return ids.join(",") || "-";
}
module.exports = { PAIRS, additionsSpec };
