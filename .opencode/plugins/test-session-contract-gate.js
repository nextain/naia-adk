#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionContractGate, findHarnessRoot, toGateEvent } from "./session-contract-gate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// ── translation: opencode tool calls → gate payload ──
assert.equal(toGateEvent({ tool: "read", sessionID: "ses_1", callID: "c1" }, { filePath: "/x" }, "/repo"), null, "read is not governed");
assert.equal(toGateEvent({ tool: "task", sessionID: "ses_1", callID: "c1" }, {}, "/repo"), null, "task belongs to the fan-out guard");
const bash = toGateEvent({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { command: "git status", workdir: "sub" }, "/repo");
assert.deepEqual(bash, { cwd: path.resolve("/repo"), session_id: "ses_1", tool_name: "Bash", tool_input: { command: "git status", workdir: "sub" }, tool_use_id: "c1" });
const edit = toGateEvent({ tool: "edit", sessionID: "ses_1", callID: "c2" }, { filePath: "/repo/a.txt", oldString: "a", newString: "b" }, "/repo");
assert.equal(edit.tool_name, "Edit");
assert.equal(edit.tool_input.file_path, "/repo/a.txt", "opencode filePath becomes the gate's file_path");
assert.equal(toGateEvent({ tool: "multiedit", sessionID: "s", callID: "c" }, { filePath: "/repo/a.txt" }, "/repo").tool_name, "Edit");
assert.equal(toGateEvent({ tool: "write", sessionID: "s", callID: "c" }, { filePath: "/repo/a.txt", content: "" }, "/repo").tool_name, "Write");
assert.equal(toGateEvent({ tool: "apply_patch", sessionID: "s", callID: "c" }, { patchText: "*** Begin Patch" }, "/repo").tool_input.patch, "*** Begin Patch");

// ── verdict application with an injected gate ──
{
	const seen = [];
	const hooks = await SessionContractGate({ directory: "/repo" }, {
		root: "/repo",
		gate: { decide: (event) => { seen.push(event); return event.tool_name === "Write" ? { decision: "block", reason: "⛔ [HARNESS] test block" } : null; } },
	});
	await hooks["tool.execute.before"]({ tool: "read", sessionID: "ses_1", callID: "c0" }, { args: {} });
	assert.equal(seen.length, 0, "ungoverned tools never consult the gate");
	await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: { command: "ls" } });
	assert.equal(seen.length, 1, "governed tools consult the gate");
	await assert.rejects(
		hooks["tool.execute.before"]({ tool: "write", sessionID: "ses_1", callID: "c2" }, { args: { filePath: "/repo/x", content: "" } }),
		/test block/,
		"a block verdict is applied by throwing",
	);
}

// ── fail-closed when the gate cannot load ──
{
	const hooks = await SessionContractGate({ directory: "/nonexistent" }, { root: "/nonexistent" });
	await assert.rejects(
		hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: { command: "rm -rf x" } }),
		/session contract gate unavailable/,
		"a governed call with no loadable gate is blocked, not allowed",
	);
}

// ── real gate against a scratch governed root (unbound session rules) ──
{
	assert.equal(findHarnessRoot(here), repoRoot, "the plugin finds the harness root above .opencode/plugins");
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-gate-"));
	try {
		const write = (relative, value) => {
			const target = path.join(scratch, relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2));
		};
		write(".agents/context/agents-rules.json", "{}");
		write(".codex/hooks.json", "{}");
		write(".agents/session-contracts/.session-map.json", { schema_version: "1.0", bindings: {} });
		write("notes.md", "hello\n");
		const realGate = (await import(path.join(repoRoot, ".codex", "hooks", "session-contract-gate.cjs"))).default;
		const hooks = await SessionContractGate({ directory: scratch }, {
			root: repoRoot,
			gate: realGate,
			env: { ...process.env, ADK_PROJECT_ROOT: "", AI_HARNESS: "", CLAUDE_HARNESS: "", CODEX_HARNESS: "" },
			dependencies: { resolveHookProjectRoot: () => scratch, processCwd: scratch },
		});
		await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_unbound", callID: "c1" }, { args: { command: "git status --short" } });
		await hooks["tool.execute.before"]({ tool: "edit", sessionID: "ses_unbound", callID: "c2" }, { args: { filePath: path.join(scratch, "notes.md"), oldString: "hello", newString: "bye" } });
		await assert.rejects(
			hooks["tool.execute.before"]({ tool: "write", sessionID: "ses_unbound", callID: "c3" }, { args: { filePath: path.join(scratch, ".agents", "context", "agents-rules.json"), content: "{}" } }),
			/HARNESS/,
			"an unbound session cannot rewrite governance files through opencode either",
		);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

console.log("opencode session contract plugin: PASS");
