#!/usr/bin/env node
/**
 * Session baseline gate — deterministic "read your contract before you act".
 *
 * Why this exists: compaction rewrites the transcript with a lossy recap, and
 * the recap wins the model's attention over the durable intent on disk. On
 * 2026-09-02 a session resumed from a recap, never re-opened its progress or
 * memory files, and spent hours porting the wrong thing (two broken upstream
 * pushes). The advisory "MANDATORY READ" text already existed — and was
 * ignored, because advice is wallpaper. This module makes it a gate.
 *
 * Mechanism (client-agnostic, no dependence on any host's compaction event):
 *   - A contract may declare `baseline` { intent, flow, required_reads,
 *     reack_after_mutations }.
 *   - Each session keeps an epoch state file. A new session starts UNACKED.
 *     A host that knows compaction happened bumps the epoch (Claude Code
 *     PostCompact adapter). Hosts without such an event (codex, opencode,
 *     grok build) rely on `reack_after_mutations`: every N allowed mutations
 *     the epoch bumps itself, forcing a periodic re-ground.
 *   - While UNACKED the mutation gate blocks governed work and names exactly
 *     one door: `node .agents/harness/session-baseline.cjs ack --session <id>`.
 *   - `ack` PRINTS the intent, flow, and full required files to stdout — the
 *     content necessarily enters the model context as tool output. "Did it
 *     read the baseline" stops being a hope and becomes an observable fact.
 *
 * The gate never blocks read-only investigation, recovery commands, or the
 * ack itself; an unattended session can always re-ground and continue.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATE_SCHEMA = "session-baseline-state-v1";
const MAX_PRINT_BYTES = 200_000;

function safeSessionId(sessionId) {
	const id = String(sessionId || "").trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) throw new Error("invalid_session_id");
	return id;
}

function statePath(root, sessionId) {
	return path.join(root, ".agents", "session-contracts", ".recovery", "baseline", `${safeSessionId(sessionId)}.json`);
}

function readJson(filePath) {
	try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function readState(root, sessionId) {
	const state = readJson(statePath(root, sessionId));
	if (!state || state.schema_version !== STATE_SCHEMA) return null;
	if (!Number.isInteger(state.epoch) || state.epoch < 1) return null;
	if (!Number.isInteger(state.acked_epoch) || state.acked_epoch < 0) return null;
	return state;
}

function defaultState() {
	// A session with no recorded state has never acked: epoch 1, unacked.
	// This is what makes a brand-new session re-ground before mutating.
	return { schema_version: STATE_SCHEMA, epoch: 1, acked_epoch: 0, mutations_since_ack: 0, read_digests: {}, updated_at: null };
}

function writeState(root, sessionId, state) {
	const target = statePath(root, sessionId);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const next = { ...state, updated_at: new Date().toISOString() };
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	fs.renameSync(tmp, target);
	return next;
}

function baselineOf(contract) {
	const baseline = contract && contract.baseline;
	if (!baseline || !Array.isArray(baseline.required_reads) || baseline.required_reads.length === 0) return null;
	return baseline;
}

function ackCommandFor(sessionId) {
	return `node .agents/harness/session-baseline.cjs ack --session ${safeSessionId(sessionId)}`;
}

/**
 * Gate view: does this contract demand a baseline ack, and is the current
 * epoch acked? Read-only — never creates state. Unreadable state counts as
 * unacked (fail-closed but always recoverable through the ack command).
 */
function gateStatus(root, sessionId, contract) {
	const baseline = baselineOf(contract);
	if (!baseline) return { required: false, acked: true, epoch: 0, ackCommand: null };
	const state = readState(root, sessionId) || defaultState();
	return {
		required: true,
		acked: state.acked_epoch >= state.epoch,
		epoch: state.epoch,
		ackedEpoch: state.acked_epoch,
		mutationsSinceAck: state.mutations_since_ack || 0,
		ackCommand: ackCommandFor(sessionId),
	};
}

/** Host adapter entry: context was rewritten (e.g. compaction) — force re-ack. */
function bumpEpoch(root, sessionId, reason) {
	const state = readState(root, sessionId) || defaultState();
	state.epoch = Math.max(state.epoch, state.acked_epoch) + 1;
	state.mutations_since_ack = 0;
	state.last_bump_reason = String(reason || "unknown");
	return writeState(root, sessionId, state);
}

/**
 * Called by the gate on each ALLOWED mutation. When the contract sets
 * `reack_after_mutations`, the epoch self-bumps every N mutations — the
 * client-agnostic stand-in for a compaction signal. Best-effort by design:
 * a failed counter write must not block the mutation it was counting.
 */
function noteMutation(root, sessionId, contract) {
	const baseline = baselineOf(contract);
	if (!baseline) return null;
	const threshold = Number.isInteger(baseline.reack_after_mutations) ? baseline.reack_after_mutations : 0;
	const state = readState(root, sessionId) || defaultState();
	if (state.acked_epoch < state.epoch) return state; // already unacked; nothing to count
	state.mutations_since_ack = (state.mutations_since_ack || 0) + 1;
	if (threshold > 0 && state.mutations_since_ack >= threshold) {
		state.epoch = state.epoch + 1;
		state.mutations_since_ack = 0;
		state.last_bump_reason = `reack_after_mutations:${threshold}`;
	}
	return writeState(root, sessionId, state);
}

function requiredReadPath(root, relative) {
	const normalized = String(relative || "").replace(/\\/g, "/");
	if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error(`baseline_read_not_relative:${relative}`);
	if (/(^|\/)\.\.(\/|$)/.test(normalized)) throw new Error(`baseline_read_escapes_root:${relative}`);
	return path.resolve(root, normalized);
}

/**
 * The ack: read every required file, print baseline + contents to stdout
 * (that is the guarantee — the text enters context as tool output), then
 * record the epoch as acked with content digests. Any missing file fails the
 * whole ack with no state change.
 */
function ack(root, sessionId, resolver) {
	const sessionContract = resolver || require(path.join(root, ".agents", "hooks", "core", "session-contract.js"));
	const resolution = sessionContract.resolveSessionContract({ cwd: root, sessionId });
	if (resolution.status !== sessionContract.STATES.BOUND) {
		throw new Error(`session_not_bound:${resolution.status}:${resolution.reason || ""}`);
	}
	const contract = resolution.contract;
	const baseline = baselineOf(contract);
	if (!baseline) throw new Error("contract_has_no_baseline");

	const reads = [];
	for (const relative of baseline.required_reads) {
		const absolute = requiredReadPath(root, relative);
		let content;
		try { content = fs.readFileSync(absolute, "utf8"); } catch { throw new Error(`baseline_read_missing:${relative}`); }
		reads.push({ relative, content, digest: crypto.createHash("sha256").update(content).digest("hex") });
	}

	const lines = [
		"══ [BASELINE ACK] ═══════════════════════════════════════",
		`Contract: ${contract.id}`,
		`Intent: ${baseline.intent || contract.goal}`,
	];
	if (baseline.flow) {
		const flow = baseline.flow;
		lines.push(`Flow: ${flow.current || "?"} → next: ${flow.next || "?"} — done when: ${flow.done_when || "?"}`);
	}
	for (const read of reads) {
		lines.push("", `── required read: ${read.relative} (sha256 ${read.digest.slice(0, 12)}) ──`);
		lines.push(read.content.length > MAX_PRINT_BYTES
			? `${read.content.slice(0, MAX_PRINT_BYTES)}\n… [truncated at ${MAX_PRINT_BYTES} chars — read the file directly for the rest]`
			: read.content);
	}

	const state = readState(root, sessionId) || defaultState();
	state.acked_epoch = state.epoch;
	state.mutations_since_ack = 0;
	state.read_digests = Object.fromEntries(reads.map((read) => [read.relative, read.digest]));
	writeState(root, sessionId, state);
	lines.push("", `Baseline acked: epoch ${state.epoch}. Mutating work is unlocked; stay on the intent above.`);
	return lines.join("\n");
}

function findRoot(startDir) {
	let dir = path.resolve(startDir || process.cwd());
	const stop = path.parse(dir).root;
	while (true) {
		if (fs.existsSync(path.join(dir, ".agents", "session-contracts"))) return dir;
		if (dir === stop) return null;
		dir = path.dirname(dir);
	}
}

function main(argv = process.argv.slice(2)) {
	const command = argv[0];
	const sessionFlag = argv.indexOf("--session");
	const sessionId = sessionFlag >= 0 ? argv[sessionFlag + 1] : null;
	const root = findRoot(process.cwd());
	if (!root) { process.stderr.write("session-baseline: no governed project root found\n"); process.exit(1); }
	if (!sessionId) { process.stderr.write("session-baseline: --session <id> is required\n"); process.exit(1); }
	try {
		if (command === "ack") {
			process.stdout.write(`${ack(root, sessionId)}\n`);
			process.exit(0);
		}
		if (command === "status") {
			const state = readState(root, sessionId) || defaultState();
			process.stdout.write(`${JSON.stringify({ epoch: state.epoch, acked_epoch: state.acked_epoch, acked: state.acked_epoch >= state.epoch, mutations_since_ack: state.mutations_since_ack || 0 }, null, 2)}\n`);
			process.exit(0);
		}
		process.stderr.write("session-baseline: usage — ack|status --session <id>\n");
		process.exit(1);
	} catch (error) {
		process.stderr.write(`session-baseline: ${error && error.message}\n`);
		process.exit(1);
	}
}

if (require.main === module) main();

module.exports = { STATE_SCHEMA, ack, ackCommandFor, baselineOf, bumpEpoch, defaultState, gateStatus, main, noteMutation, readState, statePath, writeState };
