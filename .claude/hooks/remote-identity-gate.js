#!/usr/bin/env node
/**
 * Remote Identity Gate (PreToolUse on Bash).
 *
 * Blocks pushes, remote rewiring, clones and public repository creation that
 * contradict the workspace index (which repository lives at which path, and
 * whether it is private). Logic lives in .agents/hooks/core/remote-identity.js
 * so every host (Claude, Codex, pi) enforces the same rule.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const roleMode = fs.existsSync(path.join(projectDir, ".naia-role.json"));
let core;
try {
	core = require("../../.agents/hooks/core/remote-identity.js");
} catch (error) {
	if (!roleMode) throw error;
	process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Remote identity policy module is unavailable (fail-closed)." }));
	process.exit(0);
}

function evaluateProfile(command, cwd) {
	const explicitRoot = process.env.NAIA_ADK_ROOT;
	if (!roleMode) return core.evaluate({ command, cwd });
	const text = core.stripHeredocs(command);
	const stripped = text.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|")) return null;
	const git = core.gitInvocations(text).filter((inv) =>
		["push", "clone"].includes(inv.subcommand) ||
		(inv.subcommand === "remote" && ["add", "set-url"].includes(inv.args.filter((arg) => !arg.startsWith("-"))[0])));
	const publicOps = core.ghRepoInvocations(text).filter((inv) => {
		if (inv.subcommand === "create") return inv.args.includes("--public");
		if (inv.subcommand !== "edit") return false;
		// Mirror the core's first-option and case handling exactly.
		const index = inv.args.findIndex((arg) => arg === "--visibility" || arg.startsWith("--visibility="));
		if (index === -1) return false;
		const value = inv.args[index].includes("=") ? inv.args[index].split("=")[1] : inv.args[index + 1];
		return String(value || "").toLowerCase() === "public";
	});
	if (!git.length && !publicOps.length) return null;
	const root = path.resolve(explicitRoot || projectDir);
	try {
		const index = fs.readFileSync(path.join(root, ".agents", "context", "project-index.yaml"), "utf8");
		if (!/^submodules:/m.test(index)) throw new Error("invalid workspace index");
		const rules = JSON.parse(fs.readFileSync(path.join(root, ".agents", "context", "agents-rules.json"), "utf8"));
		if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error("invalid rules");
	} catch {
		return { decision: "block", reason: "[Harness] Remote operation refused: ADK identity policy is missing or invalid (fail-closed)." };
	}
	const deps = { catalogue: core.loadCatalogue(root) };
	const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
	// Keep git's real target directory. Only approval records for public gh
	// operations belong to the shared ADK root, not to a role folder.
	const base = core.commandDirectory(text, cwd);
	for (const inv of git) {
		const dir = inv.chdir ? path.resolve(base, inv.chdir) : base;
		const isolated = ["git", "-C", dir, inv.subcommand, ...inv.args].map(quote).join(" ");
		const originalDecision = core.evaluate({ command: isolated, cwd: base });
		if (originalDecision) return originalDecision;
		const localDecision = core.evaluate({ command: isolated, cwd: dir });
		if (localDecision) return localDecision;
		const decision = core.evaluate({ command: isolated, cwd: root, deps });
		if (decision) return decision;
	}
	for (const inv of publicOps) {
		const isolated = ["gh", "repo", inv.subcommand, ...inv.args].map(quote).join(" ");
		const decision = core.evaluate({ command: isolated, cwd: root, deps });
		if (decision) return decision;
	}
	return null;
}

async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try { data = JSON.parse(input); } catch { process.exit(0); }
	if ((data.tool_name || "") !== "Bash") process.exit(0);
	const command = data.tool_input?.command || "";
	let result = null;
	try { result = evaluateProfile(command, data.cwd || process.cwd()); }
	catch {
		result = roleMode
			? { decision: "block", reason: "[Harness] ADK identity policy could not be verified (fail-closed)." }
			: null;
	}
	if (result) process.stdout.write(JSON.stringify(result));
	process.exit(0);
}

main().catch(() => process.exit(0));
