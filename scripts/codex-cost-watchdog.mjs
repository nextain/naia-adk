#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const contracts = require("../.agents/hooks/core/session-contract.js");
const usage = require("./codex-lineage-usage.cjs");

export const DEFAULT_MAX_TOOL_MS = 900_000;

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

export function policyIdentity(policy) {
	return crypto.createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

export function lastOutstandingToolStart(file) {
	const calls = new Map();
	const anonymous = [];
	const scan = usage.scanJsonLines(file, (row) => {
		const type = row?.type === "response_item" ? row.payload?.type : null;
		const timestamp = Date.parse(row?.timestamp);
		if (!type || !Number.isFinite(timestamp)) return;
		const callId = row.payload?.call_id || row.payload?.id || row.payload?.item?.call_id || row.payload?.item?.id || null;
		if (type.endsWith("_call") && !type.endsWith("_call_output")) {
			if (callId) calls.set(callId, timestamp);
			else anonymous.push(timestamp);
		}
		if (type.endsWith("_call_output")) {
			if (callId) calls.delete(callId);
			else if (anonymous.length === 1) anonymous.shift();
		}
	});
	if (scan.malformedLines || scan.malformedTrailingRow) throw new Error("malformed rollout evidence");
	const outstanding = [...calls.values(), ...anonymous];
	return outstanding.length ? Math.min(...outstanding) : null;
}

function readEnvironment(root, pid) {
	try {
		const value = fs.readFileSync(path.join(root, String(pid), "environ"));
		const entry = value.toString().split("\0").find((item) => item.startsWith("CODEX_THREAD_ID="));
		return entry ? entry.slice("CODEX_THREAD_ID=".length) : null;
	} catch { return null; }
}

function processStat(root, pid) {
	try {
		const stat = fs.readFileSync(path.join(root, String(pid), "stat"), "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const parent = Number(fields[1]);
		const startTime = fields[19];
		if (!Number.isSafeInteger(parent) || parent < 0 || !/^\d+$/.test(startTime || "")) return { parentPid: null, startTime: null, ambiguous: true };
		return { parentPid: parent > 1 ? parent : null, startTime, ambiguous: false };
	} catch { return { parentPid: null, startTime: null, ambiguous: true }; }
}

function commandName(root, pid) {
	try { return fs.readFileSync(path.join(root, String(pid), "comm"), "utf8").trim(); } catch { return ""; }
}

function rolloutIds(root, pid) {
	const ids = new Set();
	let malformed = false;
	let current = pid;
	const seen = new Set();
	while (current && !seen.has(current)) {
		seen.add(current);
		let entries;
		try { entries = fs.readdirSync(path.join(root, String(current), "fd")); } catch { malformed = true; break; }
		for (const entry of entries) {
			let target;
			try { target = fs.readlinkSync(path.join(root, String(current), "fd", entry)); } catch { continue; }
			if (!target.endsWith(".jsonl")) continue;
			try {
				const session = usage.readSession(path.resolve(target));
				if (session?.sessionId) ids.add(session.sessionId);
				else malformed = true;
			} catch { malformed = true; }
		}
		const stat = processStat(root, current);
		if (stat.ambiguous) { malformed = true; break; }
		current = stat.parentPid;
	}
	if (current && seen.has(current)) malformed = true;
	return { ids, malformed };
}

export function sessionIdentity({ explicitId = process.env.CODEX_THREAD_ID, procRoot = "/proc", pid = process.pid } = {}) {
	const result = rolloutIds(procRoot, pid);
	const explicit = typeof explicitId === "string" && explicitId.length > 0;
	const claimedId = explicit ? explicitId : result.ids.size === 1 ? [...result.ids][0] : null;
	if (result.malformed || result.ids.size > 1 || (explicit && [...result.ids].some((id) => id !== explicitId))) {
		return { id: null, claimedId, ambiguous: true, source: "failed-closed" };
	}
	if (explicit) return { id: explicitId, claimedId, ambiguous: false, source: "explicit" };
	return { id: claimedId, claimedId, ambiguous: result.ids.size !== 1, source: "linux-ancestors" };
}

export function activeCodexThreads({ procRoot = "/proc" } = {}) {
	let entries;
	try { entries = fs.readdirSync(procRoot, { withFileTypes: true }); } catch { throw new Error("Codex process discovery is unavailable"); }
	const threads = [];
	const ambiguities = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const pid = Number(entry.name);
		if (commandName(procRoot, pid) !== "codex") continue;
		const identity = sessionIdentity({ procRoot, pid, explicitId: readEnvironment(procRoot, pid) });
		const stat = processStat(procRoot, pid);
		if (!identity.ambiguous && identity.id && !stat.ambiguous) threads.push({ sessionId: identity.id, rootPid: pid, processStartTime: stat.startTime });
		else ambiguities.push({ rootPid: pid, claimedSessionId: identity.claimedId || null });
	}
	Object.defineProperty(threads, "ambiguities", { value: ambiguities, enumerable: false });
	return threads;
}

export function loadConfiguredLineages({ projectRoot = process.cwd(), codexHome } = {}) {
	let registry;
	try { registry = JSON.parse(fs.readFileSync(path.join(projectRoot, ".agents", "session-contracts", ".session-map.json"), "utf8")); }
	catch { throw new Error("Configured lineage registry is missing or malformed"); }
	if (!registry || typeof registry !== "object" || Array.isArray(registry) || !registry.bindings || typeof registry.bindings !== "object" || Array.isArray(registry.bindings)) {
		throw new Error("Configured lineage registry is invalid");
	}
	const groups = new Map();
	for (const sessionId of Object.keys(registry.bindings || {})) {
		const resolved = contracts.resolveSessionContract({ cwd: projectRoot, sessionId });
		const policy = resolved.status === contracts.STATES.BOUND ? resolved.contract?.subagent_policy : null;
		if (!policy || contracts.validateSubagentPolicy(policy)) throw new Error(`Configured lineage policy is invalid for ${sessionId}`);
		const identity = policyIdentity(policy);
		const key = `${resolved.contract.id}:${identity}`;
		const group = groups.get(key) || { policy, policyIdentity: identity, sessionIds: [] };
		group.sessionIds.push(sessionId);
		groups.set(key, group);
	}
	const result = new Map();
	for (const group of groups.values()) {
		const collected = usage.collectSessions({ codexHome, since: Date.parse(group.policy.budget_started_at), includeSessionIds: group.sessionIds });
		if (collected.ambiguous) throw new Error("Configured lineage evidence is ambiguous");
		for (const sessionId of group.sessionIds) {
			const lineage = usage.findLineage(collected, sessionId, group.policy);
			if (!lineage || lineage.ambiguous) throw new Error(`Configured lineage is missing or ambiguous for ${sessionId}`);
			result.set(`${lineage.rootId}:${group.policyIdentity}`, { ...lineage, policy: group.policy });
		}
	}
	return [...result.values()];
}

export function selectInterruptions({ threads, lineages, now = Date.now(), maxToolMs = DEFAULT_MAX_TOOL_MS }) {
	if (!Number.isSafeInteger(maxToolMs) || maxToolMs < 60_000) throw new Error("maxToolMs");
	return threads.flatMap((thread) => {
		const lineage = lineages.find((item) => item.rootId !== thread.sessionId && item.members.includes(thread.sessionId));
		if (!lineage || usage.evaluateLineage(lineage, { policy: lineage.policy }).ok) return [];
		const rollout = lineage.sessionRollouts?.[thread.sessionId];
		if (!rollout) return [];
		let outstandingSince = null;
		try {
			outstandingSince = lastOutstandingToolStart(rollout);
		} catch {
			// The lineage is already over budget. Corrupt or concurrently-written
			// rollout evidence must not disable the interrupt path.
		}
		return [{
			...thread,
			rootId: lineage.rootId,
			outstandingMs: outstandingSince === null ? null : now - outstandingSince,
			toolOverdue: outstandingSince !== null && now - outstandingSince >= maxToolMs,
		}];
	});
}

export function processMatchesCandidate(procRoot, candidate) {
	const current = processStat(procRoot, candidate.rootPid);
	if (current.ambiguous || current.startTime !== candidate.processStartTime || commandName(procRoot, candidate.rootPid) !== "codex") return false;
	const identity = sessionIdentity({ procRoot, pid: candidate.rootPid, explicitId: readEnvironment(procRoot, candidate.rootPid) });
	return !identity.ambiguous && identity.id === candidate.sessionId;
}

export function runOnce({ enforce = false, procRoot = "/proc", projectRoot = process.cwd(), codexHome, configuredLineages = null, now = Date.now(), maxToolMs = DEFAULT_MAX_TOOL_MS, signal = (pid) => process.kill(pid, "SIGINT"), processValidator = processMatchesCandidate } = {}) {
	const threads = activeCodexThreads({ procRoot });
	const lineages = configuredLineages || loadConfiguredLineages({ projectRoot, codexHome });
	const governedSessionIds = new Set(lineages.flatMap((lineage) => lineage.members || []));
	const governedAmbiguities = threads.ambiguities.filter((item) => item.claimedSessionId && governedSessionIds.has(item.claimedSessionId));
	if (enforce && governedAmbiguities.length > 0) throw new Error("Governed Codex process identity is ambiguous; enforcement denied");
	const candidates = selectInterruptions({ threads, lineages, now, maxToolMs });
	const interrupted = [];
	if (enforce) for (const candidate of candidates) {
		if (!processValidator(procRoot, candidate)) continue;
		try {
			signal(candidate.rootPid);
			interrupted.push(candidate);
		} catch (error) {
			if (error?.code !== "ESRCH") throw error;
		}
	}
	return { observedAt: new Date(now).toISOString(), enforce, activeThreads: threads.length, ambiguousThreads: threads.ambiguities, configuredLineages: lineages.length, candidates, interrupted };
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(`${JSON.stringify(runOnce({ enforce: process.argv.includes("--enforce") }))}\n`);
