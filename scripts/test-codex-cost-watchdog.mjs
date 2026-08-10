import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { activeCodexThreads, ensureWatchdog, lastOutstandingToolStart, loadConfiguredLineages, policyIdentity, processMatchesCandidate, runOnce, selectInterruptions, sessionIdentity, watchdogProjectRoot, watchLoop } from "./codex-cost-watchdog.mjs";

const require = createRequire(import.meta.url);
const usage = require("./codex-lineage-usage.cjs");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-project-root-"));
try {
	assert.equal(
		watchdogProjectRoot({ cwd: scratch, env: { ADK_PROJECT_ROOT: repositoryRoot } }),
		fs.realpathSync(repositoryRoot),
		"the watchdog must retain its governed root from scratch cwd",
	);
	assert.throws(
		() => watchdogProjectRoot({ cwd: scratch, env: { ADK_PROJECT_ROOT: "." } }),
		/ADK_PROJECT_ROOT must be absolute/,
	);
	const impostor = path.join(scratch, "impostor");
	fs.mkdirSync(path.join(impostor, ".agents", "context"), { recursive: true });
	fs.mkdirSync(path.join(impostor, ".codex"), { recursive: true });
	fs.writeFileSync(path.join(impostor, ".agents", "context", "agents-rules.json"), "{}");
	fs.writeFileSync(path.join(impostor, ".codex", "hooks.json"), "{}");
	assert.throws(
		() => watchdogProjectRoot({ cwd: scratch, env: { ADK_PROJECT_ROOT: impostor } }),
		/does not match the installed ADK harness/,
		"an arbitrary marker directory must not impersonate the installed harness",
	);
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
const procRoot = path.join(root, "proc");
const rollout = path.join(root, "rollout-child.jsonl");
const procStat = (pid, startTime, parentPid = 1) => `${pid} (codex) ${["S", String(parentPid), ...Array(17).fill("0"), String(startTime)].join(" ")}`;
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
	maximum_risk: "medium",
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
const preBudgetSessions = { sessions: [
	{ sessionId: "root", parentId: null, createdAt: 0, inputTokens: 0, outputTokens: 0, rolloutFile: "root" },
	{ sessionId: "active-before-budget", parentId: "root", isSubagent: true, createdAt: Date.parse(policy.budget_started_at) - 1, inputTokens: 50, outputTokens: 5, delegatedPromptBytes: 10, finished: false, rolloutFile: "active" },
	{ sessionId: "finished-before-budget", parentId: "root", isSubagent: true, createdAt: Date.parse(policy.budget_started_at) - 1, inputTokens: 70, outputTokens: 7, delegatedPromptBytes: 20, finished: true, rolloutFile: "finished" },
] };
const preBudgetLineage = usage.findLineage(preBudgetSessions, "root", policy);
assert.equal(preBudgetLineage.children, 2, "completed descendants must remain in the root's lifetime budget");
assert.equal(preBudgetLineage.activeChildren, 1);
assert.equal(preBudgetLineage.inputTokens, 120, "all attributable descendant usage is counted for the root lifetime");
assert.equal(preBudgetLineage.outputTokens, 12);
assert.equal(preBudgetLineage.delegatedPromptBytes, 30);

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
assert.equal(missingParent.ambiguous, false, "an unrelated missing-parent session must not disable the selected lineage");
assert.equal(missingParent.members.includes("orphan"), false);
const damagedDescendant = usage.findLineage({ sessions: [
	{ sessionId: "root", parentId: null, createdAt: 0, inputTokens: 0, outputTokens: 0, rolloutFile: "root" },
	{ sessionId: "damaged", parentId: "root", isSubagent: true, createdAt: Date.parse(policy.budget_started_at), inputTokens: 0, outputTokens: 0, finished: false, rolloutFile: "damaged", ambiguous: true },
], ambiguous: false }, "root", policy);
assert.equal(damagedDescendant.ambiguous, true, "damaged evidence still fails closed when it belongs to the selected lineage");

const oldHome = path.join(root, "old-codex-home");
const oldSessions = path.join(oldHome, "sessions");
fs.mkdirSync(oldSessions, { recursive: true });
const oldActive = path.join(oldSessions, "rollout-active-before-budget.jsonl");
fs.writeFileSync(oldActive, [
	JSON.stringify({ timestamp: "2025-12-31T23:59:00.000Z", type: "session_meta", payload: { id: "active-before-budget", parent_thread_id: "root", source: { subagent: { thread_spawn: { prompt_bytes: 1 } } } } }),
	JSON.stringify({ timestamp: "2025-12-31T23:59:01.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 1 }, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } }),
].join("\n"));
fs.utimesSync(oldActive, new Date("2025-12-31T23:59:02.000Z"), new Date("2025-12-31T23:59:02.000Z"));
usage.clearSessionCache();
const oldCollected = usage.collectSessions({ codexHome: oldHome, since: Date.parse(policy.budget_started_at) });
assert.equal(oldCollected.sessions.some((session) => session.sessionId === "active-before-budget"), true, "mtime filtering must not hide an active pre-budget descendant");
const firstCacheStats = usage.sessionCacheStats();
usage.collectSessions({ codexHome: oldHome });
const reusedCacheStats = usage.sessionCacheStats();
assert.equal(reusedCacheStats.misses, firstCacheStats.misses, "an unchanged rollout must not be reparsed on every watchdog poll");
assert.ok(reusedCacheStats.hits > firstCacheStats.hits, "an unchanged rollout must use cached attribution");
fs.appendFileSync(oldActive, `\n${JSON.stringify({ timestamp: "2025-12-31T23:59:03.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 2, output_tokens: 1 }, last_token_usage: { input_tokens: 1, output_tokens: 0 } } } })}`);
const changedCollected = usage.collectSessions({ codexHome: oldHome });
assert.ok(usage.sessionCacheStats().misses > reusedCacheStats.misses, "a changed rollout must invalidate cached attribution");
assert.equal(changedCollected.sessions.find((session) => session.sessionId === "active-before-budget")?.inputTokens, 2);

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
const epochLineage = { ...reservable, rootId: "epoch-pinned" };
assert.equal(usage.reserveLineageSpawn(epochLineage, policy, budgetRoot, 1).ok, true);
assert.equal(usage.reserveLineageSpawn(epochLineage, { ...policy, budget_started_at: "2026-02-01T00:00:00Z" }, budgetRoot, 1).ok, false, "changing a policy epoch must not reset root admission accounting");
const heldLock = path.join(budgetRoot, "locked.json.lock");
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
fs.mkdirSync(path.join(procRoot, "103", "fd"), { recursive: true });
fs.symlinkSync(rollout, path.join(procRoot, "103", "fd", "9"));
fs.writeFileSync(path.join(procRoot, "103", "environ"), "CODEX_THREAD_ID=child\0");
fs.writeFileSync(path.join(procRoot, "103", "stat"), procStat(103, 24680, 100));
fs.writeFileSync(path.join(procRoot, "103", "comm"), "node\n");
const nonCodexSessionHost = activeCodexThreads({ procRoot }).find((thread) => thread.rootPid === 103);
assert.equal(nonCodexSessionHost?.sessionId, "child", "a descendant session host with direct rollout evidence must not evade discovery because of comm");
assert.equal(processMatchesCandidate(procRoot, nonCodexSessionHost), true, "a non-Codex-named host must retain exact PID, start-time, environment, and rollout revalidation");
assert.equal(runOnce({ procRoot, configuredLineages: [lineage], now, maxToolMs: 60_000, enforce: true, processValidator: () => false, signal: () => { throw new Error("must not signal"); } }).interrupted.length,0,"failed immediate revalidation must suppress SIGINT");
const denied = Object.assign(new Error("denied"), { code: "EPERM" });
assert.throws(() => runOnce({ procRoot, configuredLineages: [lineage], now, maxToolMs: 60_000, enforce: true, signal: () => { throw denied; } }), /denied/, "non-ESRCH signal failures must fail enforcement");
const exited = Object.assign(new Error("gone"), { code: "ESRCH" });
assert.equal(runOnce({ procRoot, configuredLineages: [lineage], now, maxToolMs: 60_000, enforce: true, signal: () => { throw exited; } }).interrupted.length, 0, "an exited-process race may be ignored");
let watchRuns = 0;
const watched = await watchLoop({
	run: () => ({ observedAt: new Date().toISOString(), sequence: ++watchRuns }),
	intervalMs: 250,
	iterations: 2,
});
assert.equal(watchRuns, 2, "persistent mode must continue enforcing after the initial boundary");
assert.equal(watched.sequence, 2);
const failureReceipt = path.join(root, "watchdog-failure.json");
let failureRuns = 0;
await assert.rejects(watchLoop({
	run: () => { failureRuns += 1; throw new Error("persistent failure"); },
	intervalMs: 250,
	iterations: 2,
	receiptFile: failureReceipt,
}), /persistent failure/);
assert.equal(failureRuns, 1, "an enforcement failure must terminate the watcher immediately");
assert.equal(JSON.parse(fs.readFileSync(failureReceipt, "utf8")).ok, false);

const watchdogHome = path.join(root, "watchdog-home");
const spawnCalls = [];
let unrefCalled = false;
const ensured = ensureWatchdog({
	projectRoot: repositoryRoot,
	codexHome: watchdogHome,
	spawnProcess: (...args) => {
		spawnCalls.push(args);
		const stateFile = args[1][args[1].indexOf("--state-file") + 1];
		fs.writeFileSync(`${stateFile}.receipt`, JSON.stringify({
			pid: 4242,
			projectRoot: fs.realpathSync(repositoryRoot),
			scriptFile: fs.realpathSync(args[1][0]),
			observedAt: new Date().toISOString(),
			ok: true,
		}));
		return { pid: 4242, unref: () => { unrefCalled = true; } };
	},
	processValidator: () => false,
});
assert.equal(ensured.started, true);
assert.equal(unrefCalled, true);
assert.equal(spawnCalls.length, 1, "one lock owner may start the persistent watcher");
assert.ok(spawnCalls[0][1].includes("--watch"));
assert.equal(JSON.parse(fs.readFileSync(ensured.stateFile, "utf8")).pid, 4242);
const stalledState = { pid: 4242, projectRoot: fs.realpathSync(repositoryRoot), scriptFile: fs.realpathSync(path.join(repositoryRoot, "scripts", "codex-cost-watchdog.mjs")) };
fs.writeFileSync(ensured.stateFile, JSON.stringify(stalledState));
fs.writeFileSync(`${ensured.stateFile}.receipt`, JSON.stringify({ ...stalledState, observedAt: new Date(Date.now() - 60_000).toISOString(), ok: true }));
let replacementCalls = 0;
let stalledWatcherAlive = true;
const killedWatchers = [];
const replaced = ensureWatchdog({
	projectRoot: repositoryRoot,
	codexHome: watchdogHome,
	spawnProcess: (...args) => {
		replacementCalls += 1;
		const stateFile = args[1][args[1].indexOf("--state-file") + 1];
		fs.writeFileSync(`${stateFile}.receipt`, JSON.stringify({
			pid: 4243,
			projectRoot: fs.realpathSync(repositoryRoot),
			scriptFile: fs.realpathSync(args[1][0]),
			observedAt: new Date().toISOString(),
			ok: true,
		}));
		return { pid: 4243, unref: () => {} };
	},
	processValidator: () => stalledWatcherAlive,
	processKiller: (pid, signal) => {
		killedWatchers.push([pid, signal]);
		stalledWatcherAlive = false;
	},
	heartbeatWaitMs: 1,
});
assert.equal(replacementCalls, 1, "an alive but stalled watcher must be replaced");
assert.deepEqual(killedWatchers, [[4242, "SIGTERM"]], "replacement must first stop the verified stale watcher");
assert.equal(replaced.started, true);
fs.writeFileSync(ensured.stateFile, JSON.stringify(stalledState));
fs.writeFileSync(`${ensured.stateFile}.receipt`, "{malformed");
assert.throws(() => ensureWatchdog({
	projectRoot: repositoryRoot,
	codexHome: watchdogHome,
	spawnProcess: () => { throw new Error("malformed receipt must not admit the watcher"); },
	processValidator: () => false,
	heartbeatWaitMs: 1,
}), /malformed receipt must not admit the watcher/);
assert.throws(
	() => ensureWatchdog({ projectRoot: repositoryRoot, codexHome: watchdogHome, platform: "win32" }),
	/requires Linux process identity enforcement/,
	"unsupported process identity platforms must fail closed",
);
try { fs.unlinkSync(ensured.stateFile); } catch (error) { assert.equal(error.code, "ENOENT"); }
fs.writeFileSync(`${ensured.stateFile}.lock`, "held");
assert.equal(ensureWatchdog({
	projectRoot: repositoryRoot,
	codexHome: watchdogHome,
	spawnProcess: () => { throw new Error("a lock contender must not spawn"); },
}).reason, "startup_in_progress");

const missingRegistryRoot = path.join(root, "missing-registry");
assert.deepEqual(
	loadConfiguredLineages({ projectRoot: missingRegistryRoot, codexHome: root }),
	[],
	"a fresh checkout with no host-local registry yet has no configured lineages, not a failure",
);
const malformedRegistryRoot = path.join(root, "malformed-registry");
fs.mkdirSync(path.join(malformedRegistryRoot, ".agents", "session-contracts"), { recursive: true });
fs.writeFileSync(path.join(malformedRegistryRoot, ".agents", "session-contracts", ".session-map.json"), "{broken");
assert.throws(() => loadConfiguredLineages({ projectRoot: malformedRegistryRoot, codexHome: root }), /registry is missing or malformed/);
fs.writeFileSync(path.join(malformedRegistryRoot, ".agents", "session-contracts", ".session-map.json"), JSON.stringify({ bindings: {} }));
assert.deepEqual(loadConfiguredLineages({ projectRoot: malformedRegistryRoot, codexHome: root }), []);
fs.writeFileSync(path.join(malformedRegistryRoot, ".agents", "session-contracts", ".session-map.json"), JSON.stringify({ bindings: {
  unbound: { contract_id: "unbound" },
  ordinary: { contract_id: "ordinary" },
  governed: { contract_id: "governed" },
} }));
const ordinaryContractResolver = ({ sessionId }) => sessionId === "unbound"
  ? { status: "UNBOUND" }
  : { status: "BOUND", contract: { id: sessionId } };
assert.throws(
	() => loadConfiguredLineages({ projectRoot: malformedRegistryRoot, codexHome: root, contractResolver: ordinaryContractResolver }),
	/not bound for unbound/,
	"a registry binding that cannot resolve must fail closed",
);
fs.writeFileSync(path.join(malformedRegistryRoot, ".agents", "session-contracts", ".session-map.json"), JSON.stringify({ bindings: {
  ordinary: { contract_id: "ordinary" },
  governed: { contract_id: "governed" },
} }));
assert.deepEqual(loadConfiguredLineages({ projectRoot: malformedRegistryRoot, codexHome: root, contractResolver: ordinaryContractResolver }), [], "ordinary bound contracts without an explicit policy are not governed lineages");
assert.throws(() => loadConfiguredLineages({
  projectRoot: malformedRegistryRoot,
  codexHome: root,
  contractResolver: ({ sessionId }) => ({ status: "BOUND", contract: sessionId === "governed" ? { id: sessionId, subagent_policy: {} } : { id: sessionId } }),
}), /subagent_policy is invalid/, "an explicitly declared malformed policy must fail closed");

// Process-to-session attribution must stay O(1) in transcript size: a full parse
// here made activeCodexThreads take seconds on a host with large rollouts, so the
// watchdog could not publish its first heartbeat inside the startup budget.
assert.equal(usage.readSessionId(rollout).sessionId, "child", "identity comes from the session_meta row");
assert.equal(usage.readSessionId(rollout).malformed, false);
const hugeRollout = path.join(root, "rollout-huge.jsonl");
fs.writeFileSync(hugeRollout, [
	JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "huge" } }),
	`${JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "filler", blob: "x".repeat(512 * 1024) } })}\n`,
].join("\n"));
assert.equal(usage.readSessionId(hugeRollout).sessionId, "huge", "identity must not depend on reading the whole transcript");
// A rollout being appended to always ends in a partial row; that is not corruption.
const appendingRollout = path.join(root, "rollout-appending.jsonl");
fs.writeFileSync(appendingRollout, `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "appending" } })}\n{"type":"event_ms`);
assert.equal(usage.readSessionId(appendingRollout).sessionId, "appending", "a live trailing write must not hide a resolved identity");
// Corrupt evidence at the head is indistinguishable from a truncated write: fail closed.
assert.equal(usage.readSessionId(corruptRollout).malformed, false, "a valid session_meta ahead of later corruption still identifies the session");
const headCorruptRollout = path.join(root, "rollout-head-corrupt.jsonl");
fs.writeFileSync(headCorruptRollout, `{broken\n${JSON.stringify({ type: "session_meta", payload: { id: "unreachable" } })}\n`);
assert.deepEqual(usage.readSessionId(headCorruptRollout), { sessionId: null, malformed: true }, "corrupt evidence before session_meta must fail closed");
assert.deepEqual(usage.readSessionId(missingMetadataRollout), { sessionId: null, malformed: true }, "a rollout without an id must fail closed");
assert.equal(usage.readSessionId(path.join(root, "does-not-exist.jsonl")).malformed, true, "an unreadable rollout must fail closed");

assert.throws(() => runOnce({ procRoot: path.join(root, "missing-proc"), configuredLineages: [], enforce: true }), /process discovery is unavailable/);
fs.mkdirSync(path.join(procRoot, "102", "fd"), { recursive: true });
fs.writeFileSync(path.join(procRoot, "102", "comm"), "codex\n");
assert.equal(runOnce({ procRoot, configuredLineages: [lineage], enforce: true, signal: () => {} }).ambiguousThreads.length, 1, "unattributed ambiguity must remain visible without blocking an unrelated governed lineage");
fs.writeFileSync(path.join(procRoot, "102", "environ"), "CODEX_THREAD_ID=child\0");
assert.throws(() => runOnce({ procRoot, configuredLineages: [lineage], enforce: true }), /process identity is ambiguous/);

fs.rmSync(root, { recursive: true, force: true });
console.log("Codex cost watchdog tests passed");
