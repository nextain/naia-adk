#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { readJson, withSession, atomicJson } = require("./cost-guard-state.cjs");
const { readTranscript, hashPrompt, autonomousText } = require("./cost-guard-usage.cjs");

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_METER_BYTES = 256 * 1024;
const EVENTS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Stop", "PreCompact"]);
const DEFAULT_LIMITS = { quotaUtilization: 95, rapidPercentagePoints: 3, rapidWindowSeconds: 300, processingTokensPerTenMinutes: 1000000, responsesPerHour: 40, responsesPerTurn: 8, maxContextTokens: 150000 };
const MODEL_ADVICE_EVENTS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolBatch"]);
const freeRecovery = prompt => /^\s*\/(?:clear|status|usage|logout)(?:\s|$)/i.test(prompt) || /^\s*\/goal\s+(?:clear|stop|off|reset|none|cancel)(?:\s|$)/i.test(prompt);
const compactRecovery = prompt => /^\s*\/compact(?:\s|$)/i.test(prompt);
function halt(event, reason) {
  const text = "확인된 계정 상태로 작업을 멈췄습니다: " + reason + ". 미완료 목표와 의무는 유지됩니다. /status·/usage로 확인하고 올바른 계정 또는 실제 한도 회복 뒤 이어가십시오.";
  return event === "PreCompact" ? { decision: "block", reason: text } : { continue: false, stopReason: text };
}
const REVIEW_LABELS = {
  invalid_input: "훅 입력 확인 불가", runtime_error: "관찰기 실행 오류", policy_unknown: "관찰 정책 확인 불가",
  config_unknown: "실행 설정 확인 불가", auth_unknown: "실행 인증 범위 확인 불가", meter_unknown: "사용량 정보 없음 또는 오래됨",
  meter_identity_unknown: "현재 인증과 관찰 정보 연결 확인 불가", quota_unknown: "계정 사용 한도 미확인",
  quota_near_limit: "계정 사용량 검토 기준 이상", rapid_quota: "짧은 시간 사용량 증가", host_unknown: "호스트 처리량 불완전",
  responses_hour: "시간당 응답 검토 기준 초과", processing_10m: "10분 처리량 검토 기준 초과",
  transcript_unknown: "현재 응답 사용량 미확인", turn_unknown: "회차 경계 또는 사용량 불완전",
  responses_turn: "회차 응답 검토 기준 초과", context_large: "입력 문맥 검토 기준 초과", provenance_ambiguous: "입력 출처 일부 불명확"
};
function adviceText(codes) {
  const reasons = codes.slice(0, 8).map(code => REVIEW_LABELS[code] || "관찰 정보 검토").join("; ");
  return "효율 검토: " + reasons + ". 목표를 유지하고 생산적인 작업을 계속하십시오. 지금 확인된 진전과 테스트 증거를 짧게 점검하고, 반복 상태 조회는 묶어서 실행하며 긴 로그 대신 필요한 결과만 읽으십시오. 필요하면 범위를 좁힌 새 Codex 또는 Claude 문맥을 선택하십시오. 별도 승인이나 자동 모델 호출·위임을 요구하지 않습니다. 미확인 사용량은 0으로 간주하지 않습니다.";
}
function displayAdvice(codes) { return { systemMessage: adviceText(codes) }; }
function recordReview(directory, sessionId, record) {
  try {
    const sessionHash = crypto.createHash("sha256").update(String(sessionId || "unidentified")).digest("hex");
    withSession(directory, "review-index", index => {
      const records = Array.isArray(index.records) ? index.records : [];
      index.records = [...records.filter(x => x.session_hash !== sessionHash), { ...record, session_hash: sessionHash }].slice(-32);
      return atomicJson(path.join(directory, "review-needed.json"), { schema_version: 1, records: index.records });
    });
  } catch {}
}
function reviewOutput(state, event, codes, nowSeconds, metrics) {
  state.held = null; // Retire legacy blocking holds, preserving all observations.
  const risks = [...new Set(codes)].sort().slice(0, 24);
  const previous = state.review;
  const previousCodes = previous?.risk_codes?.join("|") || "";
  if (!risks.length) {
    if (previous?.active) state.review = { ...previous, active: false, resolved_at: nowSeconds };
    return { output: null, changed: Boolean(previous?.active) };
  }
  if (!previous?.active) state.review = { episode: (Number.isSafeInteger(previous?.episode) ? previous.episode : 0) + 1, active: true, started_at: nowSeconds, risk_codes: risks, model_notified: false, display_notified: false };
  else state.review.risk_codes = [...new Set([...previous.risk_codes || [], ...risks])].sort().slice(0, 24);
  const review = state.review;
  let output = null;
  if (MODEL_ADVICE_EVENTS.has(event) && !review.model_notified) {
    review.model_notified = true;
    output = { hookSpecificOutput: { hookEventName: event, additionalContext: adviceText(review.risk_codes) } };
  } else if (!MODEL_ADVICE_EVENTS.has(event) && !review.display_notified) {
    review.display_notified = true;
    output = displayAdvice(review.risk_codes);
  }
  return { output, changed: !previous?.active || Boolean(output) || previousCodes !== review.risk_codes.join("|"), record: { episode: review.episode, at: nowSeconds, event, status: "review_needed", risk_codes: review.risk_codes, metrics } };
}
function unverifiedAdvice(event, code, policyFile, sessionId, nowSeconds) {
  // Invalid/runtime observations never halt development. Do not inject model
  // context when identity or durable state is unavailable.
  if (typeof policyFile !== "string" || !path.isAbsolute(policyFile)) return displayAdvice([code]);
  let directory;
  try { directory = fs.realpathSync(path.dirname(policyFile)); } catch { return displayAdvice([code]); }
  const result = withSession(path.join(directory, "state"), sessionId || "unidentified-observer", state => {
    const outcome = reviewOutput(state, "DisplayOnly", [code], nowSeconds, { status: "unknown" });
    if (outcome.changed) recordReview(directory, sessionId, outcome.record || { at: nowSeconds, status: "clear", risk_codes: [] });
    return outcome.output;
  });
  return result.status === "known" ? result.value : displayAdvice([code]);
}
function realConfigDir(env = process.env, home = os.homedir()) {
  const requested = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  return path.isAbsolute(requested) ? fs.realpathSync(requested) : null;
}
function unsupportedEnvironment(env) {
  const active = value => value !== undefined && value !== null && !/^(?:|0|false|off|no)$/i.test(String(value).trim());
  const base = String(env.ANTHROPIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_CUSTOM_HEADERS || base && base !== "https://api.anthropic.com" || ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(key => active(env[key])));
}
function runtimeIdentity(configDir, env = process.env) {
  if (unsupportedEnvironment(env)) return { status: "unknown", config_dir: configDir, reason: "설정된 OAuth 계정 밖의 API 환경" };
  const credentials = readJson(path.join(configDir, ".credentials.json"), 65536);
  const token = credentials.status === "known" && credentials.data.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || !token || token.length > 32768) return { status: "unknown", config_dir: configDir, reason: "활성 OAuth 인증 확인 불가" };
  return { status: "known", config_dir: configDir, credential_fingerprint: crypto.createHash("sha256").update(token).digest("hex") };
}
function loadPolicy(policyFile) {
  if (typeof policyFile !== "string" || !path.isAbsolute(policyFile)) return { status: "unknown", reason: "정책 경로 확인 불가" };
  const read = readJson(policyFile, 16384);
  if (read.status !== "known") return { status: "unknown", reason: "정책 파일 확인 불가" };
  const policy = read.data;
  if (JSON.stringify(policy).includes("{{")) return { status: "unknown", reason: "정책 자리표시 확인 필요" };
  if (typeof policy.configDir !== "string" || !path.isAbsolute(policy.configDir) || typeof policy.expectedEmail !== "string" || !policy.expectedEmail.includes("@")) return { status: "unknown", reason: "정책 계정 설정 확인 불가" };
  const limits = { ...DEFAULT_LIMITS, ...policy.limits };
  if (Object.values(limits).some(x => !Number.isFinite(x) || x <= 0) || limits.quotaUtilization > 100 || ["responsesPerTurn", "responsesPerHour", "maxContextTokens", "processingTokensPerTenMinutes"].some(k => !Number.isSafeInteger(limits[k]))) return { status: "unknown", reason: "정책 한도 확인 불가" };
  const freshness = policy.quotaFreshSeconds ?? 180;
  if (!Number.isFinite(freshness) || freshness <= 0 || freshness > 180) return { status: "unknown", reason: "사용량 유효기간 확인 불가" };
  try { return { status: "known", policy: { ...policy, configDir: fs.realpathSync(policy.configDir), allowedConfigDirs: [policy.configDir, ...(Array.isArray(policy.extraConfigDirs) ? policy.extraConfigDirs : [])].filter(d => path.isAbsolute(d) && fs.existsSync(d)).map(d => fs.realpathSync(d)), allowedEmails: [policy.expectedEmail, ...(Array.isArray(policy.extraEmails) ? policy.extraEmails : [])].map(e => String(e).toLowerCase()), limits, quotaFreshSeconds: freshness }, directory: fs.realpathSync(path.dirname(policyFile)) }; }
  catch { return { status: "unknown", reason: "설정 디렉터리 확인 불가" }; }
}
function inspectMeter(meter, policy, identity, nowSeconds) {
  const codes = [];
  if (!meter || meter.schema_version !== 1 || !Number.isFinite(meter.checked_at) || nowSeconds - meter.checked_at > policy.quotaFreshSeconds || meter.checked_at > nowSeconds + 30) return { codes: ["meter_unknown"], hostKnown: false };
  const verified = identity.status === "known" && meter.credential_fingerprint === identity.credential_fingerprint && meter.config_dir === identity.config_dir;
  if (!verified) codes.push("meter_identity_unknown");
  const emailKnown = typeof meter.account_email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(meter.account_email);
  if (verified && emailKnown && !policy.allowedEmails.includes(meter.account_email.toLowerCase())) return { codes, hardStop: "확인된 계정이 요청한 계정과 다름", hostKnown: false };
  if (!emailKnown) codes.push("quota_unknown");
  const windows = meter.quota?.windows;
  const quotaKnown = meter.quota?.status === "known" && windows && typeof windows === "object" && windows.five_hour && windows.seven_day;
  if (!quotaKnown) codes.push("quota_unknown");
  for (const item of Object.values(quotaKnown ? windows : {})) {
    if (item === null) continue;
    if (!item || !Number.isFinite(item.utilization) || item.utilization < 0 || item.utilization > 100) { codes.push("quota_unknown"); continue; }
    if (verified && emailKnown && item.utilization >= 100) codes.push("quota_near_limit"); // Provider decides actual model availability; never preemptively halt on a usage snapshot.
    if (item.utilization >= policy.limits.quotaUtilization) codes.push("quota_near_limit");
  }
  if (meter.quota?.reason === "rapid_quota_increase" || meter.quota?.warnings?.includes("rapid_quota_increase")) codes.push("rapid_quota");
  const host = meter.host_activity;
  const hostKnown = meter.config_dir === identity.config_dir && host?.status === "known" && Number.isSafeInteger(host.responses_hour) && host.responses_hour >= 0 && Number.isSafeInteger(host.processing_tokens_10m) && host.processing_tokens_10m >= 0 && host.observed_messages && typeof host.observed_messages === "object" && !Array.isArray(host.observed_messages) && Object.keys(host.observed_messages).length <= 2048 && Object.entries(host.observed_messages).every(([id, item]) => id && id.length <= 256 && item && Number.isFinite(item.timestamp) && Number.isSafeInteger(item.processing_tokens) && item.processing_tokens >= 0);
  if (!hostKnown) codes.push("host_unknown");
  return { codes, hostKnown: Boolean(hostKnown), quotaKnown: Boolean(verified && emailKnown && quotaKnown && !codes.includes("quota_unknown")) };
}
function validateMeter(meter, policy, identity, nowSeconds) { const result = inspectMeter(meter, policy, identity, nowSeconds); return result.hardStop || result.codes[0] || null; }
function aggregateCurrent(meter, transcript, nowSeconds) {
  let responses = meter.host_activity.responses_hour;
  let processing = meter.host_activity.processing_tokens_10m;
  for (const row of transcript.responses) {
    if (!row.known || row.timestamp < nowSeconds - 3600 || row.timestamp > nowSeconds + 30) continue;
    const previous = meter.host_activity.observed_messages[row.id];
    if (!previous) responses++;
    if (row.timestamp >= nowSeconds - 600) {
      const counted = previous && previous.timestamp >= meter.checked_at - 600 ? previous.processing_tokens : 0;
      processing += Math.max(0, row.processing_tokens - counted);
    }
  }
  return { responses_hour: responses, processing_tokens_10m: processing };
}
function correlatedPrompt(input, transcript, nowSeconds) {
  const promptHash = hashPrompt(input.prompt || "");
  return [...transcript.provenance].reverse().find(x => x.prompt_hash === promptHash && x.key && (x.timestamp === null || Math.abs(nowSeconds - x.timestamp) <= 300));
}
function autonomous(input, transcript, nowSeconds) {
  if (correlatedPrompt(input, transcript, nowSeconds)) return false;
  const prompt = String(input.prompt || "");
  const source = String(input.prompt_source || input.promptSource || input.source || "").toLowerCase();
  return autonomousText(prompt) || ["scheduled", "cron", "scheduler", "task_notification", "background", "agent", "hook", "auto", "goal", "cross_session"].includes(source);
}
function establishTurn(state, input, transcript, nowSeconds) {
  const promptHash = hashPrompt(input.prompt || "");
  if (autonomous(input, transcript, nowSeconds)) return { ambiguous: true };
  const match = correlatedPrompt(input, transcript, nowSeconds);
  let key = match?.key;
  let boundary = match?.offset;
  if (!state.turn && !match) { key = "initial:" + promptHash; boundary = transcript.end_offset; }
  if (!key) return { ambiguous: true };
  if (state.turn?.key === key) return { duplicate: true };
  const baseline = transcript.responses.filter(x => x.first_offset < boundary).map(x => x.id);
  if (baseline.length > 512) return { unknown: true };
  state.turn = { key, started_at: nowSeconds, start_offset: boundary, transcript_identity: transcript.identity, baseline_ids: baseline, responses: {}, stop_observed_at: null };
  state.held = null;
  return { started: true, ambiguous: !match || match.kind === "native_user_correlated" };
}
function observeTurn(state, transcript) {
  if (!state.turn) return "회차 시작 기록 확인 불가";
  const turn = state.turn;
  if (!Number.isSafeInteger(turn.start_offset) || !Array.isArray(turn.baseline_ids) || !turn.responses || typeof turn.responses !== "object" || Array.isArray(turn.responses)) return "회차 기록 확인 불가";
  if (turn.transcript_identity && turn.transcript_identity !== transcript.identity || transcript.end_offset < turn.start_offset) return "회차 원본이 변경됨";
  if (!turn.transcript_identity) turn.transcript_identity = transcript.identity;
  const baseline = new Set(turn.baseline_ids);
  for (const row of transcript.responses) {
    if (baseline.has(row.id) || row.first_offset < turn.start_offset) continue;
    if (!row.known) return "회차 응답 사용량 확인 불가";
    if (!Object.hasOwn(turn.responses, row.id) && Object.keys(turn.responses).length >= 256) { turn.overflow = true; continue; }
    turn.responses[row.id] = { processing_tokens: row.processing_tokens, context_tokens: row.context_tokens };
  }
  if (turn.overflow) return "회차 응답 기록 제한 초과";
  return null;
}
function evaluate(input, options = {}) {
  const event = input?.hook_event_name || options.eventName;
  const nowSeconds = options.nowSeconds ?? Date.now() / 1000;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const requestedPolicy = options.policyFile || env.NAIA_COST_GUARD_POLICY || env.CLAUDE_COST_POLICY || path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "cost-guard", "policy.json");
  if (!input || typeof input !== "object" || Array.isArray(input) || !EVENTS.has(event) || options.eventName && options.eventName !== event) return halt(event, "훅 입력 확인 불가");
  const loaded = loadPolicy(requestedPolicy);
  if (loaded.status !== "known") return halt(event, "관찰 정책 확인 불가");
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (event === "UserPromptSubmit" && freeRecovery(prompt)) return null;
  let configDir;
  try { configDir = realConfigDir(env, home); } catch { return unverifiedAdvice(event, "config_unknown", requestedPolicy, input.session_id, nowSeconds); }
  const { policy, directory } = loaded;
  if (!policy.allowedConfigDirs.includes(configDir)) return halt(event, "실행 설정 디렉터리가 정책 범위와 다름");
  const identity = runtimeIdentity(configDir, env);
  const meterRead = readJson(path.join(directory, "meter.json"), MAX_METER_BYTES);
  const meter = meterRead.status === "known" ? meterRead.data : null;
  const meterCheck = inspectMeter(meter, policy, identity, nowSeconds);
  if (meterCheck.hardStop) return halt(event, meterCheck.hardStop);
  const transcript = typeof input.transcript_path === "string" && path.isAbsolute(input.transcript_path)
    ? readTranscript(input.transcript_path, { nowSeconds })
    : { status: "unknown", responses: [], provenance: [], current_context_tokens: null };
  const result = withSession(path.join(directory, "state"), input.session_id, state => {
    let promptResult;
    if (event === "UserPromptSubmit" && !compactRecovery(prompt)) promptResult = Number.isSafeInteger(transcript.end_offset) ? establishTurn(state, input, transcript, nowSeconds) : { unknown: true };
    const codes = [...meterCheck.codes];
    if (identity.status !== "known") codes.push("auth_unknown");
    if (transcript.status !== "known") codes.push("transcript_unknown");
    if (promptResult?.unknown) codes.push("turn_unknown");
    if (promptResult?.ambiguous) codes.push("provenance_ambiguous");
    let totals = null;
    if (meterCheck.hostKnown) {
      totals = aggregateCurrent(meter, transcript, nowSeconds);
      if (totals.responses_hour >= policy.limits.responsesPerHour) codes.push("responses_hour");
      if (totals.processing_tokens_10m >= policy.limits.processingTokensPerTenMinutes) codes.push("processing_10m");
    }
    let turnKnown = false;
    if (state.turn && Number.isSafeInteger(transcript.end_offset)) {
      const turnReason = observeTurn(state, transcript);
      turnKnown = !turnReason;
      if (turnReason) codes.push("turn_unknown");
      else if (Object.keys(state.turn.responses).length >= policy.limits.responsesPerTurn) codes.push("responses_turn");
    } else if (event !== "PreCompact" && !compactRecovery(prompt)) codes.push("turn_unknown");
    if (Number.isFinite(transcript.current_context_tokens) && transcript.current_context_tokens > policy.limits.maxContextTokens) codes.push("context_large");
    if (event === "Stop" && state.turn) state.turn.stop_observed_at = nowSeconds;
    const metrics = {
      quota_status: meterCheck.quotaKnown ? "known" : "unknown",
      host_status: meterCheck.hostKnown ? "known" : "unknown", turn_status: turnKnown ? "known" : "unknown",
      responses_turn: turnKnown ? Object.keys(state.turn.responses).length : null,
      responses_hour: totals?.responses_hour ?? null, processing_tokens_10m: totals?.processing_tokens_10m ?? null,
      context_tokens: Number.isFinite(transcript.current_context_tokens) ? transcript.current_context_tokens : null
    };
    const outcome = reviewOutput(state, event, codes, nowSeconds, metrics);
    if (outcome.changed) {
      recordReview(directory, input.session_id, outcome.record || { episode: state.review?.episode, at: nowSeconds, event, status: "clear", risk_codes: [], metrics });
    }
    return outcome.output;
  });
  return result.status === "known" ? result.value : unverifiedAdvice(event, "turn_unknown", requestedPolicy, "observer-error:" + input.session_id, nowSeconds);
}
// A Read of an image carries the whole base64 body in tool_response, so tool events often exceed MAX_INPUT_BYTES.
// The guard never reads tool bodies; keep only the top-level scalar fields that precede them.
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch"]);
const ENVELOPE_FIELDS = ["hook_event_name", "session_id", "transcript_path", "source", "prompt_source"];
function toolEnvelope(text) {
  const body = text.search(/"(?:tool_input|tool_response|tool_calls|error)"\s*:/);
  const head = body < 0 ? "" : text.slice(0, body);
  const input = {};
  for (const key of ENVELOPE_FIELDS) {
    const match = head.match(new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")'));
    if (match) { try { input[key] = JSON.parse(match[1]); } catch { return undefined; } }
  }
  return typeof input.hook_event_name === "string" && typeof input.session_id === "string" ? input : undefined;
}
function drainStdin() {
  const chunk = Buffer.alloc(64 * 1024);
  try { while (fs.readSync(0, chunk, 0, chunk.length, null)) {} } catch {}
}
function main() {
  const args = process.argv.slice(2); let eventName; let policyFile;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--policy") policyFile = args[++i];
    else if (EVENTS.has(args[i]) && !eventName) eventName = args[i];
    else { process.stdout.write(JSON.stringify(halt(eventName, "훅 인자 확인 불가")) + "\n"); return; }
  }
  const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1); let count = 0;
  while (count < bytes.length) { const read = fs.readSync(0, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
  let input;
  if (count <= MAX_INPUT_BYTES) { try { input = JSON.parse(bytes.toString("utf8", 0, count)); } catch {} }
  else if (TOOL_EVENTS.has(eventName)) { drainStdin(); input = toolEnvelope(bytes.toString("utf8", 0, count)); }
  const output = count > MAX_INPUT_BYTES && !input ? halt(eventName, "훅 입력 크기 제한 초과") : evaluate(input, { eventName, policyFile });
  if (output) process.stdout.write(JSON.stringify(output) + "\n");
}
module.exports = { evaluate, halt, runtimeIdentity, unsupportedEnvironment, loadPolicy, validateMeter, inspectMeter, aggregateCurrent, DEFAULT_LIMITS, MAX_INPUT_BYTES };
if (require.main === module) { try { main(); } catch { process.stdout.write(JSON.stringify(halt(process.argv.find(arg => EVENTS.has(arg)), "관찰기 실행 오류")) + "\n"); } }
