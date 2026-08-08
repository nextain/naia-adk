import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { lastOutstandingToolStart, loadConfiguredLineages, policyIdentity, processMatchesCandidate, runOnce, selectInterruptions, sessionIdentity } from "./codex-cost-watchdog.mjs";

const require = createRequire(import.meta.url);
const usage = require("./codex-lineage-usage.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
const procRoot = path.join(root, "proc");
const rollout = path.join(root, "rollout-child.jsonl");
const procStat = (pid, startTime) => `${pid} (codex) ${["S", "1", ...Array(17).fill("0"), String(startTime)].join(" ")}`;
fs.mkdirSync(path.join(procRoot, "100", "fd"), { recursive: true });
fs.writeFileSync(rollout, [
	JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "child", parent_thread_id: "root", source: { subagent: { thread_spawn: {} } } } }),
	JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1_000, output_tokens: 20 }, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } }),
	JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 256_999, output_tokens: 20 }, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } }),
	JSON.stringify({ timestamp: "2026-01-01T00:00:03.000Z", type: "response_item", payload: { type: "custom_tool_call" } }),
].join("\n"));
fs.symlinkSync(rollout, path.join(procRoot, "100", "fd", "9"));
fs.writeFileSync(path.join(procRoot, "100", "environ"), "CODEX_THREAD_ID=child\0");
fs.writeFileSync(path.join(procRoot, "100", "stat"), procStat(100, 12345));
fs.writeFileSync(path.join(procRoot, "100", "comm"), "codex\n");

const policy = {
	profile: "balanced", context_mode: "isolated", budget_started_at: "2026-01-01T00:00:00Z",
	root_input_token_baseline: 0, root_output_token_baseline: 0, max_children: 4, max_active_children: 2,
	max_prompt_bytes: 16_384, max_delegated_prompt_bytes: 65_536, max_input_tokens: 256_000, max_output_tokens: 32_000,
};
assert.equal(policyIdentity(policy),policyIdentity({...policy}),"policy identity must be deterministic");
assert.notEqual(policyIdentity(policy),policyIdentity({...policy,max_children:3}),"different ceilings must not share a lineage group");
const lineage = {
	rootId: "root", members: ["root", "child"], children: 1, activeChildren: 1,
	delegatedPromptBytes: 20, inputTokens: 256_000, outputTokens: 1, ambiguous: false,
	sessionRollouts: { child: rollout }, policy,
};
const now = Date.parse("2026-01-01T01:00:03.000Z");

assert.equal(sessionIdentity({ explicitId: "child", procRoot, pid: 100 }).id, "child");
assert.equal(sessionIdentity({ explicitId: "wrong", procRoot, pid: 100 }).ambiguous, true);
const malformedIdentityRollout = path.join(root, "malformed-identity.jsonl");
fs.writeFileSync(malformedIdentityRollout, "{broken\n");
fs.symlinkSync(malformedIdentityRollout, path.join(procRoot, "100", "fd", "10"));
assert.equal(sessionIdentity({ explicitId: "child", procRoot, pid: 100 }).ambiguous, true, "malformed rollout identity evidence must fail closed even with an explicit ID");
fs.unlinkSync(path.join(procRoot, "100", "fd", "10"));
assert.equal(lastOutstandingToolStart(rollout), Date.parse("2026-01-01T00:00:03.000Z"));
const childUsage = usage.readSession(rollout);
assert.equal(childUsage.inputTokens, 256_000, "a child's inherited total must not be counted twice");
assert.equal(childUsage.ambiguous, true, "a descendant without delegated prompt evidence must fail closed");

const pendingRollout = path.join(root, "rollout-pending.jsonl");
fs.writeFileSync(pendingRollout, JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "pending", parent_thread_id: "root", source: { subagent: { thread_spawn: {} } } } }));
const pending = usage.readSession(pendingRollout);
assert.equal(pending.ambiguous, true, "metadata without attributable usage must fail closed");
assert.equal(usage.findLineage({ sessions: [{ sessionId: "root", parentId: null, createdAt: 0, inputTokens: 0, outputTokens: 0, rolloutFile: "root" }, pending], ambiguous: false }, "root", policy).ambiguous, true);

const corruptRollout = path.join(root, "rollout-corrupt.jsonl");
fs.writeFileSync(corruptRollout, `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "corrupt" } })}\n{broken}\n`);
assert.throws(() => usage.readSession(corruptRollout), /malformed completed JSONL row/);
const truncatedRollout = path.join(root, "rollout-truncated.jsonl");
fs.writeFileSync(truncatedRollout, `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "truncated" } })}\n{\"type\":`);
assert.throws(() => usage.readSession(truncatedRollout), /incomplete trailing JSONL row/);
const invalidTokenRollout = path.join(root, "rollout-invalid-token.jsonl");
fs.writeFileSync(invalidTokenRollout, [
	JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "invalid-token" } }),
	JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: {} } }),
].join("\n"));
assert.throws(() => usage.readSession(invalidTokenRollout), /invalid token_count event/);
const missingMetadataRollout = path.join(root, "rollout-missing-metadata.jsonl");
fs.writeFileSync(missingMetadataRollout, JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "note" } }));
assert.throws(() => usage.readSession(missingMetadataRollout), /session metadata is missing an id/);
const missingParent = usage.findLineage({ sessions: [
	{ sessionId: "root", parentId: null, createdAt: 0, inputTokens: 0, outputTokens: 0, rolloutFile: "root" },
	{ sessionId: "orphan", parentId: "missing", isSubagent: true, createdAt: Date.parse(policy.budget_started_at), inputTokens: 1, outputTokens: 1, rolloutFile: "orphan" },
], ambiguous: false }, "root", policy);
assert.equal(missingParent.ambiguous, true, "recent unattributable descendants must fail closed");

const budgetRoot = path.join(root, "budget");
const reservable = { ...lineage, children: 0, activeChildren: 0, delegatedPromptBytes: 0 };
const originalFsync = fs.fsyncSync;
let fsyncCount = 0;
fs.fsyncSync = (descriptor) => { fsyncCount += 1; return originalFsync(descriptor); };
assert.equal(usage.reserveLineageSpawn(reservable, policy, budgetRoot, 1).ok, true);
fs.fsyncSync = originalFsync;
assert.equal(fsyncCount, 2, "admission must fsync the state file and containing directory");
assert.equal(fs.statSync(budgetRoot).mode & 0o077, 0, "admission state directory must remain private");
assert.equal(usage.reserveLineageSpawn(reservable, policy, budgetRoot, 1).ok, true);
assert.equal(usage.reserveLineageSpawn(reservable, policy, budgetRoot, 1).ok, false, "pending admissions must consume active capacity");
const heldLock = path.join(budgetRoot, `locked-${policy.budget_started_at.replace(/[^\w.-]/g, "_")}.json.lock`);
fs.writeFileSync(heldLock, "held");
assert.equal(usage.reserveLineageSpawn({ ...reservable, rootId: "locked" }, policy, budgetRoot, 1).ok, false);
assert.equal(fs.existsSync(heldLock), true, "a failed contender must not remove another process's lock");
assert.equal(usage.evaluateLineage(reservable, { policy: { ...policy, max_children: usage.HARD_MAX_CHILDREN + 1 } }).ok, false, "runtime admission must enforce the hard child ceiling");

const correlatedRollout = path.join(root, "rollout-correlated.jsonl");
fs.writeFileSync(correlatedRollout, [
	JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "old" } }),
	JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "new" } }),
	JSON.stringify({ timestamp: "2026-01-01T00:00:03.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "new" } }),
].join("\n"));
assert.equal(lastOutstandingToolStart(correlatedRollout), Date.parse("2026-01-01T00:00:01.000Z"), "a newer output must not mask an older outstanding call");
const longRollout = path.join(root, "rollout-long.jsonl");
fs.writeFileSync(longRollout, [
	JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "far" } }),
	JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", type: "event_msg", payload: { type: "note", text: "x".repeat(1_100_000) } }),
].join("\n"));
assert.equal(lastOutstandingToolStart(longRollout), Date.parse("2026-01-01T00:00:01.000Z"), "tool correlation must not lose calls outside a fixed-size tail");
assert.deepEqual(selectInterruptions({ threads: [{ sessionId: "root", rootPid: 1 }], lineages: [lineage], now, maxToolMs: 60_000 }), []);
assert.equal(selectInterruptions({ threads: [{ sessionId: "child", rootPid: 100 }], lineages: [lineage], now, maxToolMs: 60_000 })[0].sessionId, "child");
const noCallRollout = path.join(root, "rollout-no-call.jsonl");
fs.writeFileSync(noCallRollout, JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "quiet-child" } }));
const noCallLineage = { ...lineage, members: ["root", "quiet-child"], sessionRollouts: { "quiet-child": noCallRollout } };
assert.equal(selectInterruptions({ threads: [{ sessionId: "quiet-child", rootPid: 101 }], lineages: [noCallLineage], now, maxToolMs: 60_000 })[0].sessionId, "quiet-child", "an over-budget descendant must be interrupted even without an outstanding tool");
const malformedLineage = { ...lineage, members: ["root", "malformed-child"], sessionRollouts: { "malformed-child": corruptRollout } };
assert.equal(selectInterruptions({ threads: [{ sessionId: "malformed-child", rootPid: 102 }], lineages: [malformedLineage], now, maxToolMs: 60_000 })[0].sessionId, "malformed-child", "malformed rollout evidence must not disable an over-budget interrupt");
assert.throws(() => selectInterruptions({ threads: [], lineages: [], maxToolMs: 1 }), /maxToolMs/);

fs.mkdirSync(path.join(procRoot, "101", "fd"), { recursive: true });
fs.symlinkSync(rollout, path.join(procRoot, "101", "fd", "9"));
fs.writeFileSync(path.join(procRoot, "101", "environ"), "CODEX_THREAD_ID=child\0");
fs.writeFileSync(path.join(procRoot, "101", "stat"), procStat(101, 67890));
fs.writeFileSync(path.join(procRoot, "101", "comm"), "codex\n");
const signaled = [];
const result = runOnce({ procRoot, configuredLineages: [lineage], now, maxToolMs: 60_000, enforce: true, signal: (pid) => { signaled.push(pid); } });
assert.deepEqual(signaled.sort(), [100, 101], "every verified process for an over-budget descendant must be interrupted");
assert.equal(result.interrupted.length, 2);
assert.equal(processMatchesCandidate(procRoot,{sessionId:"child",rootPid:100,processStartTime:"12345"}),true);
assert.equal(processMatchesCandidate(procRoot,{sessionId:"wrong",rootPid:100,processStartTime:"12345"}),false);
assert.equal(runOnce({ procRoot, configuredLineages: [lineage], now, maxToolMs: 60_000, enforce: true, processValidator: () => false, signal: () => { throw new Error("must not signal"); } }).interrupted.length,0,"failed immediate revalidation must suppress SIGINT");
const denied = Object.assign(new Error("denied"), { code: "EPERM" });
assert.throws(() => runOnce({ procRoot, configuredLineages: [lineage], now, maxToolMs: 60_000, enforce: true, signal: () => { throw denied; } }), /denied/, "non-ESRCH signal failures must fail enforcement");
const exited = Object.assign(new Error("gone"), { code: "ESRCH" });
assert.equal(runOnce({ procRoot, configuredLineages: [lineage], now, maxToolMs: 60_000, enforce: true, signal: () => { throw exited; } }).interrupted.length, 0, "an exited-process race may be ignored");

const missingRegistryRoot = path.join(root, "missing-registry");
assert.throws(() => loadConfiguredLineages({ projectRoot: missingRegistryRoot, codexHome: root }), /registry is missing or malformed/);
const malformedRegistryRoot = path.join(root, "malformed-registry");
fs.mkdirSync(path.join(malformedRegistryRoot, ".agents", "session-contracts"), { recursive: true });
fs.writeFileSync(path.join(malformedRegistryRoot, ".agents", "session-contracts", ".session-map.json"), "{broken");
assert.throws(() => loadConfiguredLineages({ projectRoot: malformedRegistryRoot, codexHome: root }), /registry is missing or malformed/);
fs.writeFileSync(path.join(malformedRegistryRoot, ".agents", "session-contracts", ".session-map.json"), JSON.stringify({ bindings: {} }));
assert.deepEqual(loadConfiguredLineages({ projectRoot: malformedRegistryRoot, codexHome: root }), []);

assert.throws(() => runOnce({ procRoot: path.join(root, "missing-proc"), configuredLineages: [], enforce: true }), /process discovery is unavailable/);
fs.mkdirSync(path.join(procRoot, "102", "fd"), { recursive: true });
fs.writeFileSync(path.join(procRoot, "102", "comm"), "codex\n");
assert.equal(runOnce({ procRoot, configuredLineages: [lineage], enforce: true, signal: () => {} }).ambiguousThreads.length, 1, "unattributed ambiguity must remain visible without blocking an unrelated governed lineage");
fs.writeFileSync(path.join(procRoot, "102", "environ"), "CODEX_THREAD_ID=child\0");
assert.throws(() => runOnce({ procRoot, configuredLineages: [lineage], enforce: true }), /process identity is ambiguous/);

fs.rmSync(root, { recursive: true, force: true });
console.log("Codex cost watchdog tests passed");
