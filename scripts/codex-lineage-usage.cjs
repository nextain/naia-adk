#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const HARD_MAX_CHILDREN = 8;
const READ_CHUNK_BYTES = 256 * 1024;

function parse(line) {
	try { return JSON.parse(line); } catch { return null; }
}

function scanJsonLines(file, visit) {
	const fd = fs.openSync(file, "r");
	const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
	const decoder = new StringDecoder("utf8");
	let carry = "";
	let malformedLines = 0;
	let malformedTrailingRow = false;
	try {
		for (;;) {
			const count = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (!count) break;
			const parts = (carry + decoder.write(buffer.subarray(0, count))).split("\n");
			carry = parts.pop() || "";
			for (const line of parts) {
				const row = parse(line);
				if (row) visit(row);
				else if (line.trim()) malformedLines += 1;
			}
		}
		carry += decoder.end();
		if (carry) {
			const row = parse(carry);
			if (row) visit(row);
			else if (carry.trim()) malformedTrailingRow = true;
		}
	} finally {
		fs.closeSync(fd);
	}
	// A partial concurrent write and permanently truncated evidence are not
	// distinguishable here. Report both so the caller can fail closed.
	return { malformedLines, malformedTrailingRow };
}

function tokenSnapshot(row) {
	if (row?.type !== "event_msg" || row.payload?.type !== "token_count") return undefined;
	const total = row.payload.info?.total_token_usage;
	const last = row.payload.info?.last_token_usage;
	for (const value of [total?.input_tokens, total?.output_tokens, last?.input_tokens, last?.output_tokens]) {
		if (!Number.isSafeInteger(value) || value < 0) return null;
	}
	return { total, last };
}

function promptEvidence(meta) {
	const spawn = meta?.source?.subagent?.thread_spawn;
	for (const key of ["prompt_bytes", "delegated_prompt_bytes"]) {
		if (spawn && Object.prototype.hasOwnProperty.call(spawn, key)) {
			const value = spawn[key];
			return {
				bytes: Number.isSafeInteger(value) && value >= 0 ? value : 0,
				valid: Number.isSafeInteger(value) && value >= 0,
			};
		}
	}
	for (const candidate of [spawn?.prompt, spawn?.message, meta?.spawn_prompt]) {
		if (typeof candidate === "string") return { bytes: Buffer.byteLength(candidate, "utf8"), valid: true };
	}
	return { bytes: 0, valid: false };
}

function promptBytes(meta) {
	return promptEvidence(meta).bytes;
}

function readSession(file) {
	let metadata = null;
	let createdAt = null;
	let firstUsage = null;
	let latestUsage = null;
	let lastTaskStarted = -1;
	let lastTaskComplete = -1;
	let ordinal = 0;
	const scan = scanJsonLines(file, (row) => {
		if (!createdAt && typeof row.timestamp === "string") createdAt = Date.parse(row.timestamp);
		if (!metadata && row.type === "session_meta") metadata = row.payload;
		const usage = tokenSnapshot(row);
		if (usage === null) throw new Error("invalid token_count event");
		if (usage) {
			if (!firstUsage) firstUsage = usage;
			latestUsage = usage;
		}
		if (row.type === "event_msg" && row.payload?.type === "task_started") lastTaskStarted = ordinal;
		if (row.type === "event_msg" && row.payload?.type === "task_complete") lastTaskComplete = ordinal;
		ordinal += 1;
	});
	if (scan.malformedLines > 0) throw new Error("malformed completed JSONL row");
	if (scan.malformedTrailingRow) throw new Error("incomplete trailing JSONL row");
	const id = metadata?.id || metadata?.session_id;
	if (typeof id !== "string" || !id) throw new Error("session metadata is missing an id");
	const spawn = metadata.source?.subagent?.thread_spawn;
	const isSubagent = metadata.thread_source === "subagent" || Boolean(metadata.source?.subagent);
	const delegatedEvidence = promptEvidence(metadata);
	const delegatedEvidenceAmbiguous = isSubagent && !delegatedEvidence.valid;
	if (!firstUsage || !latestUsage || !Number.isFinite(createdAt)) {
		return {
			sessionId: id,
			parentId: metadata.parent_thread_id || spawn?.parent_thread_id || null,
			isSubagent,
			agentPath: metadata.agent_path || spawn?.agent_path || null,
			delegatedPromptBytes: delegatedEvidence.bytes,
			inputTokens: 0,
			outputTokens: 0,
			createdAt: Number.isFinite(createdAt) ? createdAt : Number.POSITIVE_INFINITY,
			finished: false,
			rolloutFile: file,
			ambiguous: true,
		};
	}
	const inheritedInput = Math.max(0, firstUsage.total.input_tokens - firstUsage.last.input_tokens);
	const inheritedOutput = Math.max(0, firstUsage.total.output_tokens - firstUsage.last.output_tokens);
	const ownInput = latestUsage.total.input_tokens - inheritedInput;
	const ownOutput = latestUsage.total.output_tokens - inheritedOutput;
	if (!Number.isSafeInteger(ownInput) || ownInput < 0 || !Number.isSafeInteger(ownOutput) || ownOutput < 0) {
		throw new Error("invalid attributable token usage");
	}
	return {
		sessionId: id,
		parentId: metadata.parent_thread_id || spawn?.parent_thread_id || null,
		isSubagent,
		agentPath: metadata.agent_path || spawn?.agent_path || null,
		delegatedPromptBytes: delegatedEvidence.bytes,
		inputTokens: ownInput,
		outputTokens: ownOutput,
		createdAt,
		finished: lastTaskComplete > lastTaskStarted,
		rolloutFile: file,
		...(delegatedEvidenceAmbiguous ? { ambiguous: true } : {}),
	};
}

function walk(dir, output = [], state = null) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
		if (state) state.ambiguous = true;
		return output;
	}
	for (const entry of entries) {
		const target = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(target, output, state);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(target);
	}
	return output;
}

function collectSessions({
	codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
	since = null,
	includeSessionId = null,
	includeSessionIds = [],
} = {}) {
	const sessions = [];
	const scanState = { ambiguous: false };
	let ambiguous = false;
	const requiredIds = new Set([includeSessionId, ...includeSessionIds].filter(Boolean).map(String));
	for (const file of walk(path.join(codexHome, "sessions"), [], scanState)) {
		const required = [...requiredIds].some((id) => path.basename(file).includes(id));
		if (Number.isFinite(since) && !required) {
			let modifiedAt;
			try { modifiedAt = fs.statSync(file).mtimeMs; } catch { ambiguous = true; continue; }
			if (modifiedAt < since) continue;
		}
		try {
			const session = readSession(file);
			// A selected rollout with metadata but no token snapshots remains
			// attributable as ambiguous, so admission fails closed.
			if (session) sessions.push(session);
		} catch {
			ambiguous = true;
		}
	}
	ambiguous ||= scanState.ambiguous;
	return { sessions, ambiguous };
}

function collectSessionChain({
	codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
	sessionId,
} = {}) {
	if (!sessionId) return { sessions: [], ambiguous: false };
	const scanState = { ambiguous: false };
	const files = walk(path.join(codexHome, "sessions"), [], scanState);
	const sessions = [];
	const seen = new Set();
	let currentId = String(sessionId);
	let ambiguous = scanState.ambiguous;
	while (currentId) {
		if (seen.has(currentId)) return { sessions, ambiguous: true };
		seen.add(currentId);
		const matches = files.filter((file) => path.basename(file).includes(currentId));
		if (matches.length !== 1) return { sessions, ambiguous: matches.length > 0 || sessions.length > 0 };
		let session;
		try { session = readSession(matches[0]); } catch { return { sessions, ambiguous: true }; }
		if (!session || session.sessionId !== currentId) return { sessions, ambiguous: true };
		sessions.push(session);
		currentId = session.parentId;
	}
	return { sessions, ambiguous };
}

function lineageRootId({ sessions, ambiguous = false } = {}, requestedId) {
	if (ambiguous || !requestedId) return null;
	const byId = new Map();
	for (const session of sessions || []) {
		if (!session?.sessionId || byId.has(session.sessionId)) return null;
		byId.set(session.sessionId, session);
	}
	let current = byId.get(requestedId);
	if (!current) return null;
	const seen = new Set();
	while (current.parentId) {
		if (seen.has(current.sessionId)) return null;
		seen.add(current.sessionId);
		current = byId.get(current.parentId);
		if (!current) return null;
	}
	return current.sessionId;
}

function findLineage({ sessions, ambiguous = false }, requestedId, policy) {
	if (!requestedId || !policy) return null;
	const byId = new Map();
	for (const session of sessions) {
		if (byId.has(session.sessionId)) ambiguous = true;
		byId.set(session.sessionId, session);
	}
	const requested = byId.get(requestedId);
	if (!requested) return null;
	const seen = new Set();
	let root = requested;
	while (root.parentId) {
		if (seen.has(root.sessionId)) return null;
		seen.add(root.sessionId);
		root = byId.get(root.parentId);
		if (!root) return null;
	}
	const startedAt = Date.parse(policy.budget_started_at);
	if (!Number.isFinite(startedAt)) return null;
	const lineage = {
		rootId: root.sessionId,
		members: [],
		children: 0,
		activeChildren: 0,
		delegatedPromptBytes: 0,
		// Delegation ceilings cover descendants. The root is recorded
		// separately because its orchestration context is not delegated spend.
		inputTokens: 0,
		outputTokens: 0,
		rootInputTokens: Math.max(0, root.inputTokens - policy.root_input_token_baseline),
		rootOutputTokens: Math.max(0, root.outputTokens - policy.root_output_token_baseline),
		rolloutFiles: [root.rolloutFile],
		sessionRollouts: { [root.sessionId]: root.rolloutFile },
		agents: [],
		ambiguous: ambiguous || Boolean(root.ambiguous),
	};
	for (const session of sessions) {
		let current = session;
		const chain = new Set();
		while (current.parentId && current.sessionId !== root.sessionId) {
			if (chain.has(current.sessionId)) { lineage.ambiguous = true; break; }
			chain.add(current.sessionId);
			current = byId.get(current.parentId);
			if (!current) {
				if (session.createdAt >= startedAt && (session.isSubagent || session.parentId)) lineage.ambiguous = true;
				break;
			}
		}
		if (!current || current.sessionId !== root.sessionId) continue;
		lineage.members.push(session.sessionId);
		if (session.ambiguous) lineage.ambiguous = true;
		if (session.sessionId === root.sessionId || session.createdAt < startedAt) continue;
		lineage.children += 1;
		lineage.inputTokens += session.inputTokens;
		lineage.outputTokens += session.outputTokens;
		lineage.delegatedPromptBytes += session.delegatedPromptBytes;
		lineage.rolloutFiles.push(session.rolloutFile);
		lineage.sessionRollouts[session.sessionId] = session.rolloutFile;
		if (!session.finished) lineage.activeChildren += 1;
		if (session.agentPath) lineage.agents.push(session.agentPath);
	}
	return lineage;
}

function collectLineages(options = {}) {
	const collected = collectSessions(options);
	const policies = options.policies || [];
	return policies.flatMap(({ rootId, policy }) => {
		const lineage = findLineage(collected, rootId, policy);
		return lineage ? [lineage] : [];
	});
}

function evaluateLineage(lineage, { policy, spawningSessionId, pendingPromptBytes = 0 } = {}) {
	const reasons = [];
	if (!lineage || lineage.ambiguous) reasons.push("lineage is missing or ambiguous");
	if (!policy) reasons.push("subagent policy is missing");
	if (!lineage || !policy) return { ok: false, reasons };
	if (!Number.isSafeInteger(policy.max_children) || policy.max_children > HARD_MAX_CHILDREN) reasons.push("hard descendant ceiling is invalid");
	if (spawningSessionId !== undefined && lineage.rootId !== spawningSessionId) reasons.push("only the bound root session may spawn");
	if (lineage.children >= policy.max_children) reasons.push("descendant ceiling exceeded");
	if (lineage.activeChildren >= policy.max_active_children) reasons.push("active descendant ceiling exceeded");
	if (pendingPromptBytes > policy.max_prompt_bytes) reasons.push("prompt byte ceiling exceeded");
	if (lineage.delegatedPromptBytes + pendingPromptBytes > policy.max_delegated_prompt_bytes) reasons.push("cumulative prompt ceiling exceeded");
	if (lineage.inputTokens >= policy.max_input_tokens) reasons.push("input token ceiling exceeded");
	if (lineage.outputTokens >= policy.max_output_tokens) reasons.push("output token ceiling exceeded");
	return { ok: reasons.length === 0, reasons };
}

function reserveLineageSpawn(lineage, policy, tmpRoot, pendingPromptBytes = 0) {
	if (!lineage || !policy || !Number.isSafeInteger(pendingPromptBytes) || pendingPromptBytes < 0) return { ok: false, kind: "counter" };
	if (!Number.isSafeInteger(policy.max_children) || policy.max_children > HARD_MAX_CHILDREN) return { ok: false, kind: "budget" };
	const root = String(lineage.rootId).replace(/[^\w.-]/g, "_");
	const policyKey = String(policy.budget_started_at).replace(/[^\w.-]/g, "_");
	const durableRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "adk-subagent-budget");
	const target = path.join(tmpRoot || durableRoot, `${root}-${policyKey}.json`);
	const lock = `${target}.lock`;
	let fd = null;
	let temporary = null;
	let temporaryFd = null;
	let directoryFd = null;
	try {
		const directory = path.dirname(target);
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		fs.chmodSync(directory, 0o700);
		fd = fs.openSync(lock, "wx");
		let state = { admitted: 0, promptBytes: 0 };
		if (fs.existsSync(target)) state = JSON.parse(fs.readFileSync(target, "utf8"));
		if (!Number.isSafeInteger(state.admitted) || state.admitted < 0 || !Number.isSafeInteger(state.promptBytes) || state.promptBytes < 0) throw new Error("counter");
		const used = Math.max(state.admitted, lineage.children);
		const pendingActive = Math.max(0, used - lineage.children);
		const active = lineage.activeChildren + pendingActive;
		const bytes = Math.max(state.promptBytes, lineage.delegatedPromptBytes) + pendingPromptBytes;
		if (used >= policy.max_children || active >= policy.max_active_children || bytes > policy.max_delegated_prompt_bytes) return { ok: false, kind: "budget" };
		temporary = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify({ admitted: used + 1, promptBytes: bytes }), { mode: 0o600 });
		temporaryFd = fs.openSync(temporary, "r");
		fs.fsyncSync(temporaryFd);
		fs.closeSync(temporaryFd);
		temporaryFd = null;
		fs.renameSync(temporary, target);
		temporary = null;
		directoryFd = fs.openSync(directory, "r");
		fs.fsyncSync(directoryFd);
		fs.closeSync(directoryFd);
		directoryFd = null;
		return { ok: true, used: used + 1, promptBytes: bytes };
	} catch {
		return { ok: false, kind: "counter" };
	} finally {
		if (temporaryFd !== null) {
			try { fs.closeSync(temporaryFd); } catch {}
		}
		if (directoryFd !== null) {
			try { fs.closeSync(directoryFd); } catch {}
		}
		if (temporary) {
			try { fs.unlinkSync(temporary); } catch {}
		}
		if (fd !== null) {
			try { fs.closeSync(fd); } finally {
				try { fs.unlinkSync(lock); } catch {}
			}
		}
	}
}

if (require.main === module) process.stdout.write(`${JSON.stringify(collectSessions())}\n`);

module.exports = {
	HARD_MAX_CHILDREN,
	collectLineages,
	collectSessionChain,
	collectSessions,
	evaluateLineage,
	findLineage,
	lineageRootId,
	readSession,
	reserveLineageSpawn,
	scanJsonLines,
};
