/**
 * Session contract gate — opencode adapter.
 *
 * opencode has no hook registry of its own; a project plugin under
 * `.opencode/plugins/` is the only place a tool call can be intercepted
 * before it runs. This plugin is that interception. It does no policy work
 * itself: every governed call is translated into the payload the shared
 * gate already understands (`.codex/hooks/session-contract-gate.cjs`,
 * `decide()`) and its verdict is applied by throwing, which is how an
 * opencode plugin blocks a tool.
 *
 * What is governed: `bash`, `edit`, `multiedit`, `write`, `apply_patch`.
 * Read-only tools (`read`, `glob`, `grep`, `webfetch`, …) never reach the
 * gate. `task` is handled by the worker fan-out guard, not here.
 *
 * Compaction: opencode announces a finished compaction through
 * `experimental.compaction.autocontinue`. The session baseline epoch is
 * bumped there so a bound session re-reads its baseline before mutating
 * again — the same rule the Claude Code PostCompact adapter enforces.
 *
 * Fail-closed: a governed call whose gate cannot be loaded is blocked with
 * the load error, never silently allowed.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const GATE_RELATIVE = path.join(".codex", "hooks", "session-contract-gate.cjs");
const BASELINE_RELATIVE = path.join(".agents", "harness", "session-baseline.cjs");
const CONTRACT_CORE_RELATIVE = path.join(".agents", "hooks", "core", "session-contract.js");

/** Walk up from `directory` to the installed harness root. */
export function findHarnessRoot(directory) {
	let current = path.resolve(directory || process.cwd());
	const stop = path.parse(current).root;
	while (true) {
		if (fs.existsSync(path.join(current, GATE_RELATIVE))) return current;
		if (current === stop) return null;
		current = path.dirname(current);
	}
}

/**
 * Translate an opencode tool call into the gate's payload.
 * Returns null for tools the gate does not govern.
 */
export function toGateEvent(input, args, directory) {
	const tool = String(input?.tool || "").toLowerCase();
	const a = args && typeof args === "object" ? args : {};
	let toolName = null;
	let toolInput = null;
	if (tool === "bash") {
		toolName = "Bash";
		toolInput = { command: a.command, ...(a.workdir ? { workdir: a.workdir } : {}) };
	} else if (tool === "edit" || tool === "multiedit") {
		toolName = "Edit";
		toolInput = { ...a, file_path: a.filePath ?? a.file_path };
	} else if (tool === "write") {
		toolName = "Write";
		toolInput = { ...a, file_path: a.filePath ?? a.file_path };
	} else if (tool === "apply_patch") {
		toolName = "apply_patch";
		toolInput = { ...a, patch: a.patchText ?? a.patch ?? a.input };
	} else {
		return null;
	}
	return {
		cwd: path.resolve(directory || process.cwd()),
		session_id: input?.sessionID || null,
		tool_name: toolName,
		tool_input: toolInput,
		tool_use_id: input?.callID || null,
	};
}

function loadGate(root) {
	return require(path.join(root, GATE_RELATIVE));
}

/**
 * The plugin. `options` exists for tests: `gate` injects a decide(), `root`
 * pins the harness root instead of discovering it, and `env`/`dependencies`
 * are handed to decide() unchanged.
 */
export const SessionContractGate = async ({ directory }, options = {}) => {
	const root = options.root || findHarnessRoot(directory);
	return {
		"tool.execute.before": async (input, output) => {
			const event = toGateEvent(input, output?.args, directory);
			if (!event) return;
			let gate;
			try {
				gate = options.gate || loadGate(root);
			} catch (error) {
				throw new Error(`[HARNESS] session contract gate unavailable: ${error?.message || error}`);
			}
			const verdict = gate.decide(event, options.env || process.env, options.dependencies || {});
			if (verdict && verdict.decision === "block") throw new Error(verdict.reason || "[HARNESS] blocked");
		},
		"experimental.compaction.autocontinue": async (input) => {
			// Best-effort: the gate itself stays the enforcement. Only arm it
			// for a bound contract that declares a baseline.
			try {
				const sessionId = input?.sessionID;
				if (!sessionId || !root) return;
				const core = options.contractCore || require(path.join(root, CONTRACT_CORE_RELATIVE));
				const baseline = options.baseline || require(path.join(root, BASELINE_RELATIVE));
				const resolution = core.resolveSessionContract({ cwd: root, sessionId });
				if (resolution.status !== core.STATES.BOUND) return;
				if (!baseline.baselineOf(resolution.contract)) return;
				baseline.bumpEpoch(root, sessionId, "opencode_compaction");
			} catch { /* never break the host on a counter */ }
		},
	};
};
