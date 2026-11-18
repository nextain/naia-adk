"use strict";

const path = require("node:path");

// Order is canonical and shared with the versioned gateway runner.
const PAIRS = Object.freeze([
  ["AZURE_TTS_KEY", "azure-tts-key-v1"],
  ["AZURE_TTS_REGION", "azure-tts-region-v1"],
  ["APP_SIGNING_PUBLIC_KEY", "app-signing-public-key-v1"],
]);
const DEFAULT_GATEWAY_SERVICE = "azure:vm:gateway-prod";
const GATEWAY_SERVICE_RE = /^azure:vm:[a-z0-9][a-z0-9._-]{0,63}$/i;
const NON_PROD_SERVICE_RE = /(?:^|[-_.:/])(dev|develop|development|staging|stage|stg|preview|test|testing|sandbox|local)(?:[-_.:/]|$)/i;
const IMAGE_REPO_RE = /^[a-z0-9]{5,50}\.azurecr\.io\/[a-z0-9._/-]{1,128}$/;

function isProdGatewayService(value) {
  return typeof value === "string" && GATEWAY_SERVICE_RE.test(value) && !NON_PROD_SERVICE_RE.test(value);
}

function resolveGatewayService(cfg) {
  if (!cfg || typeof cfg !== "object") return DEFAULT_GATEWAY_SERVICE;
  if (isProdGatewayService(cfg.gatewayRunner?.service)) return cfg.gatewayRunner.service;
  const entries = Object.entries(cfg.services && typeof cfg.services === "object" ? cfg.services : {})
    .filter(([k]) => isProdGatewayService(k));
  const explicit = entries.filter(([, r]) => r && typeof r === "object" && r.gatewayRunner !== undefined);
  if (explicit.length === 1) return explicit[0][0];
  if (explicit.length > 1) return DEFAULT_GATEWAY_SERVICE;
  const hinted = entries.filter(([, r]) => r && typeof r === "object" && (
    (Array.isArray(r.requiredFiles) && r.requiredFiles.some((f) => typeof f === "string" && /(?:launch|operation|status|rollback)-local\.sh$/.test(f))) ||
    (Array.isArray(r.allowedCommands) && r.allowedCommands.some((p) => typeof p === "string" && /(?:launch|operation|status|rollback)-local/.test(p)))
  ));
  if (hinted.length === 1) return hinted[0][0];
  if (entries.length === 1) return entries[0][0];
  return DEFAULT_GATEWAY_SERVICE;
}

function validateGatewayRunnerConfig(gatewayService, rule, cfg) {
  const top = cfg?.gatewayRunner;
  const svcList = Object.entries(cfg?.services && typeof cfg.services === "object" ? cfg.services : {})
    .filter(([, r]) => r && typeof r === "object" && r.gatewayRunner !== undefined);
  if ((top !== undefined ? 1 : 0) + svcList.length > 1) return { ok: false, imageRepo: null };
  if (svcList.length === 1 && svcList[0][0] !== gatewayService) return { ok: false, imageRepo: null };
  const gw = rule?.gatewayRunner !== undefined ? rule.gatewayRunner : top;
  if (gw === undefined) return { ok: true, imageRepo: null };
  if (!gw || typeof gw !== "object" || Array.isArray(gw)) return { ok: false, imageRepo: null };
  if (gw.service !== undefined && gw.service !== gatewayService) return { ok: false, imageRepo: null };
  if (gw.subscriptionId !== undefined && !(typeof gw.subscriptionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gw.subscriptionId))) return { ok: false, imageRepo: null };
  if (gw.location !== undefined && !(typeof gw.location === "string" && /^[a-z0-9]{1,64}$/.test(gw.location))) return { ok: false, imageRepo: null };
  if (gw.acrName !== undefined && !(typeof gw.acrName === "string" && /^[a-z0-9]{5,50}$/.test(gw.acrName))) return { ok: false, imageRepo: null };
  let imageRepo = null;
  if (gw.imageRepo !== undefined) {
    if (typeof gw.imageRepo !== "string" || !IMAGE_REPO_RE.test(gw.imageRepo)) return { ok: false, imageRepo: null };
    if (gw.acrName !== undefined && !gw.imageRepo.startsWith(`${gw.acrName}.azurecr.io/`)) return { ok: false, imageRepo: null };
    imageRepo = gw.imageRepo;
  }
  if (gw.environments !== undefined) {
    if (!gw.environments || typeof gw.environments !== "object" || Array.isArray(gw.environments)) return { ok: false, imageRepo: null };
    for (const [envName, target] of Object.entries(gw.environments)) {
      if (!["prod", "dev"].includes(envName) || !target || typeof target !== "object" || Array.isArray(target)) return { ok: false, imageRepo: null };
      if (typeof target.resourceGroup !== "string" || !/^[A-Za-z0-9._()-]{1,90}$/.test(target.resourceGroup)) return { ok: false, imageRepo: null };
      if (typeof target.vmName !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(target.vmName)) return { ok: false, imageRepo: null };
      if (envName === "prod" && target.vmName.toLowerCase() !== gatewayService.slice("azure:vm:".length).toLowerCase()) return { ok: false, imageRepo: null };
    }
  }
  return { ok: true, imageRepo };
}

function isValidAdditionsArg(spec) {
  if (spec === "-") return true;
  if (typeof spec !== "string" || !spec) return false;
  let last = -1;
  for (const id of spec.split(",")) {
    const index = PAIRS.findIndex(([, source]) => source === id);
    if (index <= last) return false;
    last = index;
  }
  return true;
}

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
function additionsBindingProblem(plan, expectedService = null) {
  const spec = additionsSpec(plan?.environment_additions);
  if (spec === null) return "environment_additions 허용 쌍·순서·중복 오류";
  if (spec === "-") return null;
  if (!Array.isArray(plan.services) || plan.services.length !== 1 || !isProdGatewayService(plan.services[0]) || (expectedService && plan.services[0] !== expectedService)) {
    return "environment_additions 게이트웨이 서비스 결합 오류";
  }
  const { shellClauses } = require("./git-command-parser.js");
  const backups = [];
  for (const entry of Array.isArray(plan.scenario) ? plan.scenario : []) for (const command of Array.isArray(entry?.commands) ? entry.commands : []) {
    if (typeof command !== "string") continue;
    const clauses = shellClauses(command);
    if (clauses.length !== 1) continue;
    const a = clauses[0];
    if (a[0] === "bash" && path.isAbsolute(a[1] || "") && path.basename(a[1]) === "launch-local.sh" && a[2] === "prod" && (a[8] === "backup" || a.length === 8)) backups.push(a);
  }
  const a = backups[0];
  if (backups.length !== 1 || a.length !== 10 || a[9] !== spec ||
      !/^\d{8}T\d{6}Z-[a-z0-9-]{1,32}$/.test(a[3] || "") ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(a[4] || "") ||
      !/^sha256:[a-f0-9]{64}$/.test(a[5] || "") || !/^sha256:[a-f0-9]{64}$/.test(a[6] || "") ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(a[7] || "")) return "environment_additions 유일한 backup 단계 결합 오류";
  return null;
}

module.exports = {
  PAIRS,
  DEFAULT_GATEWAY_SERVICE,
  IMAGE_REPO_RE,
  isProdGatewayService,
  resolveGatewayService,
  validateGatewayRunnerConfig,
  isValidAdditionsArg,
  additionsSpec,
  additionsBindingProblem,
};
