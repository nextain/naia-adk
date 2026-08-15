#!/usr/bin/env node
/**
 * Host-neutral lightweight session contract mutation gate.
 * Progress and Markdown session-id strings are diagnostics, not authority.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sessionContract = require("../../.agents/hooks/core/session-contract.js");
const sessionRecovery = require("../../.agents/harness/session-contract-recovery.cjs");
const bashPolicies = require("../../.agents/hooks/policies/bash.js");
const {
	executableReadCommand,
	explicitlyScopedRead,
	nestedModelRuntimeCommand,
	readOnlyShell,
	requestedWorkdirIssue,
	trustedSessionParserCommand,
	unsafeShellCommand,
} = require("./session-read-policy.cjs");

const HARNESS_OFF = new Set(["off", "0", "false", "no"]);
const HARNESS_ENV_VARS = ["AI_HARNESS", "CLAUDE_HARNESS", "CODEX_HARNESS"];
const HARNESS_CONFIG_DIRS = [".claude", ".codex"];
const ENTRY_POINTS = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);

function normalizedToolName(name) {
	const leaf = String(name || "").split(/[.:/]/).pop().toLowerCase();
	if (["bash", "shell_command", "exec_command"].includes(leaf)) return "shell";
	if (["write", "edit", "notebookedit", "apply_patch"].includes(leaf)) return "file-mutation";
	return leaf;
}

function patchTargets(toolInput) {
	const patch = String(toolInput?.patch ?? toolInput?.command ?? toolInput?.input ?? "");
	const targets = [];
	for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+?)\s*$/gm)) {
		targets.push(match[1]);
	}
	for (const match of patch.matchAll(/^\*\*\* Move to:\s+(.+?)\s*$/gm)) {
		targets.push(match[1]);
	}
	return targets;
}

function rawToolName(name) {
	return String(name || "").split(/[.:/]/).pop().toLowerCase();
}

function safeJson(value) {
	try { return JSON.parse(String(value)); } catch { return null; }
}

function patchSource(toolInput) {
	return String(toolInput?.patch ?? toolInput?.command ?? toolInput?.input ?? "");
}

function reconstructSingleFilePatch(toolInput, cwd) {
	const source = patchSource(toolInput).replace(/\r\n/g, "\n");
	const lines = source.split("\n");
	if (lines[0] !== "*** Begin Patch" || !lines.includes("*** End Patch")) return null;
	const headers = lines
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => /^\*\*\* (?:Add|Update|Delete) File:/.test(line));
	if (headers.length !== 1 || lines.some((line) => line.startsWith("*** Move to:"))) return null;
	const header = headers[0];
	const match = header.line.match(/^\*\*\* (Add|Update|Delete) File:\s+(.+?)\s*$/);
	if (!match || match[1] === "Delete") return null;
	const filePath = match[2];
	const end = lines.indexOf("*** End Patch", header.index + 1);
	if (end < 0 || lines.slice(end + 1).some((line) => line.trim())) return null;
	const body = lines.slice(header.index + 1, end);

	if (match[1] === "Add") {
		if (body.some((line) => !line.startsWith("+"))) return null;
		return { filePath, content: `${body.map((line) => line.slice(1)).join("\n")}\n` };
	}

	let existing;
	try { existing = fs.readFileSync(path.resolve(cwd, filePath), "utf8"); } catch { return null; }
	let current = existing.replace(/\r\n/g, "\n").split("\n");
	if (current.at(-1) === "") current.pop();
	let cursor = 0;
	let index = 0;
	let sawHunk = false;
	while (index < body.length) {
		if (!body[index].startsWith("@@")) return null;
		sawHunk = true;
		index += 1;
		const oldLines = [];
		const newLines = [];
		while (index < body.length && !body[index].startsWith("@@")) {
			const line = body[index++];
			if (line === "\\ No newline at end of file") continue;
			if (!/^[ +\-]/.test(line)) return null;
			if (line[0] !== "+") oldLines.push(line.slice(1));
			if (line[0] !== "-") newLines.push(line.slice(1));
		}
		if (oldLines.length === 0) return null;
		let found = -1;
		for (let candidate = cursor; candidate <= current.length - oldLines.length; candidate += 1) {
			if (oldLines.every((line, offset) => current[candidate + offset] === line)) {
				if (found !== -1) return null;
				found = candidate;
			}
		}
		if (found === -1) return null;
		current.splice(found, oldLines.length, ...newLines);
		cursor = found + newLines.length;
	}
	if (!sawHunk) return null;
	return { filePath, content: `${current.join("\n")}\n` };
}

function readJsonFile(filePath) {
	try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function sameJson(left, right) {
	return JSON.stringify(sessionContract.stableValue(left)) === JSON.stringify(sessionContract.stableValue(right));
}

function stateTarget(filePath, cwd) {
	const projectRoot = sessionContract.findProjectRoot(cwd);
	if (!projectRoot || !filePath) return null;
	const target = path.resolve(cwd, String(filePath));
	const contractsDir = path.join(projectRoot, ".agents", "session-contracts");
	const progressDir = path.join(projectRoot, ".agents", "progress");
	if (sessionContract.inside(contractsDir, target) && path.dirname(target) === contractsDir) {
		if (path.basename(target) === ".session-map.json") return { kind: "registry", projectRoot, target, contractsDir, progressDir };
		if (path.basename(target).endsWith(".json") && !["schema.json"].includes(path.basename(target))) return { kind: "contract", projectRoot, target, contractsDir, progressDir };
	}
	if (sessionContract.inside(progressDir, target) && path.dirname(target) === progressDir && path.basename(target).endsWith(".json")) {
		return { kind: "progress", projectRoot, target, contractsDir, progressDir };
	}
	return null;
}

function contractBindsSession(contract, sessionId) {
	return sessionContract.validateContractShape(contract) === null &&
		contract.contract_digest === sessionContract.contractDigest(contract) &&
		contract.session_bindings.filter((binding) => binding.session_id === sessionId && binding.contract_digest === contract.contract_digest).length === 1;
}

function contractByIdentity(contractsDir, contractId, digest, sessionId) {
	let names = [];
	try { names = fs.readdirSync(contractsDir); } catch { return null; }
	for (const name of names) {
		if (!name.endsWith(".json") || name.startsWith(".") || name === "schema.json") continue;
		const filePath = path.join(contractsDir, name);
		const contract = readJsonFile(filePath);
		if (contract?.id === contractId && contract.contract_digest === digest && contractBindsSession(contract, sessionId)) return { contract, filePath };
	}
	return null;
}

function bootstrapWriteAllowed(toolName, toolInput, cwd, sessionId) {
	if (rawToolName(toolName) !== "write") return false;
	const targetInfo = stateTarget(toolInput?.file_path || toolInput?.path, cwd);
	const next = safeJson(toolInput?.content);
	if (!targetInfo || !next || typeof next !== "object" || Array.isArray(next)) return false;
	const existing = readJsonFile(targetInfo.target);

	if (targetInfo.kind === "contract") {
		if (!contractBindsSession(next, sessionId)) return false;
		if (existing) {
			if (!contractBindsSession(existing, sessionId) || existing.id !== next.id) return false;
			const existingPeers = existing.session_bindings.map((binding) => binding.session_id).filter((id) => id !== sessionId).sort();
			const nextPeers = next.session_bindings.map((binding) => binding.session_id).filter((id) => id !== sessionId).sort();
			if (!sameJson(existingPeers, nextPeers)) return false;
			if (existingPeers.length > 0 && !sameJson(existing, next)) return false;
		}
		return true;
	}

	if (targetInfo.kind === "progress") {
		if (typeof next.contract_id !== "string" || !/^[a-f0-9]{64}$/.test(next.contract_digest || "")) return false;
		const owner = contractByIdentity(targetInfo.contractsDir, next.contract_id, next.contract_digest, sessionId);
		if (!owner) return false;
		const expectedPath = path.resolve(targetInfo.projectRoot, owner.contract.progress_file);
		if (expectedPath !== targetInfo.target) return false;
		if (existing && !contractByIdentity(targetInfo.contractsDir, existing.contract_id, existing.contract_digest, sessionId)) return false;
		if (sessionContract.validateOrchestratorFallbackEvidence(owner.contract, next)) return false;
		return true;
	}

	if (targetInfo.kind === "registry") {
		if (next.schema_version !== "1.0" || !next.bindings || typeof next.bindings !== "object" || Array.isArray(next.bindings)) return false;
		const pointer = next.bindings[sessionId];
		if (!pointer || typeof pointer.contract_path !== "string" || typeof pointer.contract_id !== "string" || !/^[a-f0-9]{64}$/.test(pointer.contract_digest || "")) return false;
		const contractPath = path.resolve(targetInfo.projectRoot, pointer.contract_path);
		if (!sessionContract.inside(targetInfo.contractsDir, contractPath) || path.dirname(contractPath) !== targetInfo.contractsDir) return false;
		const contract = readJsonFile(contractPath);
		if (!contract || contract.id !== pointer.contract_id || contract.contract_digest !== pointer.contract_digest || !contractBindsSession(contract, sessionId)) return false;
		const progress = readJsonFile(path.resolve(targetInfo.projectRoot, contract.progress_file));
		if (!progress || progress.contract_id !== contract.id || progress.contract_digest !== contract.contract_digest) return false;
		if (!existing && Object.keys(next.bindings).some((boundSession) => boundSession !== sessionId)) return false;
		if (existing?.bindings) {
			for (const boundSession of Object.keys(next.bindings)) {
				if (boundSession !== sessionId && !Object.hasOwn(existing.bindings, boundSession)) return false;
			}
			for (const [boundSession, oldPointer] of Object.entries(existing.bindings)) {
				if (boundSession !== sessionId && !sameJson(next.bindings[boundSession], oldPointer)) return false;
			}
			if (existing.bindings[sessionId]) {
				const old = existing.bindings[sessionId];
				if (!contractByIdentity(targetInfo.contractsDir, old.contract_id, old.contract_digest, sessionId)) return false;
			}
		}
		return true;
	}
	return false;
}

function bootstrapMutationAllowed(toolName, toolInput, cwd, sessionId) {
	if (rawToolName(toolName) === "write") return bootstrapWriteAllowed(toolName, toolInput, cwd, sessionId);
	if (rawToolName(toolName) !== "apply_patch") return false;
	const reconstructed = reconstructSingleFilePatch(toolInput, cwd);
	if (!reconstructed) return false;
	return bootstrapWriteAllowed("Write", {
		file_path: reconstructed.filePath,
		content: reconstructed.content,
	}, cwd, sessionId);
}

function entrypointTarget(filePath, cwd) {
	const projectRoot = sessionContract.findProjectRoot(cwd);
	if (!projectRoot || !filePath) return false;
	const target = path.resolve(cwd, String(filePath));
	return path.dirname(target) === projectRoot && ENTRY_POINTS.has(path.basename(target));
}

function entrypointMutationOutsideHelper(toolName, toolInput, cwd) {
	const normalized = normalizedToolName(toolName);
	if (normalized === "file-mutation") {
		const directPath = toolInput?.file_path || toolInput?.path;
		if (directPath) return entrypointTarget(directPath, cwd);
		return patchTargets(toolInput).some((target) => entrypointTarget(target, cwd));
	}
	if (normalized !== "shell") return false;
	const command = String(toolInput?.command || "").trim();
	if (readOnlyShell(command, cwd)) return false;
	const dedicatedHelper = /^node\s+(?:"[^"]*\/\.claude\/hooks\/sync-entry-points\.js"|(?:[^\s"']*\/)?\.claude\/hooks\/sync-entry-points\.js)\s+--apply\s+(?:"[^"]+"|'[^']+'|\S+)\s*$/;
	if (dedicatedHelper.test(command)) return false;
	const mentionsEntry = [...ENTRY_POINTS].some((name) =>
		new RegExp(`(?:^|[\\s/\\\\'\"])+${name.replace(".", "\\.")}(?:$|[\\s'\"]+)`).test(command),
	);
	const mutates = /[>]|\b(?:sed|perl|python|node|cp|mv|install|touch|truncate|rm|tee|set-content|add-content|out-file|copy-item|move-item|remove-item|rename-item)\b/i.test(command);
	return mentionsEntry && mutates;
}

function fileMutationTargets(toolInput) {
	const directPath = toolInput?.file_path || toolInput?.path;
	if (directPath) return [directPath];
	return patchTargets(toolInput);
}

/**
 * Paths whose contents decide what any session is allowed to do. An unbound
 * session must never be able to widen its own authority, so these stay behind a
 * contract even though ordinary project files no longer do.
 */
function governedTarget(target, projectRoot) {
	const relative = path.relative(projectRoot, target).replaceAll("\\", "/");
	if (relative.startsWith(".agents/")) return true;
	return HARNESS_CONFIG_DIRS.some((dir) => relative === dir || relative.startsWith(`${dir}/`));
}

/**
 * What an unbound session may change without bootstrapping a contract.
 *
 * The previous carve-out allowed only new files under tmp/ or deliverables/.
 * Measured against a marker-free checkout that left ordinary work — a new
 * document, an edit to an existing file, anything inside a subproject — blocked,
 * which is why every session ended up running with the harness disabled
 * entirely. A guard nobody can work under is not enforcing anything.
 *
 * So ordinary project files are now editable while unbound, and the contract
 * requirement is kept for the operations that are actually dangerous or that
 * could escalate this session's own authority: deletion, entrypoints, and the
 * harness/governance directories.
 */
function unboundOrdinaryMutationAllowed(toolName, toolInput, cwd) {
	if (normalizedToolName(toolName) !== "file-mutation") return false;
	const raw = rawToolName(toolName);
	if (!new Set(["write", "edit", "notebookedit", "apply_patch"]).has(raw)) return false;
	// Deletion is not recoverable from the transcript; it keeps needing a contract.
	if (raw === "apply_patch" && /^\*\*\* Delete File:/m.test(patchSource(toolInput))) return false;
	const projectRoot = sessionContract.findProjectRoot(cwd);
	const targets = fileMutationTargets(toolInput);
	if (!projectRoot || targets.length === 0) return false;
	return targets.every((filePath) => ordinaryUnboundTarget(filePath, cwd));
}

function ordinaryUnboundTarget(filePath, cwd) {
	const projectRoot = sessionContract.findProjectRoot(cwd);
	if (!projectRoot || !filePath) return false;
	const raw = String(filePath).replace(/^(?:"|')|(?:"|')$/g, "");
	if (path.sep !== "\\" && path.win32.isAbsolute(raw)) return false;
	let target = path.resolve(cwd, raw);
	let ancestor = target;
	while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
	try { target = path.join(fs.realpathSync(ancestor), path.relative(ancestor, target)); } catch { return false; }
	if (!sessionContract.inside(projectRoot, target)) return false;
	if (entrypointTarget(target, cwd) || stateTarget(target, cwd)) return false;
	return !governedTarget(target, projectRoot);
}

function shellWords(source) {
	return (String(source).match(/"[^"]*"|'[^']*'|[^\s;&|<>]+/g) || [])
		.map((word) => word.replace(/^(?:"|')|(?:"|')$/g, ""));
}

function hasUnquotedShellOperator(command) {
	let quote = null;
	let escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = null;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (";&|><`".includes(character) || (character === "$" && command[index + 1] === "(")) return true;
	}
	return quote !== null || escaped;
}

function hasShellWordQuoteSplice(command) {
	let quote = null;
	let escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character !== quote) continue;
			quote = null;
			const next = command[index + 1];
			if (next && !/[\s;&|><)]/.test(next)) return true;
			continue;
		}
		if (character !== "'" && character !== '"') continue;
		const previous = command[index - 1];
		if (previous && !/[\s=;&|><(]/.test(previous)) return true;
		quote = character;
	}
	return quote !== null || escaped;
}

function shellPolicyCommand(command) {
	const source = String(command || "");
	// Backslash is a path separator rather than a word escape in native
	// PowerShell. For POSIX-style shell input, remove unquoted escapes so policy
	// checks see the command Bash will actually execute (r\\m -> rm).
	if (/^\s*(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|[a-z]+-[a-z]+)\b/i.test(source)) return source;
	let result = "";
	let quote = null;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === "'" && quote !== '"') {
			quote = quote === "'" ? null : "'";
			result += character;
			continue;
		}
		if (character === '"' && quote !== "'") {
			quote = quote === '"' ? null : '"';
			result += character;
			continue;
		}
		if (character === "\\" && quote !== "'" && source[index + 1]) {
			const next = source[index + 1];
			if (quote !== '"' || /[$`"\\\n]/.test(next)) {
				result += next;
				index += 1;
				continue;
			}
		}
		result += character;
	}
	return result;
}

function unboundGitMutationAllowed(command, cwd) {
	const source = String(command || "").trim();
	if (!source || hasUnquotedShellOperator(source)) return false;
	const scoped = source.match(/^git\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+(.+)$/i);
	const gitCwd = scoped
		? path.resolve(cwd, scoped[1].replace(/^(?:"|')|(?:"|')$/g, ""))
		: cwd;
	const gitSource = scoped ? `git ${scoped[2]}` : source;
	const projectRoot = sessionContract.findProjectRoot(cwd);
	if (!projectRoot || !sessionContract.inside(projectRoot, gitCwd)) return false;
	if (path.resolve(sessionContract.findProjectRoot(gitCwd) || "") !== path.resolve(projectRoot)) return false;

	const add = gitSource.match(/^git\s+add\s+(.+)$/i);
	if (add) {
		const tokens = add[1].match(/"[^"]+"|'[^']+'|\S+/g) || [];
		const targets = tokens[0] === "--" ? tokens.slice(1) : tokens;
		if (targets.length === 0 || targets.some((target) => target.startsWith("-"))) return false;
		return targets.every((target) => ordinaryUnboundTarget(target, gitCwd));
	}

	if (!/^git\s+commit(?:\s+(?:-m\s+(?:"[^"]*"|'[^']*')|--message(?:=|\s+)(?:"[^"]*"|'[^']*')))+\s*$/i.test(gitSource)) return false;
	let staged = [];
	let stagedDeletions = [];
	try {
		staged = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
			cwd: gitCwd,
			encoding: "utf8",
		}).split("\0").filter(Boolean);
		stagedDeletions = execFileSync("git", ["diff", "--cached", "--diff-filter=D", "--name-only", "-z"], {
			cwd: gitCwd,
			encoding: "utf8",
		}).split("\0").filter(Boolean);
	} catch {
		return false;
	}
	return staged.length > 0 && stagedDeletions.length === 0 && staged.every((target) => ordinaryUnboundTarget(target, gitCwd));
}

/**
 * Shell equivalent of unboundOrdinaryMutationAllowed.
 *
 * Do not pre-enumerate every build and test command: that made a fresh clone
 * unusable and caused enforcement to ship disabled. Instead reject the narrow
 * classes that are irreversible, external, or can widen this session's own
 * authority, while leaving ordinary local project work available.
 */
function unboundOrdinaryShellAllowed(toolName, toolInput, cwd) {
	if (normalizedToolName(toolName) !== "shell") return false;
	const command = String(toolInput?.command || "").trim();
	const projectRoot = sessionContract.findProjectRoot(cwd);
	if (!command || !projectRoot || unsafeShellCommand(command) || hasShellWordQuoteSplice(command)) return false;
	const policyCommand = shellPolicyCommand(command);
	if (unsafeShellCommand(policyCommand)) return false;
	if (/\.agents[\\/]harness[\\/]session-contract-recovery\.cjs\b/i.test(policyCommand)) return false;
	if (bashPolicies.destructiveGit(policyCommand) || bashPolicies.catastrophicDelete(policyCommand) || bashPolicies.gitPush(policyCommand)) return false;
	// Parse a single local Git mutation before broad keyword guards inspect commit
	// message text. Chaining still fails inside unboundGitMutationAllowed.
	if (/^(?:git\s|git\s+-C\s)/i.test(command)) return unboundGitMutationAllowed(command, cwd);

	// Deletion remains contract-bound even when the target is inside the project.
	if (/\b(?:rm|rmdir|unlink|shred|mv)\b|\b(?:remove-item|clear-content|move-item|rename-item)\b|\bgit\s+(?:clean|restore)\b/i.test(policyCommand)) return false;
	// Remote effects and local authority/ownership changes are never ordinary.
	if (/\bgit\s+push\b|\b(?:npm|pnpm|yarn|bun)\s+publish\b|\b(?:chmod|chown|chgrp|setfacl)\b|\bgh\s+(?:api|issue|pr|release)\b/i.test(policyCommand)) return false;
	// Recognizable direct network writers and remote-control CLIs stay behind a
	// contract. Project scripts cannot be classified perfectly here, but common
	// direct escape hatches must not turn recovery mode into external authority.
	if (/\b(?:ssh|scp|sftp|ftp|nc|ncat|telnet)\b|\brsync\b[^;&|\n]*(?:(?:\w+@)?[\w.-]+:|rsync:\/\/)|\bdocker\s+push\b/i.test(policyCommand)) return false;
	if (/\bcurl\b[^;&|\n]*(?:(?:-X\s*|--request(?:=|\s+))(?:POST|PUT|PATCH|DELETE)\b|-[dFT](?:\s*|(?=\S))|--(?:data(?:-ascii|-binary|-raw|-urlencode)?|form(?:-string)?|json|upload-file)(?:=|\s+))|\bwget\b[^;&|\n]*(?:--(?:post-data|post-file|body-data|body-file)(?:=|\s+)|--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE)\b)/i.test(policyCommand)) return false;
	if (/\b(?:aws|gcloud|az|kubectl|helm|terraform|pulumi|vercel|flyctl)\b/i.test(policyCommand)) return false;

	const governedMention = /(?:^|[\s'"=:/\\])\.(?:agents|claude|codex|pi)(?:[\/\\]|\s|$)/i.test(policyCommand);
	const governedMutation = /[>]|\b(?:cp|mv|install|touch|truncate|mkdir|tee|set-content|add-content|out-file|new-item|move-item|copy-item|rename-item)\b|\b(?:sed|perl)\b[^;&|\n]*\s-i(?:\s|$)/i.test(policyCommand);
	if (governedMention && governedMutation) return false;

	// Known path-taking shell primitives must keep their destinations inside the
	// resolved project. More complex project scripts are governed by the same
	// ordinary-work rule, but cannot be path-inferred reliably at this boundary.
	for (const match of policyCommand.matchAll(/(?:^|[;&|\n]\s*)(?:mkdir|touch|truncate)\s+([^;&|\n]+)/gi)) {
		const targets = (match[1].match(/"[^"]+"|'[^']+'|\S+/g) || []).filter((token) => !token.startsWith("-"));
		if (targets.length === 0 || targets.some((target) => !ordinaryUnboundTarget(target, cwd))) return false;
	}
	for (const match of policyCommand.matchAll(/(?:^|[;&|\n]\s*)(?:cp|install)\s+([^;&|\n]+)/gi)) {
		const targetDirectory = match[1].match(/(?:^|\s)(?:-t|--target-directory)(?:=|\s+)("[^"]+"|'[^']+'|\S+)/i);
		const targets = shellWords(match[1]).filter((token) => !token.startsWith("-"));
		const destination = targetDirectory?.[1] || targets.at(-1);
		if (targets.length < 2 || !destination || !ordinaryUnboundTarget(destination, cwd)) return false;
	}
	for (const match of policyCommand.matchAll(/(?:^|[;&|\n]\s*)rsync\s+([^;&|\n]+)/gi)) {
		if (/(?:^|\s)--delete(?:\s|=|$)/i.test(match[1])) return false;
		const targets = shellWords(match[1]).filter((token) => !token.startsWith("-"));
		if (targets.length < 2 || !ordinaryUnboundTarget(targets.at(-1), cwd)) return false;
	}
	for (const match of policyCommand.matchAll(/(?:^|[;&|\n]\s*)(?:ln)\s+([^;&|\n]+)/gi)) {
		const targets = shellWords(match[1]).filter((token) => !token.startsWith("-"));
		if (targets.length < 2 || !ordinaryUnboundTarget(targets.at(-1), cwd)) return false;
	}
	for (const match of policyCommand.matchAll(/(?:^|[;&|\n]\s*)dd\s+([^;&|\n]+)/gi)) {
		const output = match[1].match(/(?:^|\s)of=("[^"]+"|'[^']+'|\S+)/i);
		if (!output || !ordinaryUnboundTarget(output[1], cwd)) return false;
	}
	for (const match of policyCommand.matchAll(/(?:^|[;&|\n]\s*)tee\s+([^;&|\n]+)/gi)) {
		const targets = shellWords(match[1]).filter((token) => !token.startsWith("-"));
		if (targets.length === 0 || targets.some((target) => !ordinaryUnboundTarget(target, cwd))) return false;
	}
	for (const match of policyCommand.matchAll(/\bcurl\b[^;&|\n]*?\s(?:--output-dir(?:=|\s+)|--output(?:=|\s+)|-o(?:\s+|(?=\S)))("[^"]+"|'[^']+'|[^\s;&|]+)/gi)) {
		if (!ordinaryUnboundTarget(match[1], cwd)) return false;
	}
	for (const match of policyCommand.matchAll(/\bwget\b[^;&|\n]*?\s(?:--output-document(?:=|\s+)|-O(?:\s+|(?=\S)))("[^"]+"|'[^']+'|[^\s;&|]+)/gi)) {
		if (!ordinaryUnboundTarget(match[1], cwd)) return false;
	}
	for (const match of policyCommand.matchAll(/\b(set-content|add-content|out-file|new-item|copy-item)\b\s+([^;&|\n]+)/gi)) {
		const words = shellWords(match[2]);
		const named = match[2].match(/-(?:literalpath|filepath|path|destination)(?:\s+|=)("[^"]+"|'[^']+'|\S+)/i);
		const positional = words.filter((word, index) => !word.startsWith("-") && (index === 0 || !words[index - 1].startsWith("-")));
		const target = named?.[1] || (match[1].toLowerCase() === "copy-item" ? positional.at(-1) : positional[0]);
		if (!target || !ordinaryUnboundTarget(target, cwd)) return false;
	}
	for (const match of policyCommand.matchAll(/(?:^|[^>])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
		if (!/^(?:\/dev\/null|nul)$/i.test(match[1].replace(/^(?:"|')|(?:"|')$/g, "")) && !ordinaryUnboundTarget(match[1], cwd)) return false;
	}
	for (const match of policyCommand.matchAll(/(?:^|\s)(?:&>>|&>|>>&|>&|>\|)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
		if (!/^(?:\/dev\/null|nul)$/i.test(match[1].replace(/^(?:"|')|(?:"|')$/g, "")) && !ordinaryUnboundTarget(match[1], cwd)) return false;
	}

	// Other Git mutation embedded in a shell sequence stays contract-bound.
	if (/(?:^|[;&|\n]\s*)git\s+(?!status\b|diff\b|log\b|show\b|remote\b|ls-files\b|check-ignore\b|rev-parse\b|submodule\s+status\b)/i.test(policyCommand)) return false;

	return true;
}

function contractPathMatches(pattern, relativePath) {
	const normalizedPattern = String(pattern).replaceAll("\\", "/").replace(/^\.\//, "");
	const normalizedPath = String(relativePath).replaceAll("\\", "/").replace(/^\.\//, "");
	if (normalizedPattern.endsWith("/**")) {
		const prefix = normalizedPattern.slice(0, -3).replace(/\/$/, "");
		return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
	}
	return normalizedPath === normalizedPattern;
}

function targetProjectRoot(target) {
	let probe = path.resolve(target);
	try {
		if (!fs.statSync(probe).isDirectory()) probe = path.dirname(probe);
	} catch {
		probe = path.dirname(probe);
	}
	return sessionContract.findProjectRoot(probe);
}

function belongsToResolutionProject(resolution, target) {
	const targetRoot = targetProjectRoot(target);
	return !targetRoot || path.resolve(targetRoot) === path.resolve(resolution.projectRoot);
}

function contractAllowsTarget(resolution, filePath, cwd) {
	const target = path.resolve(cwd, String(filePath));
	if (!sessionContract.inside(resolution.projectRoot, target)) return false;
	if (!belongsToResolutionProject(resolution, target)) return false;
	const relative = path.relative(resolution.projectRoot, target).replaceAll("\\", "/");
	return [resolution.contract.allowed_paths, resolution.contract.target_ownership]
		.every((patterns) => patterns.some((pattern) => contractPathMatches(pattern, relative)));
}

function fallbackAllowsTarget(resolution, access, filePath, cwd) {
	if (!access?.active) return false;
	const target = path.resolve(cwd, String(filePath));
	if (!sessionContract.inside(resolution.projectRoot, target)) return false;
	if (!belongsToResolutionProject(resolution, target)) return false;
	const relative = path.relative(resolution.projectRoot, target).replaceAll("\\", "/");
	return access.allowedPaths.some((pattern) => contractPathMatches(pattern, relative));
}

function boundGitMutationAllowed(command, resolution, cwd) {
	const source = String(command || "").trim();
	if (!source || /[;&|><`]/.test(source) || /\$\(/.test(source)) return false;
	const scoped = source.match(/^git\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+(.+)$/i);
	const gitCwd = scoped
		? path.resolve(cwd, scoped[1].replace(/^(?:"|')|(?:"|')$/g, ""))
		: cwd;
	const gitSource = scoped ? `git ${scoped[2]}` : source;
	if (!sessionContract.inside(resolution.projectRoot, gitCwd)) return false;
	const gitProjectRoot = sessionContract.findProjectRoot(gitCwd);
	if (!gitProjectRoot || path.resolve(gitProjectRoot) !== path.resolve(resolution.projectRoot)) return false;

	const add = gitSource.match(/^git\s+add\s+(.+)$/i);
	if (add) {
		const tokens = add[1].match(/"[^"]+"|'[^']+'|\S+/g) || [];
		const targets = tokens[0] === "-u" ? tokens.slice(1) : tokens;
		if (targets.length === 0 || targets.some((target) => target.startsWith("-"))) return false;
		return targets.every((target) =>
			contractAllowsTarget(resolution, target.replace(/^(?:"|')|(?:"|')$/g, ""), gitCwd),
		);
	}
	const commitOnly = gitSource.match(
		/^git\s+commit\s+--only\s+(.+)\s+-m\s+(?:"[\s\S]*"|'[\s\S]*')$/i,
	);
	if (commitOnly) {
		const targets = commitOnly[1].match(/"[^"]+"|'[^']+'|\S+/g) || [];
		return targets.length > 0 && targets.every((target) =>
			contractAllowsTarget(resolution, target.replace(/^(?:"|')|(?:"|')$/g, ""), gitCwd),
		);
	}

	if (/^git\s+commit\s+-m\s+(?:"[\s\S]*"|'[\s\S]*')$/i.test(gitSource)) {
		let staged = [];
		try {
			staged = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
				cwd: gitCwd,
				encoding: "utf8",
			}).split("\0").filter(Boolean);
		} catch {
			return false;
		}
		return staged.length > 0 && staged.every((target) =>
			contractAllowsTarget(resolution, target, gitCwd),
		);
	}

	return /^git\s+push(?:\s+origin(?:\s+[A-Za-z0-9._\/-]+)?)?$/i.test(gitSource) &&
		!/(?:--force|-f\b|--delete)/i.test(gitSource);
}

function readStdin() {
	try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

function reclaimCommandAllowed(command, sessionId) {
	const source = String(command || "").trim();
	const match = source.match(/^node\s+["']?(?:\.\/)?\.agents[\\/]harness[\\/]session-contract-recovery\.cjs["']?\s+reclaim\s+--contract\s+([A-Za-z0-9][A-Za-z0-9._-]{0,199})\s+--session\s+([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/);
	return Boolean(match && match[2] === sessionId);
}

/**
 * Recording an approval must not need the authority it is about to grant.
 *
 * A session that is stuck asks a third party — a human, a reviewer, a
 * supervising agent — to approve its recovery. If the shell policy blocks the
 * command that writes that approval, the only way out of a bad binding runs
 * through the binding itself, and an unattended runtime never gets out. The
 * helper validates the authority, scope and expiry on its own; the gate only
 * has to let it be called in exactly this shape.
 */
function approvalCommandAllowed(command) {
	const source = String(command || "").trim();
	return /^node\s+["']?(?:\.\/)?\.agents[\\/]harness[\\/]session-contract-recovery\.cjs["']?\s+approve\s+--contract\s+[A-Za-z0-9][A-Za-z0-9._-]{0,199}\s+--authority\s+["']?[A-Za-z0-9_]+:[A-Za-z0-9._-]{1,199}["']?\s+--scope\s+[A-Za-z0-9_]{1,64}\s+--reason\s+.{1,500}$/.test(source);
}

/**
 * Whether a shell command is trying to rewrite this session's own binding.
 *
 * Used only to answer better when refusing. The gate cannot verify the contents
 * of an arbitrary shell write, so it still refuses — but "declare it in
 * allowed_shell_commands" is not an exit when the file being written is the
 * contract that carries that list. The message has to name a door that opens.
 */
function touchesOwnBindingFiles(command) {
	const source = String(command || "");
	return /\.agents[\\/](?:session-contracts|progress)[\\/]/.test(source)
		|| /\.session-map\.json/.test(source);
}

function decide(data = {}, env = process.env, dependencies = {}) {
	const resolveHookProjectRoot = dependencies.resolveHookProjectRoot || sessionContract.resolveHookProjectRoot;
	const resolveSessionContract = dependencies.resolveSessionContract || sessionContract.resolveSessionContract;
	let cwd;
	try { cwd = resolveHookProjectRoot(data.cwd || process.cwd(), env) || data.cwd || process.cwd(); }
	catch (error) { return { decision: "block", reason: `⛔ [HARNESS] ${error.code || "inherited_project_root_invalid"}` }; }
	const sessionId = data.session_id || null;
	const toolName = data.tool_name || "";
	const toolInput = data.tool_input || {};
	if (HARNESS_ENV_VARS.some((name) => HARNESS_OFF.has((env[name] || "").trim().toLowerCase()))) return null;
	if (HARNESS_CONFIG_DIRS.some((dir) => fs.existsSync(path.join(cwd, dir, "no-harness")))) return null;
	if (!sessionId) return null;
	if (!sessionContract.findProjectRoot(cwd)) {
		// cwd cannot be resolved to a governed project root (host-reported cwd
		// outside the repo, stale workdir, etc). Do not blanket-allow: an unbound
		// session's mutating command could still target a real project path.
		// Preserve the same read-only carve-out unbound sessions already get below.
		if (normalizedToolName(toolName) === "shell" && readOnlyShell(toolInput.command, cwd)) return null;
		return {
			decision: "block",
			reason: "⛔ [HARNESS] 현재 workdir에서 프로젝트 루트를 확인할 수 없어 계약 범위를 검증할 수 없습니다. 읽기 전용 조사만 허용됩니다.",
		};
	}
	if (entrypointMutationOutsideHelper(toolName, toolInput, cwd)) {
		return {
			decision: "block",
			reason: "⛔ [HARNESS] 공유 진입점은 전용 validator를 거쳐야 합니다. 후보 파일을 만든 뒤 `node .claude/hooks/sync-entry-points.js --apply <candidate>`를 사용하세요.",
		};
	}
	if (normalizedToolName(toolName) === "shell" && reclaimCommandAllowed(toolInput.command, sessionId)) return null;
	if (normalizedToolName(toolName) === "shell" && approvalCommandAllowed(toolInput.command)) return null;
	if (normalizedToolName(toolName) === "shell" && nestedModelRuntimeCommand(toolInput.command)) {
		return {
			decision: "block",
			reason: "⛔ [HARNESS] 셸에서 Codex/Claude/OpenCode/Gemini 런타임을 중첩 실행할 수 없습니다. digest-bound governed spawn 도구를 사용하세요.",
		};
	}
	if (normalizedToolName(toolName) === "shell" && executableReadCommand(toolInput.command)) {
		return {
			decision: "block",
			reason: "⛔ [HARNESS] 실행 가능한 read 전처리기는 mutation 및 중첩 런타임 우회가 가능하므로 사용할 수 없습니다.",
		};
	}
	const workdirIssue = requestedWorkdirIssue(toolInput, cwd);
	if (workdirIssue && !(workdirIssue === "mismatch" && normalizedToolName(toolName) === "shell" && explicitlyScopedRead(toolInput.command, cwd))) {
		return {
			decision: "block",
			reason: workdirIssue === "invalid"
				? "⛔ [HARNESS] 요청한 workdir가 존재하는 디렉터리인지 검증할 수 없습니다."
				: "⛔ [HARNESS] 요청한 workdir와 훅이 검증한 실행 루트가 다릅니다. 런타임이 workdir를 무시할 수 있으므로 `git -C <절대경로> ...` 또는 PowerShell `Get-Content -LiteralPath <절대경로>`처럼 명령 자체에 대상을 고정하세요.",
		};
	}
	if (process.platform === "win32" && normalizedToolName(toolName) === "shell") {
		const executionRoot = sessionContract.findProjectRoot(dependencies.processCwd || process.cwd());
		const governedRoot = sessionContract.findProjectRoot(cwd);
		if (executionRoot && governedRoot && path.resolve(executionRoot) !== path.resolve(governedRoot) && !explicitlyScopedRead(toolInput.command, governedRoot)) {
			return {
				decision: "block",
				reason: `⛔ [HARNESS] Windows login shell root mismatch: actual=${executionRoot}, governed=${governedRoot}. Use an absolute -Path/-LiteralPath read or git -C <absolute-path>; relative shell evidence is invalid.`,
			};
		}
	}

	const resolution = resolveSessionContract({ cwd, sessionId });
	// A derived worker already has a verified, parent-owned contract. It must
	// never replace that authority by bootstrapping an explicit child contract.
	if (resolution.reason !== "derived_delegation_verified" && bootstrapMutationAllowed(toolName, toolInput, cwd, sessionId)) return null;
	if (resolution.status !== sessionContract.STATES.BOUND && unboundOrdinaryMutationAllowed(toolName, toolInput, cwd)) return null;
	if (resolution.status !== sessionContract.STATES.BOUND && unboundOrdinaryShellAllowed(toolName, toolInput, cwd)) return null;
	if (resolution.status === sessionContract.STATES.BOUND) {
		if (resolution.derivedTask?.read_only === true) {
			if (normalizedToolName(toolName) === "file-mutation") {
				return { decision: "block", reason: "⛔ [HARNESS] 이 파생 워커 계약은 read_only이며 파일 변경을 허용하지 않습니다." };
			}
			if (normalizedToolName(toolName) === "shell" && !readOnlyShell(toolInput.command, cwd)) {
				return { decision: "block", reason: "⛔ [HARNESS] 이 파생 워커 계약은 read_only이며 변경 가능 셸 명령을 허용하지 않습니다." };
			}
		}
		const directAccess = sessionContract.orchestratorFallbackAccess(resolution.contract, resolution.progress);
		if (normalizedToolName(toolName) === "file-mutation") {
			const targets = fileMutationTargets(toolInput);
			if (targets.length === 0) {
				return { decision: "block", reason: "⛔ [HARNESS] 파일 변경 대상을 결정할 수 없어 계약 경로 권한을 검증할 수 없습니다." };
			}
			const denied = targets.filter((target) => !contractAllowsTarget(resolution, target, cwd));
			if (denied.length > 0) {
				return { decision: "block", reason: `⛔ [HARNESS] 계약의 allowed_paths/target_ownership 밖 파일 변경: ${denied.join(", ")}` };
			}
			if (directAccess.required) {
				if (!directAccess.active) {
					return { decision: "block", reason: `⛔ [HARNESS] 오케스트레이터 직접 구현은 차단됩니다 (${directAccess.reason}). governed worker를 위임하거나 계약이 허용한 우회 증거를 기록하세요.` };
				}
				const fallbackDenied = targets.filter((target) => !fallbackAllowsTarget(resolution, directAccess, target, cwd));
				if (fallbackDenied.length > 0) {
					return { decision: "block", reason: `⛔ [HARNESS] 현재 task 직접 우회 범위 밖 파일 변경: ${fallbackDenied.join(", ")}` };
				}
			}
		}
		if (normalizedToolName(toolName) === "shell") {
			const command = String(toolInput.command || "").trim();
			if (unsafeShellCommand(command)) {
				return { decision: "block", reason: "⛔ [HARNESS] nested runtime launches and dynamically constructed shell commands are forbidden." };
			}
			const readOnly = readOnlyShell(command, cwd);
			const gitIntegration = !readOnly && boundGitMutationAllowed(command, resolution, cwd);
			if (!readOnly && directAccess.required && !gitIntegration) {
				if (!directAccess.active) {
					return { decision: "block", reason: `⛔ [HARNESS] 오케스트레이터 직접 실행은 차단됩니다 (${directAccess.reason}). 테스트·구현은 governed worker에 위임하세요.` };
				}
				if (!directAccess.exactValidators.includes(command)) {
					return { decision: "block", reason: "⛔ [HARNESS] 셸 명령이 현재 task 직접 우회의 exact_validators에 없습니다." };
				}
			}
			if (!readOnly &&
				!(resolution.contract.allowed_shell_commands || []).includes(command) &&
				!gitIntegration) {
				return {
					decision: "block",
					reason: touchesOwnBindingFiles(command)
						? "⛔ [HARNESS] 셸로는 자기 계약·progress·registry 를 고칠 수 없습니다. 게이트가 셸 명령의 결과를 확인할 수 없기 때문입니다. 파일 쓰기 도구(write/edit/apply_patch)로 같은 변경을 하면 계약↔progress↔registry 정합성을 검사한 뒤 통과합니다. 세션이 죽은 계약을 넘겨받아야 하면 `node .agents/harness/session-contract-recovery.cjs reclaim --contract <id> --session <현재 세션 id>` 를, 제3자 승인이 필요하면 같은 헬퍼의 approve 를 쓰십시오."
						: "⛔ [HARNESS] 변경 가능 셸 명령이 계약의 allowed_shell_commands에 정확히 선언되지 않았습니다.",
				};
			}
		}
		return null;
	}
	if (normalizedToolName(toolName) === "shell" && readOnlyShell(toolInput.command, cwd)) return null;

	return {
		decision: "block",
		reason: `⛔ [HARNESS] SESSION ${resolution.status} — ${resolution.reason}. 변경을 막습니다.\n` +
		"계약 없이 mutating 작업(Edit/Write/Bash) 금지.\n\n" +
		"결박 조건:\n" +
		`  1) .agents/session-contracts/.session-map.json에서 ${sessionId}를 정확히 한 active 계약에 결박\n` +
		"  2) registry digest, contract_digest, session_bindings[], progress contract reference를 일치\n" +
		"  3) 병렬 active 계약의 target_ownership 경로가 겹치지 않아야 함\n\n" +
		"계약/registry/progress 파일만 쓰는 bootstrap 편집과 읽기 전용 조사는 허용됩니다.",
	};
}

function main() {
	const raw = readStdin();
	let data = {};
	try { data = JSON.parse(raw || "{}"); } catch { /* fail-open */ }
	sessionRecovery.handleEvent("PreToolUse", raw, data.cwd || process.cwd());
	const output = decide(data);
	if (output) process.stdout.write(JSON.stringify(output));
}

if (require.main === module) main();
module.exports = { bootstrapMutationAllowed, bootstrapWriteAllowed, contractAllowsTarget, contractPathMatches, decide, entrypointMutationOutsideHelper, entrypointTarget, executableReadCommand, explicitlyScopedRead, fallbackAllowsTarget, fileMutationTargets, main, nestedModelRuntimeCommand, normalizedToolName, patchTargets, readOnlyShell, reclaimCommandAllowed, reconstructSingleFilePatch, requestedWorkdirIssue, stateTarget, trustedSessionParserCommand, unboundGitMutationAllowed, unboundOrdinaryMutationAllowed, unboundOrdinaryShellAllowed };
