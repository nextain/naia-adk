#!/usr/bin/env node
/**
 * Muse lifecycle/gate adapter for existing Claude Code gate & lifecycle scripts.
 *
 * Translates Muse hook payloads (PreToolUse, PostToolUse, PostToolUseFailure,
 * PostToolBatch, UserPromptSubmit, SessionStart, PreCompact, PostCompact, Stop)
 * into Claude Code shape, routes tool calls internally (including unknown/MCP
 * tools, multi_edit, apply_patch, subagent_spawn, and workflow), enforces an
 * overall cumulative deadline before Muse's outer timeout expires, invokes
 * existing `.claude/hooks/*.js` and user-profile `.cjs` gates unchanged, and
 * converts allow / deny / ask / block / fail-closed gate errors back into Muse
 * hook responses.
 */
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CODE_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_MS = 12_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEADLINE_GUARD_MARGIN_MS = 40;

const SHELL_TOOLS = new Set([
	"bash",
	"bash_input",
	"monitor",
	"shell",
	"shell_command",
	"exec_command",
	"execute_command",
	"run_terminal_command",
	"run_command",
]);
const WRITE_TOOLS = new Set(["write", "write_file", "create_file"]);
const EDIT_TOOLS = new Set(["edit", "edit_file", "search_replace", "replace_in_file", "str_replace"]);
const MULTI_EDIT_TOOLS = new Set(["multiedit", "multi_edit"]);
const SUBAGENT_TOOLS = new Set(["subagent_spawn", "spawn_agent", "agent", "task"]);
const WORKFLOW_TOOLS = new Set(["workflow", "run_workflow"]);

// Built-in non-workspace-mutating or read-only tools whose native Muse/Claude
// invocations should pass through without triggering unknown-tool warnings or
// misclassifying memory names as repo filesystem paths.
const NATIVE_PASSTHROUGH_TOOLS = new Set([
	"read_file",
	"search",
	"read_memory",
	"add_memory",
	"edit_memory",
	"read_skill",
	"web_fetch",
	"web_search",
	"work_stop",
	"work_list",
	"work_status",
	"subagent_status",
	"subagent_send_message",
	"subagent_wait",
	"subagent_read_result",
	"subagent_cancel",
	"snooze_reminder",
	"write_todos",
	"read",
	"glob",
	"grep",
	"ls",
	"todowrite",
	"askuserquestion",
	"webfetch",
	"websearch",
]);

const SHELL_NAME_RE = /(?:^|[_-])(?:bash|sh|shell|cmd|command|exec|terminal|run_script)(?:$|[_-])/i;
const WRITE_NAME_RE = /(?:^|[_-])(?:write|edit|patch|create|update|modify|save|append|delete|remove|unlink|rename|move|mkdir|copy)(?:$|[_-])/i;
const PASSTHROUGH_FIELDS = [
	"session_id",
	"turn_id",
	"tool_use_id",
	"model",
	"model_provider",
	"permission_mode",
	"agent_type",
	"agent_id",
	"prompt",
	"prompt_source",
	"source",
	"tool_response",
	"tool_calls",
	"error",
	"trigger",
];
const STRICT_FAIL_CLOSED_EVENTS = new Set(["PreToolUse", "UserPromptSubmit", "PreCompact"]);
const SESSION_ONCE_HOOKS = new Set(["beh-pretool.js", "beh-record.js", "scheduled-task-gate.js", "cost-guard.cjs"]);
const EVENTS_WITH_ADDITIONAL_CONTEXT = new Set([
	"PreToolUse",
	"UserPromptSubmit",
	"SessionStart",
	"PostToolUse",
	"PostToolBatch",
]);

/** Return a shallow copy of rawInput without fields that could shadow synthesized per-file Edit targets. */
function sanitizeEditInput(rawInput) {
	const cleaned = { ...rawInput };
	delete cleaned.content;
	delete cleaned.contents;
	delete cleaned.edits;
	delete cleaned.patch;
	delete cleaned.diff;
	delete cleaned.patch_text;
	delete cleaned.input;
	delete cleaned.command;
	delete cleaned.notebook_path;
	return cleaned;
}

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

/** Build an event-appropriate fail-closed halt/block response object verified against Muse 1.4.20. */
function haltOutput(eventName, reason) {
	const text = firstNonEmpty(reason, `[muse-gate-adapter] Blocked on ${eventName} (fail-closed).`);
	if (eventName === "PreToolUse") return denyOutput(text);
	if (eventName === "UserPromptSubmit") return { decision: "block", reason: text };
	if (eventName === "PostCompact") return { systemMessage: text };
	return { continue: false, stopReason: text };
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

/** Parse CLI arguments into routed hook entries, policy overrides, timeout, and deadline options. */
function parseArgs(argv) {
	const opts = {
		hooks: [],
		hookEntries: [],
		event: "PreToolUse",
		adkRoot: null,
		costPolicy: null,
		modelPolicy: null,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		deadlineMs: null,
		expandPatch: true,
	};
	let currentMatcher = null;
	let inHookList = false;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--when" || arg === "--match") {
			inHookList = false;
			const next = argv[++i];
			if (!next || next.startsWith("--")) { opts.parseError = `Missing value for ${arg}`; continue; }
			if (next === "*" || next === "all") {
				currentMatcher = null;
			} else {
				try {
					currentMatcher = new RegExp(`^(?:${next})$`);
				} catch {
					opts.parseError = `Invalid ${arg} regex: ${next}`;
				}
			}
			continue;
		}
		if (arg === "--hook" || arg === "--hooks") {
			inHookList = true;
			while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
				const hookPath = argv[++i];
				opts.hooks.push(hookPath);
				opts.hookEntries.push({ path: hookPath, args: [], matcher: currentMatcher });
			}
			continue;
		}
		if (arg === "--arg") {
			if (i + 1 >= argv.length) { opts.parseError = "Missing value for --arg"; continue; }
			const val = argv[++i];
			const lastEntry = opts.hookEntries[opts.hookEntries.length - 1];
			if (!lastEntry) { opts.parseError = "--arg must follow a --hook"; continue; }
			lastEntry.args.push(val);
			continue;
		}
		if (inHookList && !arg.startsWith("--")) {
			opts.hooks.push(arg);
			opts.hookEntries.push({ path: arg, args: [], matcher: currentMatcher });
			continue;
		}
		inHookList = false;
		if (arg === "--event") {
			const next = argv[++i];
			if (!next || next.startsWith("--")) { opts.parseError = "Missing value for --event"; continue; }
			opts.event = next;
			continue;
		}
		if (arg === "--adk-root" || arg === "--naia-adk-root") {
			const next = argv[++i];
			if (!next || next.startsWith("--")) { opts.parseError = `Missing value for ${arg}`; continue; }
			opts.adkRoot = next;
			continue;
		}
		if (arg.startsWith("--adk-root=")) { opts.adkRoot = arg.slice("--adk-root=".length); continue; }
		if (arg.startsWith("--naia-adk-root=")) { opts.adkRoot = arg.slice("--naia-adk-root=".length); continue; }
		if (arg === "--cost-policy") {
			const next = argv[++i];
			if (!next || next.startsWith("--")) { opts.parseError = "Missing value for --cost-policy"; continue; }
			opts.costPolicy = next;
			continue;
		}
		if (arg === "--model-policy") {
			const next = argv[++i];
			if (!next || next.startsWith("--")) { opts.parseError = "Missing value for --model-policy"; continue; }
			opts.modelPolicy = next;
			continue;
		}
		if (arg === "--timeout-ms") {
			const next = argv[++i];
			if (!next || next.startsWith("--")) { opts.parseError = "Missing value for --timeout-ms"; continue; }
			const parsed = Number(next);
			if (Number.isFinite(parsed) && parsed > 0) opts.timeoutMs = parsed;
			else opts.parseError = "Invalid --timeout-ms value";
			continue;
		}
		if (arg === "--deadline-ms") {
			const next = argv[++i];
			if (!next || next.startsWith("--")) { opts.parseError = "Missing value for --deadline-ms"; continue; }
			const parsed = Number(next);
			if (Number.isFinite(parsed) && parsed > 0) opts.deadlineMs = parsed;
			else opts.parseError = "Invalid --deadline-ms value";
			continue;
		}
		if (arg === "--expand-patch") { opts.expandPatch = true; continue; }
		opts.parseError = `Unknown argument: ${arg}`;
	}
	return opts;
}

/** Normalize one unified diff header path (`a/foo.ts` / `b/foo.ts` / `/dev/null`). */
function normalizeDiffPath(rawHeaderPath, prefix) {
	const stripped = String(rawHeaderPath || "").split("\t")[0].trim().replace(/^"(.*)"$/, "$1");
	if (!stripped || stripped === "/dev/null") return "";
	return stripped.startsWith(prefix) ? stripped.slice(prefix.length) : stripped;
}

/** Parse Codex-style or unified-diff apply_patch text into per-file operations for edit guards. */
function expandPatchOperations(patchText) {
	const normalized = String(patchText || "").replace(/\r\n/g, "\n");
	if (!normalized.trim()) return [];
	const ops = [];
	const lines = normalized.split("\n");
	let current = null;

	const flushCodex = () => {
		if (!current) return;
		const content = current.added.join("\n");
		if (current.kind === "Add") {
			ops.push({ tool_name: "Write", tool_input: { file_path: current.target, path: current.target, content } });
		} else {
			ops.push({
				tool_name: "Edit",
				tool_input: { file_path: current.target, path: current.target, old_string: "", new_string: content },
			});
			if (current.kind === "Delete") {
				ops.push({
					tool_name: "apply_patch",
					tool_input: {
						patch: `*** Begin Patch\n*** Delete File: ${current.target}\n*** End Patch`,
						file_path: current.target,
						path: current.target,
					},
				});
			}
			// Renames/moves modify the source path as well as the destination; guard both.
			if (current.originalTarget && current.originalTarget !== current.target) {
				ops.push({
					tool_name: "Edit",
					tool_input: { file_path: current.originalTarget, path: current.originalTarget, old_string: "", new_string: "" },
				});
			}
		}
		current = null;
	};

	for (const line of lines) {
		const header = line.match(/^\*\*\* (Add|Update|Delete) File:\s+(.+?)\s*$/);
		if (header) {
			flushCodex();
			current = { kind: header[1], target: header[2], originalTarget: header[2], added: [] };
			continue;
		}
		const move = line.match(/^\*\*\* Move to:\s+(.+?)\s*$/);
		if (move && current) {
			current.target = move[1];
			continue;
		}
		if (line === "*** End Patch" || line.startsWith("*** End of File")) {
			flushCodex();
			continue;
		}
		if (current && line.startsWith("+") && !line.startsWith("+++")) {
			current.added.push(line.slice(1));
		}
	}
	flushCodex();
	if (ops.length > 0) return ops;

	// Unified diff fallback (`--- a/old` + `+++ b/new`, including `+++ /dev/null` deletions).
	let uSection = null;
	const flushUnified = () => {
		if (!uSection) return;
		const { oldTarget, newTarget, added, removed } = uSection;
		if (!oldTarget && newTarget) {
			ops.push({
				tool_name: "Write",
				tool_input: { file_path: newTarget, path: newTarget, content: added.join("\n") },
			});
		} else if (oldTarget && !newTarget) {
			ops.push({
				tool_name: "Edit",
				tool_input: { file_path: oldTarget, path: oldTarget, old_string: removed.join("\n"), new_string: "" },
			});
			ops.push({
				tool_name: "apply_patch",
				tool_input: {
					patch: `*** Begin Patch\n*** Delete File: ${oldTarget}\n*** End Patch`,
					file_path: oldTarget,
					path: oldTarget,
				},
			});
		} else if (newTarget) {
			ops.push({
				tool_name: "Edit",
				tool_input: { file_path: newTarget, path: newTarget, old_string: "", new_string: added.join("\n") },
			});
			if (oldTarget && oldTarget !== newTarget) {
				ops.push({
					tool_name: "Edit",
					tool_input: { file_path: oldTarget, path: oldTarget, old_string: removed.join("\n"), new_string: "" },
				});
			}
		}
		uSection = null;
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.startsWith("diff --git ")) {
			flushUnified();
			continue;
		}
		const minusMatch = line.match(/^---\s+(.+)$/);
		const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
		const plusMatch = minusMatch ? nextLine.match(/^\+\+\+\s+(.+)$/) : null;
		if (minusMatch && plusMatch) {
			flushUnified();
			uSection = {
				oldTarget: normalizeDiffPath(minusMatch[1], "a/"),
				newTarget: normalizeDiffPath(plusMatch[1], "b/"),
				added: [],
				removed: [],
			};
			i += 1;
			continue;
		}
		const standalonePlus = !uSection ? line.match(/^\+\+\+\s+(.+)$/) : null;
		if (standalonePlus) {
			const target = normalizeDiffPath(standalonePlus[1], "b/");
			if (target) {
				uSection = { oldTarget: target, newTarget: target, added: [], removed: [] };
			}
			continue;
		}
		if (uSection) {
			if (line.startsWith("+") && !line.startsWith("+++")) uSection.added.push(line.slice(1));
			else if (line.startsWith("-") && !line.startsWith("---")) uSection.removed.push(line.slice(1));
		}
	}
	flushUnified();
	return ops;
}

/** Expand `multi_edit` items so every edited target path is checked individually by Edit guards. */
function expandMultiEditPayloads(base, rawInput) {
	if (!Array.isArray(rawInput.edits) || rawInput.edits.length === 0) {
		return { error: "[muse-gate-adapter] multi_edit payload requires a non-empty edits array (fail-closed)." };
	}
	const topFilePath = firstString(rawInput.file_path, rawInput.path, rawInput.target_file, rawInput.file, rawInput.filepath, rawInput.filename);
	const cleanTop = sanitizeEditInput(rawInput);
	const payloads = [];
	const seenPaths = new Set();

	for (let idx = 0; idx < rawInput.edits.length; idx += 1) {
		const item = rawInput.edits[idx];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			return { error: `[muse-gate-adapter] multi_edit edits[${idx}] must be an object (fail-closed).` };
		}
		const file_path = firstString(item.file_path, item.path, item.target_file, item.file, item.filepath, item.filename, topFilePath);
		if (!file_path) {
			return { error: `[muse-gate-adapter] multi_edit edits[${idx}] missing target file path (fail-closed).` };
		}
		seenPaths.add(file_path);
		const old_string = firstString(item.old_string, item.find, item.old_text, item.search);
		const new_string = firstString(item.new_string, item.replace, item.new_text, item.replacement, item.content);
		const cleanItem = sanitizeEditInput(item);
		payloads.push({
			...base,
			tool_name: "Edit",
			tool_input: {
				...cleanTop,
				...cleanItem,
				file_path,
				path: file_path,
				old_string,
				new_string,
			},
		});
	}

	// If top-level file_path names a path absent from edits[], guard it too.
	if (topFilePath && !seenPaths.has(topFilePath)) {
		payloads.push({
			...base,
			tool_name: "Edit",
			tool_input: { ...cleanTop, file_path: topFilePath, path: topFilePath, old_string: "", new_string: "" },
		});
	}
	return { payloads };
}

/** Classify unknown/MCP tool calls by input shape or name cues so shell/write guards cannot be bypassed. */
function classifyUnknownTool(base, rawName, leaf, rawInput, shouldExpandPatch) {
	const commandVal = rawInput.command ?? rawInput.cmd ?? rawInput.script ?? rawInput.shell_command;
	const hasCommandShape =
		(typeof commandVal === "string" && commandVal.trim().length > 0) ||
		(Array.isArray(commandVal) && commandVal.length > 0);
	if (hasCommandShape || SHELL_NAME_RE.test(leaf)) {
		const command = normalizeCommandText(commandVal ?? rawInput.input ?? rawInput.code);
		return { payloads: [{ ...base, tool_name: "Bash", tool_input: { ...rawInput, command } }] };
	}

	const rawPatch = firstString(rawInput.patch, rawInput.diff);
	if (rawPatch && shouldExpandPatch) {
		const ops = expandPatchOperations(rawPatch);
		if (ops.length > 0) {
			const cleanBase = sanitizeEditInput(rawInput);
			return {
				payloads: ops.map((op) => ({
					...base,
					tool_name: op.tool_name,
					tool_input: { ...(op.tool_name === "Edit" ? cleanBase : rawInput), ...op.tool_input },
				})),
			};
		}
	}

	const file_path = firstString(
		rawInput.file_path,
		rawInput.path,
		rawInput.target_file,
		rawInput.target,
		rawInput.file,
		rawInput.filepath,
		rawInput.filename,
		rawInput.dest,
		rawInput.destination,
		rawInput.to,
	);
	const hasEditKeys = [rawInput.old_string, rawInput.find, rawInput.old_text, rawInput.search, rawInput.new_string, rawInput.replace, rawInput.new_text, rawInput.replacement]
		.some((v) => typeof v === "string");
	const hasWriteContentKeys = [rawInput.content, rawInput.contents, rawInput.text, rawInput.body, rawInput.data]
		.some((v) => typeof v === "string");

	if (file_path && hasEditKeys) {
		const old_string = firstString(rawInput.old_string, rawInput.find, rawInput.old_text, rawInput.search);
		const new_string = firstString(rawInput.new_string, rawInput.replace, rawInput.new_text, rawInput.replacement);
		return {
			payloads: [{ ...base, tool_name: "Edit", tool_input: { ...sanitizeEditInput(rawInput), file_path, path: file_path, old_string, new_string } }],
		};
	}
	if (file_path && hasWriteContentKeys) {
		const content = firstString(rawInput.content, rawInput.contents, rawInput.text, rawInput.body, rawInput.data);
		return { payloads: [{ ...base, tool_name: "Write", tool_input: { ...rawInput, file_path, path: file_path, content } }] };
	}
	if (file_path && WRITE_NAME_RE.test(leaf)) {
		const payloads = [
			{ ...base, tool_name: "Edit", tool_input: { ...sanitizeEditInput(rawInput), file_path, path: file_path, old_string: "", new_string: "" } },
		];
		if (/(?:^|[_-])(?:delete|remove|unlink)(?:$|[_-])/i.test(leaf)) {
			payloads.push({
				...base,
				tool_name: "apply_patch",
				tool_input: {
					patch: `*** Begin Patch\n*** Delete File: ${file_path}\n*** End Patch`,
					file_path,
					path: file_path,
				},
			});
		}
		const sourcePath = firstString(rawInput.source, rawInput.src, rawInput.from, rawInput.old_path, rawInput.source_path);
		if (sourcePath && sourcePath !== file_path && /(?:^|[_-])(?:move|rename)(?:$|[_-])/i.test(leaf)) {
			payloads.push({
				...base,
				tool_name: "Edit",
				tool_input: { ...sanitizeEditInput(rawInput), file_path: sourcePath, path: sourcePath, old_string: "", new_string: "" },
			});
		}
		return { payloads };
	}

	return {
		unknownTool: rawName,
		payloads: [{ ...base, tool_name: rawName, tool_input: { ...rawInput } }],
	};
}

/** Translate one Muse hook payload into one or more Claude Code hook payloads. */
function translateInput(museInput, opts = {}) {
	const eventName = opts.event || museInput?.hook_event_name || "PreToolUse";
	if (!museInput || typeof museInput !== "object" || Array.isArray(museInput)) {
		return { error: `[muse-gate-adapter] ${eventName} payload must be a JSON object (fail-closed).` };
	}

	const base = {
		hook_event_name: eventName,
		cwd: firstNonEmpty(museInput.cwd) || process.cwd(),
		transcript_path: museInput.transcript_path ?? null,
	};
	for (const field of PASSTHROUGH_FIELDS) {
		if (museInput[field] !== undefined) base[field] = museInput[field];
	}

	// Non-tool lifecycle events do not carry tool_name; forward envelope directly.
	if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(eventName) && !museInput.tool_name) {
		return { payloads: [base] };
	}

	const rawName = String(museInput.tool_name || "").trim();
	if (!rawName) {
		if (eventName === "PostToolUseFailure") return { payloads: [base] };
		return { error: `[muse-gate-adapter] ${eventName} payload missing tool_name (fail-closed).` };
	}
	base.muse_tool_name = rawName;

	const rawLeaf = rawName.split(/__|[.:/]/).filter(Boolean).pop() || "";
	const lowerLeaf = rawLeaf.toLowerCase();
	const leaf = rawLeaf.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
	const rawInput = museInput.tool_input && typeof museInput.tool_input === "object" && !Array.isArray(museInput.tool_input)
		? museInput.tool_input
		: {};
	const shouldExpandPatch = opts.expandPatch !== false;

	if (rawName.toLowerCase() === lowerLeaf && NATIVE_PASSTHROUGH_TOOLS.has(lowerLeaf)) {
		return { payloads: [{ ...base, tool_name: rawName, tool_input: { ...rawInput } }] };
	}

	// Classify workflow before unknown-tool shell heuristic because workflow inputs contain `script`.
	if (WORKFLOW_TOOLS.has(leaf) || WORKFLOW_TOOLS.has(lowerLeaf)) {
		return { payloads: [{ ...base, tool_name: "Workflow", tool_input: { ...rawInput } }] };
	}
	if (SUBAGENT_TOOLS.has(leaf) || SUBAGENT_TOOLS.has(lowerLeaf)) {
		const prompt = firstString(rawInput.prompt, rawInput.objective, rawInput.message, rawInput.task, rawInput.instruction);
		return { payloads: [{ ...base, tool_name: "Agent", tool_input: { ...rawInput, prompt } }] };
	}
	if (SHELL_TOOLS.has(leaf) || SHELL_TOOLS.has(lowerLeaf)) {
		const command = normalizeCommandText(rawInput.command ?? rawInput.cmd ?? rawInput.script ?? (leaf === "bash_input" ? rawInput.chars : ""));
		return { payloads: [{ ...base, tool_name: "Bash", tool_input: { ...rawInput, command } }] };
	}
	if (WRITE_TOOLS.has(leaf) || WRITE_TOOLS.has(lowerLeaf)) {
		const file_path = firstString(rawInput.file_path, rawInput.path, rawInput.target_file, rawInput.file, rawInput.filepath);
		const content = firstString(rawInput.content, rawInput.contents, rawInput.text);
		return { payloads: [{ ...base, tool_name: "Write", tool_input: { ...rawInput, file_path, content } }] };
	}
	if (EDIT_TOOLS.has(leaf) || EDIT_TOOLS.has(lowerLeaf)) {
		const file_path = firstString(rawInput.file_path, rawInput.path, rawInput.target_file, rawInput.file, rawInput.filepath);
		const old_string = firstString(rawInput.old_string, rawInput.find, rawInput.old_text, rawInput.search);
		const new_string = firstString(rawInput.new_string, rawInput.replace, rawInput.new_text, rawInput.replacement, rawInput.content);
		return { payloads: [{ ...base, tool_name: "Edit", tool_input: { ...sanitizeEditInput(rawInput), file_path, old_string, new_string } }] };
	}
	if (MULTI_EDIT_TOOLS.has(leaf) || MULTI_EDIT_TOOLS.has(lowerLeaf)) {
		return expandMultiEditPayloads(base, rawInput);
	}
	if (lowerLeaf === "notebookedit" || leaf === "notebook_edit") {
		const notebook_path = firstString(rawInput.notebook_path, rawInput.file_path, rawInput.path);
		return { payloads: [{ ...base, tool_name: "NotebookEdit", tool_input: { ...rawInput, notebook_path } }] };
	}
	if (leaf === "apply_patch") {
		const patch = firstString(rawInput.patch, rawInput.input, rawInput.diff, rawInput.command);
		if (shouldExpandPatch) {
			const ops = expandPatchOperations(patch);
			if (!ops.length) {
				return { error: "[muse-gate-adapter] Unrecognized apply_patch payload (fail-closed)." };
			}
			const cleanBase = sanitizeEditInput(rawInput);
			return {
				payloads: ops.map((op) => ({
					...base,
					tool_name: op.tool_name,
					tool_input: { ...(op.tool_name === "Edit" ? cleanBase : rawInput), ...op.tool_input },
				})),
			};
		}
		return { payloads: [{ ...base, tool_name: "apply_patch", tool_input: { ...rawInput, patch } }] };
	}
	return classifyUnknownTool(base, rawName, leaf, rawInput, shouldExpandPatch);
}

/** Interpret one Claude gate/lifecycle hook stdout string under Muse event rules. */
function interpretClaudeOutput(rawStdout, museInput, hookLabel, eventName = "PreToolUse") {
	const trimmed = String(rawStdout || "").trim();
	if (!trimmed) return { action: "allow" };

	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		if (!STRICT_FAIL_CLOSED_EVENTS.has(eventName)) {
			// Advisory PostToolUse/Stop scripts (e.g. sync-entry-points, context-translation-batch) log plain text on exit 0.
			return { action: "allow", systemMessage: trimmed };
		}
		return { action: "halt", output: haltOutput(eventName, `[muse-gate-adapter] Gate "${hookLabel}" returned non-JSON stdout (fail-closed).`) };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { action: "halt", output: haltOutput(eventName, `[muse-gate-adapter] Gate "${hookLabel}" returned non-object JSON stdout (fail-closed).`) };
	}

	if (parsed.hookSpecificOutput !== undefined) {
		const hso = parsed.hookSpecificOutput;
		if (!hso || typeof hso !== "object" || Array.isArray(hso)) {
			return { action: "halt", output: haltOutput(eventName, `[muse-gate-adapter] Gate "${hookLabel}" returned invalid hookSpecificOutput (fail-closed).`) };
		}
		if (eventName === "PreToolUse") {
			if (hso.permissionDecision === "deny") {
				return { action: "halt", output: denyOutput(firstNonEmpty(hso.permissionDecisionReason, parsed.reason, `[muse-gate-adapter] Blocked by ${hookLabel}.`)) };
			}
			if (hso.permissionDecision === "ask") {
				return { action: "halt", output: askOrDenyOutput(firstNonEmpty(hso.permissionDecisionReason, parsed.reason), museInput, hookLabel) };
			}
			if (hso.permissionDecision !== undefined && hso.permissionDecision !== "allow") {
				return { action: "halt", output: denyOutput(`[muse-gate-adapter] Gate "${hookLabel}" returned unsupported permissionDecision "${hso.permissionDecision}" (fail-closed).`) };
			}
		}
		return {
			action: "allow",
			additionalContext: typeof hso.additionalContext === "string" ? hso.additionalContext : (typeof parsed.additionalContext === "string" ? parsed.additionalContext : null),
			systemMessage: typeof parsed.systemMessage === "string" ? parsed.systemMessage : null,
			updatedInput: eventName === "PreToolUse" && hso.permissionDecision === "allow" && hso.updatedInput && typeof hso.updatedInput === "object" ? hso.updatedInput : null,
		};
	}

	if (parsed.decision === "block") {
		const reason = firstNonEmpty(parsed.reason, `[muse-gate-adapter] Blocked by ${hookLabel}.`);
		// Stop, PostToolUse, and UserPromptSubmit support { decision: "block", reason } natively in Muse;
		// PreCompact and PreToolUse reject top-level decision:"block" and must use haltOutput(eventName, reason).
		if (eventName === "Stop" || eventName === "PostToolUse" || eventName === "UserPromptSubmit") {
			return { action: "halt", output: { decision: "block", reason } };
		}
		return { action: "halt", output: haltOutput(eventName, reason) };
	}
	if (parsed.continue === false) {
		const reason = firstNonEmpty(parsed.stopReason, parsed.reason, `[muse-gate-adapter] Stopped by ${hookLabel}.`);
		return { action: "halt", output: haltOutput(eventName, reason) };
	}
	if (parsed.decision !== undefined && parsed.decision !== "allow") {
		return { action: "halt", output: haltOutput(eventName, `[muse-gate-adapter] Gate "${hookLabel}" returned unsupported decision "${parsed.decision}" (fail-closed).`) };
	}

	return {
		action: "allow",
		additionalContext: typeof parsed.additionalContext === "string" ? parsed.additionalContext : null,
		systemMessage: typeof parsed.systemMessage === "string" ? parsed.systemMessage : null,
	};
}

/** Normalize a hook spec string or entry object `{ path, args, matcher }`. */
function normalizeHookEntry(hookSpec) {
	if (typeof hookSpec === "string") return { path: hookSpec, args: [], matcher: null };
	return {
		path: hookSpec.path,
		args: Array.isArray(hookSpec.args) ? hookSpec.args : [],
		matcher: hookSpec.matcher || null,
	};
}

/** Invoke one child gate/lifecycle hook script via Node and translate its result. */
function runSingleHook(hookSpec, claudePayload, museInput, opts = {}) {
	const eventName = opts.event || claudePayload?.hook_event_name || "PreToolUse";
	const entry = normalizeHookEntry(hookSpec);
	if (entry.matcher && !entry.matcher.test(String(claudePayload?.tool_name || ""))) {
		return { action: "allow", skipped: true };
	}

	const hookAbs = path.isAbsolute(entry.path) ? entry.path : path.resolve(CODE_ROOT, entry.path);
	const hookLabel = path.basename(hookAbs);
	if (!fs.existsSync(hookAbs)) {
		return { action: "halt", output: haltOutput(eventName, `[muse-gate-adapter] Gate hook script not found: ${hookAbs} (fail-closed).`) };
	}

	const baseEnv = { ...(opts.env || process.env) };
	if (opts.adkRoot) baseEnv.NAIA_ADK_ROOT = path.resolve(opts.adkRoot);
	if (opts.costPolicy) baseEnv.NAIA_COST_GUARD_POLICY = opts.costPolicy;
	if (opts.modelPolicy) baseEnv.NAIA_SUBAGENT_MODEL_POLICY = opts.modelPolicy;
	if (!baseEnv.CLAUDE_PROJECT_DIR) baseEnv.CLAUDE_PROJECT_DIR = claudePayload.cwd || process.cwd();

	// subagent-spawn-guard.js only inspects SPAWN_TOOLS (does not include Workflow); map Workflow -> Agent for it
	// without modifying .claude/hooks/subagent-spawn-guard.js, while subagent-model-guard.cjs sees native Workflow.
	const effectivePayload =
		hookLabel === "subagent-spawn-guard.js" && claudePayload.tool_name === "Workflow"
			? { ...claudePayload, tool_name: "Agent" }
			: claudePayload;

	const execCwd = claudePayload.cwd && fs.existsSync(claudePayload.cwd) ? claudePayload.cwd : process.cwd();
	const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
	const runner = opts.spawnSync || cp.spawnSync;
	const res = runner(process.execPath, [hookAbs, ...entry.args], {
		input: JSON.stringify(effectivePayload),
		cwd: execCwd,
		env: baseEnv,
		encoding: "utf8",
		shell: false,
		timeout: timeoutMs,
		killSignal: "SIGKILL",
		maxBuffer: MAX_OUTPUT_BYTES,
	});

	if (res.stderr && String(res.stderr).trim()) {
		(opts.onStderr || ((msg) => process.stderr.write(msg)))(res.stderr);
	}

	if (res.error) {
		const detail = res.error.code || res.error.message || "spawn error";
		return { action: "halt", output: haltOutput(eventName, `[muse-gate-adapter] Gate "${hookLabel}" execution failed (${detail}) (fail-closed).`) };
	}
	if (res.signal) {
		return { action: "halt", output: haltOutput(eventName, `[muse-gate-adapter] Gate "${hookLabel}" terminated by signal ${res.signal} (fail-closed).`) };
	}
	if (res.status === 2) {
		const interpreted = res.stdout && String(res.stdout).trim()
			? interpretClaudeOutput(res.stdout, museInput, hookLabel, eventName)
			: null;
		if (interpreted?.action === "halt") return interpreted;
		const reason = firstNonEmpty(String(res.stderr || ""), String(res.stdout || ""), `[muse-gate-adapter] Blocked by ${hookLabel} (exit 2).`);
		return { action: "halt", output: haltOutput(eventName, reason) };
	}
	if (res.status !== 0) {
		const errNote = firstNonEmpty(String(res.stderr || "")).split("\n")[0];
		const suffix = errNote ? `: ${errNote.slice(0, 200)}` : "";
		if (!STRICT_FAIL_CLOSED_EVENTS.has(eventName)) {
			// Match Claude non-blocking PostToolUse/Stop/SessionStart exit-1 behavior while surfacing diagnostic.
			return { action: "allow", systemMessage: `[muse-gate-adapter] ${hookLabel} exited with status ${res.status}${suffix}` };
		}
		return { action: "halt", output: haltOutput(eventName, `[muse-gate-adapter] Gate "${hookLabel}" exited with status ${res.status}${suffix} (fail-closed).`) };
	}

	return interpretClaudeOutput(res.stdout, museInput, hookLabel, eventName);
}

/** Build ordered list of hook entries from opts.hookEntries or opts.hooks. */
function resolveHookEntries(opts) {
	if (Array.isArray(opts.hookEntries) && opts.hookEntries.length > 0) return opts.hookEntries;
	if (Array.isArray(opts.hooks) && opts.hooks.length > 0) return opts.hooks.map((p) => ({ path: p, args: [], matcher: null }));
	return [];
}

/** Evaluate all configured hooks against one Muse event payload with cumulative deadline enforcement. */
function evaluateMuseEvent(museInput, opts = {}) {
	const eventName = opts.event || museInput?.hook_event_name || "PreToolUse";
	if (opts.parseError) {
		return haltOutput(eventName, `[muse-gate-adapter] Invalid adapter options (${opts.parseError}) (fail-closed).`);
	}
	const entries = resolveHookEntries(opts);
	if (entries.length === 0) {
		return haltOutput(eventName, "[muse-gate-adapter] No target gate hook specified via --hook (fail-closed).");
	}
	const translated = translateInput(museInput, { ...opts, event: eventName });
	if (translated.error) {
		return haltOutput(eventName, translated.error);
	}
	if (translated.unknownTool) {
		(opts.onStderr || ((msg) => process.stderr.write(msg)))(`[muse-gate-adapter] Unknown tool passthrough: ${translated.unknownTool}\n`);
	}

	const contexts = [];
	const systemMessages = [];
	let updatedInput = null;

	const startedAt = Date.now();
	const effectiveDeadlineMs = opts.deadlineMs || Math.max(opts.timeoutMs || DEFAULT_TIMEOUT_MS, DEFAULT_DEADLINE_MS);
	const baseTimeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

	const payloads = translated.payloads.length > 1
		? translated.payloads.map((p, idx) => (typeof p.tool_use_id === "string" && p.tool_use_id ? { ...p, tool_use_id: `${p.tool_use_id}#${idx}` } : p))
		: translated.payloads;

	for (let payloadIndex = 0; payloadIndex < payloads.length; payloadIndex += 1) {
		const payload = payloads[payloadIndex];
		for (const entry of entries) {
			if (payloadIndex > 0 && SESSION_ONCE_HOOKS.has(path.basename(entry.path))) continue;
			if (entry.matcher && !entry.matcher.test(String(payload?.tool_name || ""))) continue;

			const elapsedMs = Date.now() - startedAt;
			const remainingMs = effectiveDeadlineMs - elapsedMs;
			if (remainingMs <= DEADLINE_GUARD_MARGIN_MS && elapsedMs > 0) {
				return haltOutput(
					eventName,
					`[muse-gate-adapter] Cumulative gate deadline (${effectiveDeadlineMs}ms) exceeded before running ${path.basename(entry.path)} (fail-closed).`,
				);
			}
			const usableRemainingMs = remainingMs > DEADLINE_GUARD_MARGIN_MS ? remainingMs - DEADLINE_GUARD_MARGIN_MS : remainingMs;
			const childTimeoutMs = Math.max(1, Math.min(baseTimeoutMs, usableRemainingMs > 0 ? usableRemainingMs : 1));
			const res = runSingleHook(entry, payload, museInput, { ...opts, event: eventName, timeoutMs: childTimeoutMs });
			if (res.action !== "allow") {
				return res.output;
			}
			if (res.additionalContext) contexts.push(res.additionalContext);
			if (res.systemMessage) systemMessages.push(res.systemMessage);
			if (res.updatedInput) updatedInput = res.updatedInput;
		}
	}

	const out = {};
	const supportsAdditionalContext = EVENTS_WITH_ADDITIONAL_CONTEXT.has(eventName);
	if (contexts.length && !supportsAdditionalContext) {
		systemMessages.push(...contexts);
	}
	if ((contexts.length && supportsAdditionalContext) || updatedInput) {
		out.hookSpecificOutput = { hookEventName: eventName };
		if (contexts.length && supportsAdditionalContext) out.hookSpecificOutput.additionalContext = contexts.join("\n");
		if (updatedInput && eventName === "PreToolUse") {
			out.hookSpecificOutput.permissionDecision = "allow";
			out.hookSpecificOutput.updatedInput = updatedInput;
		}
	}
	if (systemMessages.length) {
		out.systemMessage = systemMessages.join("\n");
	}
	return Object.keys(out).length ? out : null;
}

/** Backward-compatible PreToolUse evaluator alias. */
function evaluateMusePreToolUse(museInput, opts = {}) {
	return evaluateMuseEvent(museInput, { event: "PreToolUse", ...opts });
}

/** Read stdin, run Muse gate/lifecycle evaluation, and emit JSON only when required. */
async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const eventName = opts.event || "PreToolUse";
	const stdinDeadlineMs = opts.deadlineMs || Math.max(opts.timeoutMs || DEFAULT_TIMEOUT_MS, DEFAULT_DEADLINE_MS);
	const stdinGuardTimer = setTimeout(() => {
		process.stdout.write(JSON.stringify(haltOutput(eventName, `[muse-gate-adapter] Timed out waiting for Muse ${eventName} stdin after ${stdinDeadlineMs}ms (fail-closed).`)));
		process.exit(0);
	}, stdinDeadlineMs);
	stdinGuardTimer.unref();

	let raw = "";
	try {
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) raw += chunk;
	} catch (error) {
		clearTimeout(stdinGuardTimer);
		process.stdout.write(JSON.stringify(haltOutput(eventName, `[muse-gate-adapter] Failed reading hook stdin (${error?.message || error}) (fail-closed).`)));
		return;
	}
	clearTimeout(stdinGuardTimer);

	let museInput;
	try {
		museInput = JSON.parse(raw);
	} catch {
		process.stdout.write(JSON.stringify(haltOutput(eventName, `[muse-gate-adapter] Invalid Muse ${eventName} stdin JSON (fail-closed).`)));
		return;
	}

	const output = evaluateMuseEvent(museInput, opts);
	if (output) {
		process.stdout.write(JSON.stringify(output));
	}
}

if (require.main === module) {
	main().catch((error) => {
		const idx = process.argv.indexOf("--event");
		const eventName = idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : "PreToolUse";
		process.stdout.write(JSON.stringify(haltOutput(eventName, `[muse-gate-adapter] Unexpected adapter failure (${error?.message || error}) (fail-closed).`)));
		process.exitCode = 0;
	});
}

module.exports = {
	CODE_ROOT,
	DEFAULT_DEADLINE_MS,
	DEFAULT_TIMEOUT_MS,
	askOrDenyOutput,
	denyOutput,
	evaluateMuseEvent,
	evaluateMusePreToolUse,
	expandPatchOperations,
	haltOutput,
	interpretClaudeOutput,
	parseArgs,
	runSingleHook,
	translateInput,
};
