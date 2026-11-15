#!/usr/bin/env node
/**
 * Thin Muse PreToolUse adapter for existing Claude Code gate scripts.
 *
 * Translates Muse PreToolUse hook payloads into Claude Code PreToolUse shape,
 * invokes existing `.claude/hooks/*.js` / `.cjs` gates unchanged (single verdict
 * source of truth), and converts allow / deny / ask / fail-closed gate errors
 * back into Muse PreToolUse hookSpecificOutput.
 */
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CODE_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const SHELL_TOOLS = new Set([
	"bash",
	"shell",
	"shell_command",
	"exec_command",
	"execute_command",
	"run_terminal_command",
]);
const WRITE_TOOLS = new Set(["write", "write_file"]);
const EDIT_TOOLS = new Set(["edit", "edit_file", "search_replace"]);
const MULTI_EDIT_TOOLS = new Set(["multiedit", "multi_edit"]);
const SUBAGENT_TOOLS = new Set(["subagent_spawn", "spawn_agent", "agent", "task"]);

/** Return the first defined string value from candidates, or empty string. */
function firstString(...values) {
	for (const value of values) {
		if (typeof value === "string") return value;
	}
	return "";
}

/** Return the first trimmed non-empty string value from candidates, or empty string. */
function firstNonEmpty(...values) {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

/** Normalize a shell command field that may arrive as string or argv array. */
function normalizeCommandText(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((item) => String(item ?? "")).join(" ");
	return "";
}

/** Build a fail-closed Muse PreToolUse deny response object. */
function denyOutput(reason) {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: firstNonEmpty(reason, "[muse-gate-adapter] Blocked by PreToolUse gate (fail-closed)."),
		},
	};
}

/** Build a Muse PreToolUse ask response, escalating to deny in bypassPermissions mode. */
function askOrDenyOutput(reason, museInput, hookLabel) {
	const effectiveReason = firstNonEmpty(reason, `[muse-gate-adapter] Confirmation required by ${hookLabel}.`);
	if (museInput?.permission_mode === "bypassPermissions") {
		return denyOutput(`[ask->deny: bypassPermissions] ${effectiveReason}`);
	}
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "ask",
			permissionDecisionReason: effectiveReason,
		},
	};
}

/** Parse CLI arguments into hook paths, ADK root, timeout, and patch options. */
function parseArgs(argv) {
	const opts = { hooks: [], adkRoot: null, timeoutMs: DEFAULT_TIMEOUT_MS, expandPatch: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--hook" || arg === "--hooks") {
			while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
				opts.hooks.push(argv[++i]);
			}
			continue;
		}
		if (arg === "--adk-root" || arg === "--naia-adk-root") {
			const next = argv[i + 1];
			if (!next || next.startsWith("--")) { opts.parseError = `Missing value for ${arg}`; continue; }
			opts.adkRoot = next;
			i += 1;
			continue;
		}
		if (arg.startsWith("--adk-root=")) { opts.adkRoot = arg.slice("--adk-root=".length); continue; }
		if (arg.startsWith("--naia-adk-root=")) { opts.adkRoot = arg.slice("--naia-adk-root=".length); continue; }
		if (arg === "--timeout-ms") {
			const next = argv[i + 1];
			if (!next || next.startsWith("--")) { opts.parseError = "Missing value for --timeout-ms"; continue; }
			const parsed = Number(next);
			i += 1;
			if (Number.isFinite(parsed) && parsed > 0) opts.timeoutMs = parsed;
			else opts.parseError = `Invalid --timeout-ms value`;
			continue;
		}
		if (arg === "--expand-patch") { opts.expandPatch = true; continue; }
		opts.parseError = `Unknown argument: ${arg}`;
	}
	return opts;
}

/** Parse Codex-style or unified-diff apply_patch text into file operations for edit guards. */
function expandPatchOperations(patchText) {
	const normalized = String(patchText || "").replace(/\r\n/g, "\n");
	if (!normalized.trim()) return [];
	const ops = [];
	const codexLines = normalized.split("\n");
	let current = null;

	const flush = () => {
		if (!current) return;
		const content = current.added.join("\n");
		if (current.kind === "Add") {
			ops.push({ tool_name: "Write", tool_input: { file_path: current.target, path: current.target, content } });
		} else {
			ops.push({
				tool_name: "Edit",
				tool_input: { file_path: current.target, path: current.target, old_string: "", new_string: content },
			});
		}
		current = null;
	};

	for (const line of codexLines) {
		const header = line.match(/^\*\*\* (Add|Update|Delete) File:\s+(.+?)\s*$/);
		if (header) {
			flush();
			current = { kind: header[1], target: header[2], added: [] };
			continue;
		}
		const move = line.match(/^\*\*\* Move to:\s+(.+?)\s*$/);
		if (move && current) {
			current.target = move[1];
			continue;
		}
		if (line === "*** End Patch" || line.startsWith("*** End of File")) {
			flush();
			continue;
		}
		if (current && line.startsWith("+") && !line.startsWith("+++")) {
			current.added.push(line.slice(1));
		}
	}
	flush();
	if (ops.length > 0) return ops;

	// Unified diff fallback (`+++ b/path` / `+++ path`).
	for (const match of normalized.matchAll(/^\+\+\+\s+(?:b\/)?([^\n\t]+?)\s*$/gm)) {
		const target = match[1].trim();
		if (target && target !== "/dev/null") {
			ops.push({
				tool_name: "Edit",
				tool_input: { file_path: target, path: target, old_string: "", new_string: normalized },
			});
		}
	}
	return ops;
}

/** Translate one Muse PreToolUse payload into one or more Claude PreToolUse payloads. */
function translateInput(museInput, opts = {}) {
	if (!museInput || typeof museInput !== "object" || Array.isArray(museInput)) {
		return { error: "[muse-gate-adapter] PreToolUse payload must be a JSON object (fail-closed)." };
	}
	const rawName = String(museInput.tool_name || "").trim();
	if (!rawName) {
		return { error: "[muse-gate-adapter] PreToolUse payload missing tool_name (fail-closed)." };
	}
	const leaf = rawName.split(/__|[.:/]/).filter(Boolean).pop().toLowerCase();
	const rawInput = museInput.tool_input && typeof museInput.tool_input === "object" && !Array.isArray(museInput.tool_input)
		? museInput.tool_input
		: {};

	const base = {
		hook_event_name: "PreToolUse",
		cwd: firstNonEmpty(museInput.cwd) || process.cwd(),
		transcript_path: museInput.transcript_path ?? null,
		muse_tool_name: rawName,
	};
	for (const field of ["session_id", "turn_id", "tool_use_id", "model", "model_provider", "permission_mode", "agent_type", "agent_id"]) {
		if (museInput[field] !== undefined) base[field] = museInput[field];
	}

	if (SHELL_TOOLS.has(leaf)) {
		const command = normalizeCommandText(rawInput.command ?? rawInput.cmd ?? rawInput.script);
		return { payloads: [{ ...base, tool_name: "Bash", tool_input: { ...rawInput, command } }] };
	}
	if (WRITE_TOOLS.has(leaf)) {
		const file_path = firstString(rawInput.file_path, rawInput.path, rawInput.target_file, rawInput.file);
		const content = firstString(rawInput.content, rawInput.contents, rawInput.text);
		return { payloads: [{ ...base, tool_name: "Write", tool_input: { ...rawInput, file_path, content } }] };
	}
	if (EDIT_TOOLS.has(leaf)) {
		const file_path = firstString(rawInput.file_path, rawInput.path, rawInput.target_file, rawInput.file);
		const old_string = firstString(rawInput.old_string, rawInput.find, rawInput.old_text, rawInput.search);
		const new_string = firstString(rawInput.new_string, rawInput.replace, rawInput.new_text);
		return { payloads: [{ ...base, tool_name: "Edit", tool_input: { ...rawInput, file_path, old_string, new_string } }] };
	}
	if (MULTI_EDIT_TOOLS.has(leaf)) {
		const file_path = firstString(rawInput.file_path, rawInput.path, rawInput.target_file, rawInput.file);
		const edits = Array.isArray(rawInput.edits)
			? rawInput.edits.map((item) => item && typeof item === "object" ? {
				...item,
				file_path: firstString(item.file_path, item.path, file_path),
				old_string: firstString(item.old_string, item.find, item.old_text),
				new_string: firstString(item.new_string, item.replace, item.new_text),
			} : item)
			: rawInput.edits;
		return { payloads: [{ ...base, tool_name: "MultiEdit", tool_input: { ...rawInput, file_path, edits } }] };
	}
	if (leaf === "notebookedit") {
		const notebook_path = firstString(rawInput.notebook_path, rawInput.file_path, rawInput.path);
		return { payloads: [{ ...base, tool_name: "NotebookEdit", tool_input: { ...rawInput, notebook_path } }] };
	}
	if (leaf === "apply_patch") {
		const patch = firstString(rawInput.patch, rawInput.input, rawInput.diff, rawInput.command);
		if (opts.expandPatch) {
			const ops = expandPatchOperations(patch);
			if (!ops.length) {
				return { error: "[muse-gate-adapter] Unrecognized apply_patch payload (fail-closed)." };
			}
			return {
				payloads: ops.map((op) => ({ ...base, tool_name: op.tool_name, tool_input: { ...rawInput, ...op.tool_input } })),
			};
		}
		return { payloads: [{ ...base, tool_name: "apply_patch", tool_input: { ...rawInput, patch } }] };
	}
	if (SUBAGENT_TOOLS.has(leaf)) {
		const prompt = firstString(rawInput.prompt, rawInput.message, rawInput.task, rawInput.instruction);
		return { payloads: [{ ...base, tool_name: "Agent", tool_input: { ...rawInput, prompt } }] };
	}
	if (leaf === "workflow") {
		return { payloads: [{ ...base, tool_name: "Workflow", tool_input: { ...rawInput } }] };
	}
	return { payloads: [{ ...base, tool_name: rawName, tool_input: { ...rawInput } }] };
}

/** Interpret a Claude gate hook JSON output object under Muse PreToolUse rules. */
function interpretClaudeOutput(rawStdout, museInput, hookLabel) {
	const trimmed = String(rawStdout || "").trim();
	if (!trimmed) return { action: "allow" };

	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { action: "halt", output: denyOutput(`[muse-gate-adapter] Gate "${hookLabel}" returned non-JSON stdout (fail-closed).`) };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { action: "halt", output: denyOutput(`[muse-gate-adapter] Gate "${hookLabel}" returned non-object JSON stdout (fail-closed).`) };
	}

	if (parsed.hookSpecificOutput !== undefined) {
		const hso = parsed.hookSpecificOutput;
		if (!hso || typeof hso !== "object" || Array.isArray(hso)) {
			return { action: "halt", output: denyOutput(`[muse-gate-adapter] Gate "${hookLabel}" returned invalid hookSpecificOutput (fail-closed).`) };
		}
		if (hso.permissionDecision === "deny") {
			return { action: "halt", output: denyOutput(firstNonEmpty(hso.permissionDecisionReason, parsed.reason, `[muse-gate-adapter] Blocked by ${hookLabel}.`)) };
		}
		if (hso.permissionDecision === "ask") {
			return { action: "halt", output: askOrDenyOutput(firstNonEmpty(hso.permissionDecisionReason, parsed.reason), museInput, hookLabel) };
		}
		if (hso.permissionDecision !== undefined && hso.permissionDecision !== "allow") {
			return { action: "halt", output: denyOutput(`[muse-gate-adapter] Gate "${hookLabel}" returned unsupported permissionDecision "${hso.permissionDecision}" (fail-closed).`) };
		}
		return {
			action: "allow",
			additionalContext: typeof hso.additionalContext === "string" ? hso.additionalContext : null,
			systemMessage: typeof parsed.systemMessage === "string" ? parsed.systemMessage : null,
			updatedInput: hso.permissionDecision === "allow" && hso.updatedInput && typeof hso.updatedInput === "object" ? hso.updatedInput : null,
		};
	}

	if (parsed.decision === "block") {
		return { action: "halt", output: denyOutput(firstNonEmpty(parsed.reason, `[muse-gate-adapter] Blocked by ${hookLabel}.`)) };
	}
	if (parsed.continue === false) {
		return { action: "halt", output: denyOutput(firstNonEmpty(parsed.stopReason, parsed.reason, `[muse-gate-adapter] Stopped by ${hookLabel}.`)) };
	}
	if (parsed.decision !== undefined && parsed.decision !== "allow") {
		return { action: "halt", output: denyOutput(`[muse-gate-adapter] Gate "${hookLabel}" returned unsupported decision "${parsed.decision}" (fail-closed).`) };
	}

	return {
		action: "allow",
		systemMessage: typeof parsed.systemMessage === "string" ? parsed.systemMessage : null,
	};
}

/** Invoke one child gate hook script via Node and translate its result fail-closed. */
function runSingleHook(hookPath, claudePayload, museInput, opts = {}) {
	const hookAbs = path.isAbsolute(hookPath) ? hookPath : path.resolve(CODE_ROOT, hookPath);
	const hookLabel = path.basename(hookAbs);
	if (!fs.existsSync(hookAbs)) {
		return { action: "halt", output: denyOutput(`[muse-gate-adapter] Gate hook script not found: ${hookAbs} (fail-closed).`) };
	}

	const baseEnv = { ...(opts.env || process.env) };
	if (opts.adkRoot) {
		baseEnv.NAIA_ADK_ROOT = path.resolve(opts.adkRoot);
	}
	if (!baseEnv.CLAUDE_PROJECT_DIR) {
		baseEnv.CLAUDE_PROJECT_DIR = claudePayload.cwd || process.cwd();
	}

	const execCwd = claudePayload.cwd && fs.existsSync(claudePayload.cwd) ? claudePayload.cwd : process.cwd();
	const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
	const runner = opts.spawnSync || cp.spawnSync;
	const res = runner(process.execPath, [hookAbs], {
		input: JSON.stringify(claudePayload),
		cwd: execCwd,
		env: baseEnv,
		encoding: "utf8",
		shell: false,
		timeout: timeoutMs,
		maxBuffer: MAX_OUTPUT_BYTES,
	});

	if (res.stderr && String(res.stderr).trim()) {
		(opts.onStderr || ((msg) => process.stderr.write(msg)))(res.stderr);
	}

	if (res.error) {
		const detail = res.error.code || res.error.message || "spawn error";
		return { action: "halt", output: denyOutput(`[muse-gate-adapter] Gate "${hookLabel}" execution failed (${detail}) (fail-closed).`) };
	}
	if (res.signal) {
		return { action: "halt", output: denyOutput(`[muse-gate-adapter] Gate "${hookLabel}" terminated by signal ${res.signal} (fail-closed).`) };
	}
	if (res.status === 2) {
		const interpreted = res.stdout && String(res.stdout).trim()
			? interpretClaudeOutput(res.stdout, museInput, hookLabel)
			: null;
		if (interpreted?.action === "halt") return interpreted;
		const reason = firstNonEmpty(String(res.stderr || ""), String(res.stdout || ""), `[muse-gate-adapter] Blocked by ${hookLabel} (exit 2).`);
		return { action: "halt", output: denyOutput(reason) };
	}
	if (res.status !== 0) {
		const errNote = firstNonEmpty(String(res.stderr || "")).split("\n")[0];
		const suffix = errNote ? `: ${errNote.slice(0, 200)}` : "";
		return { action: "halt", output: denyOutput(`[muse-gate-adapter] Gate "${hookLabel}" exited with status ${res.status}${suffix} (fail-closed).`) };
	}

	return interpretClaudeOutput(res.stdout, museInput, hookLabel);
}

/** Evaluate all configured hooks against one Muse PreToolUse payload (fail-closed). */
function evaluateMusePreToolUse(museInput, opts = {}) {
	if (opts.parseError) {
		return denyOutput(`[muse-gate-adapter] Invalid adapter options (${opts.parseError}) (fail-closed).`);
	}
	if (!Array.isArray(opts.hooks) || opts.hooks.length === 0) {
		return denyOutput("[muse-gate-adapter] No target gate hook specified via --hook (fail-closed).");
	}
	const translated = translateInput(museInput, opts);
	if (translated.error) {
		return denyOutput(translated.error);
	}

	const contexts = [];
	const systemMessages = [];
	let updatedInput = null;

	for (const payload of translated.payloads) {
		for (const hookPath of opts.hooks) {
			const res = runSingleHook(hookPath, payload, museInput, opts);
			if (res.action !== "allow") {
				return res.output;
			}
			if (res.additionalContext) contexts.push(res.additionalContext);
			if (res.systemMessage) systemMessages.push(res.systemMessage);
			if (res.updatedInput) updatedInput = res.updatedInput;
		}
	}

	const out = {};
	if (contexts.length || updatedInput) {
		out.hookSpecificOutput = { hookEventName: "PreToolUse" };
		if (contexts.length) out.hookSpecificOutput.additionalContext = contexts.join("\n");
		if (updatedInput) {
			out.hookSpecificOutput.permissionDecision = "allow";
			out.hookSpecificOutput.updatedInput = updatedInput;
		}
	}
	if (systemMessages.length) {
		out.systemMessage = systemMessages.join("\n");
	}
	return Object.keys(out).length ? out : null;
}

/** Read stdin, run Muse PreToolUse gate evaluation, and emit JSON only when required. */
async function main() {
	const opts = parseArgs(process.argv.slice(2));
	let raw = "";
	try {
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) raw += chunk;
	} catch (error) {
		process.stdout.write(JSON.stringify(denyOutput(`[muse-gate-adapter] Failed reading hook stdin (${error?.message || error}) (fail-closed).`)));
		return;
	}

	let museInput;
	try {
		museInput = JSON.parse(raw);
	} catch {
		process.stdout.write(JSON.stringify(denyOutput("[muse-gate-adapter] Invalid Muse PreToolUse stdin JSON (fail-closed).")));
		return;
	}

	const output = evaluateMusePreToolUse(museInput, opts);
	if (output) {
		process.stdout.write(JSON.stringify(output));
	}
}

if (require.main === module) {
	main().catch((error) => {
		process.stdout.write(JSON.stringify(denyOutput(`[muse-gate-adapter] Unexpected adapter failure (${error?.message || error}) (fail-closed).`)));
		process.exitCode = 0;
	});
}

module.exports = {
	CODE_ROOT,
	DEFAULT_TIMEOUT_MS,
	askOrDenyOutput,
	denyOutput,
	evaluateMusePreToolUse,
	expandPatchOperations,
	interpretClaudeOutput,
	parseArgs,
	runSingleHook,
	translateInput,
};
