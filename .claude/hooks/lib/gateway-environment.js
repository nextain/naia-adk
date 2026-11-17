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
// A nonempty declaration belongs to one exact gateway backup command.
function additionsBindingProblem(plan) {
  const spec = additionsSpec(plan?.environment_additions);
  if (spec === null) return "environment_additions 허용 쌍·순서·중복 오류";
  if (spec === "-") return null;
  const service = "azure:vm:naia-gateway-prod-az";
  if (!Array.isArray(plan.services) || plan.services.length !== 1 || plan.services[0] !== service) return "environment_additions 게이트웨이 서비스 결합 오류";
  const { shellClauses } = require("./git-command-parser.js");
  const backups = [];
  for (const entry of Array.isArray(plan.scenario) ? plan.scenario : []) for (const command of Array.isArray(entry?.commands) ? entry.commands : []) {
    if (typeof command !== "string") continue;
    const clauses = shellClauses(command);
    if (clauses.length !== 1) continue;
    const a = clauses[0];
    if (a[0] === "bash" && require("node:path").isAbsolute(a[1] || "") && require("node:path").basename(a[1]) === "launch-local.sh" && a[2] === "prod" && (a[8] === "backup" || a.length === 8)) backups.push(a);
  }
  const a = backups[0];
  if (backups.length !== 1 || a.length !== 10 || a[9] !== spec ||
      !/^\d{8}T\d{6}Z-[a-z0-9-]{1,32}$/.test(a[3] || "") ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(a[4] || "") ||
      !/^sha256:[a-f0-9]{64}$/.test(a[5] || "") || !/^sha256:[a-f0-9]{64}$/.test(a[6] || "") ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(a[7] || "")) return "environment_additions 유일한 backup 단계 결합 오류";
  return null;
}
module.exports = { PAIRS, additionsSpec, additionsBindingProblem };
