#!/usr/bin/env node
/**
 * Host-neutral lightweight session contract mutation gate.
 * Progress and Markdown session-id strings are diagnostics, not authority.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sessionContract = require("../../.agents/hooks/core/session-contract.js");
const harnessSwitch = require("../../.agents/hooks/core/harness-switch.js");
const blockLog = require("../../.agents/hooks/core/harness-block-log.js");
const sessionRecovery = require("../../.agents/harness/session-contract-recovery.cjs");
const {
	executableReadCommand,
	explicitlyScopedRead,
	nestedModelRuntimeCommand,
	readOnlyShell,
	requestedWorkdirIssue,
	shellTokens,
	trustedSessionParserCommand,
	unsafeShellCommand,
} = require("./session-read-policy.cjs");

const HARNESS_OFF = new Set(["off", "0", "false", "no"]);
const HARNESS_ENV_VARS = ["AI_HARNESS", "CLAUDE_HARNESS", "CODEX_HARNESS"];
const HARNESS_CONFIG_DIRS = [".claude", ".codex", ".pi"];
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

const REVIEW_INVOKER = /(?:^|\/)(?:\.agents\/)?skills\/review-pass\/scripts\/invoke-reviewer\.mjs$/;

function reviewInvokerCommand(command, cwd) {
	const text = String(command || "");
	if (/[;&|]|\$\(|`/.test(text)) return false;
	const tokens = shellTokens(text);
	if (tokens.length < 2) return false;
	const head = path.basename(String(tokens[0])).replace(/\.(exe|cmd)$/i, "");
	if (head !== "node" && head !== "nodejs") return false;
	const script = tokens.slice(1).find((token) => !token.startsWith("-"));
	if (!script || !REVIEW_INVOKER.test(String(script).replace(/\\/g, "/"))) return false;
	const projectRoot = sessionContract.findProjectRoot(cwd);
	const resolved = path.resolve(cwd, String(script));
	return Boolean(projectRoot) && sessionContract.inside(projectRoot, resolved) && fs.existsSync(resolved);
}

/**
 * Whether a contract file *names* this session, without requiring the file to
 * still be internally consistent.
 *
 * Used only to identify the owner of an existing file. A contract whose stored
 * digest no longer matches its content is exactly the case a session has to be
 * able to repair: judging ownership with the strict check meant a single bad
 * write locked the owner out of its own contract forever, and only a human
 * editing the file by hand could release it.
 */
function contractNamesSession(contract, sessionId) {
	return Boolean(contract) && Array.isArray(contract.session_bindings) &&
		contract.session_bindings.some((binding) => binding?.session_id === sessionId);
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
			// Ownership only; the replacement itself is still checked strictly above.
			if (!contractNamesSession(existing, sessionId) || existing.id !== next.id) return false;
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
		if (!existing && Object.keys(next.bindings).some((boundSession) => boundSession !== sessionId)) {
			// The registry is unreadable but the file is there: a truncated write
			// left broken JSON. Every session then resolves to UNBOUND, and the
			// rule above — a fresh registry may hold only your own binding —
			// forbids restoring the peers, so nobody can repair it and a human has
			// to hand-edit the file. Allow the repair, but only when every peer
			// entry still matches its own contract on disk, so the writer cannot
			// invent or alter someone else's binding while restoring.
			let damaged = false;
			try { damaged = fs.statSync(targetInfo.target).isFile(); } catch { damaged = false; }
			if (!damaged) return false;
			for (const [peer, entry] of Object.entries(next.bindings)) {
				if (peer === sessionId) continue;
				if (!entry || typeof entry.contract_path !== "string" || typeof entry.contract_id !== "string" || !/^[a-f0-9]{64}$/.test(entry.contract_digest || "")) return false;
				const peerPath = path.resolve(targetInfo.projectRoot, entry.contract_path);
				if (!sessionContract.inside(targetInfo.contractsDir, peerPath) || path.dirname(peerPath) !== targetInfo.contractsDir) return false;
				const peerContract = readJsonFile(peerPath);
				if (!peerContract || peerContract.id !== entry.contract_id || peerContract.contract_digest !== entry.contract_digest) return false;
				if (!contractNamesSession(peerContract, peer)) return false;
			}
		}
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
	if (rawToolName(toolName) === "edit") {
		const filePath = toolInput?.file_path;
		const targetInfo = stateTarget(filePath, cwd);
		const oldString = toolInput?.old_string;
		const newString = toolInput?.new_string;
		if (!targetInfo || typeof oldString !== "string" || !oldString || typeof newString !== "string") return false;
		let current;
		try { current = fs.readFileSync(targetInfo.target, "utf8"); } catch { return false; }
		const occurrences = current.split(oldString).length - 1;
		if (occurrences === 0) return false;
		if (occurrences > 1 && toolInput?.replace_all !== true) return false;
		const next = toolInput?.replace_all === true
			? current.split(oldString).join(newString)
			: current.replace(oldString, newString);
		return bootstrapWriteAllowed("Write", { file_path: filePath, content: next }, cwd, sessionId);
	}
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
// The rules file already authorizes local test, lint, typecheck and build runs
// and non-destructive git as part of a bounded task, but the gate refused every
// mutating command without a bound contract — including the very commands that
// verify the edits an unbound session is allowed to make. That gap is why
// enforcement had to be switched off repository-wide. These commands verify or
// record work rather than expand authority; the allowance is read from the rules
// file so the policy stays the single source. It applies whether or not a
// contract is bound, because binding one to touch a governed file must not cost
// the ability to run the tests that verify the change. A derived delegation is
// excluded: its contract narrows the shell to its one validator deliberately.
// Unsafe forms are rejected before this runs, and anything unlisted still needs
// a contract.
/**
 * Routine-command allowance for a project root, falling back to the enclosing
 * repository's rules.
 *
 * Sub-projects are submodules carrying their own agents-rules.json. Without the
 * fallback, a policy widened at the workspace root reached only sessions whose
 * working directory was the root: a Python submodule still could not run
 * pytest. Nearer rules win for permissions so a submodule can stay narrower;
 * refusals are unioned so it can never become broader by omission.
 */
function routineAllowance(projectRoot) {
	const merged = {};
	const refusals = new Set();
	let found = false;
	for (const directory of harnessSwitch.ancestorDirectories(projectRoot)) {
		let allowance;
		try {
			const rules = JSON.parse(fs.readFileSync(path.join(directory, ".agents", "context", "agents-rules.json"), "utf8"));
			allowance = rules?.ai_workflow?.routine_action_authorization?.unbound_routine_commands;
		} catch { continue; }
		if (!allowance) continue;
		found = true;
		for (const [key, value] of Object.entries(allowance)) {
			if (key === "git_refused_subcommands") { for (const item of value || []) refusals.add(item); continue; }
			if (!Object.hasOwn(merged, key)) merged[key] = value;
		}
	}
	if (!found) return null;
	merged.git_refused_subcommands = [...refusals];
	return merged;
}

/**
 * Whether an unbound session may run this command.
 *
 * This used to be an allow-list, which made enforcement tight for a reason
 * unrelated to risk: any tool nobody had thought to enumerate was refused, so
 * a Python or Rust project could not run its own tests and ordinary
 * investigation commands were treated as mutations. The policy is now the other
 * way round — everything is routine unless it is hard to undo. Publishing,
 * deleting, deploying, escalating privilege and reaching other machines still
 * need a contract; reading, testing, building and local editing do not.
 */
/**
 * Whether a mutating shell command targets a governance path.
 *
 * The file tools refuse edits to .agents/context, the session contracts, the
 * host config directories and the shared entry points, but the shell reached
 * the same files unchecked: `touch .claude/x` and `sed -i .agents/context/y`
 * both went through. A session could rewrite the hooks that govern it, which
 * makes the path boundary decorative. Reads stay open — inspecting governance
 * is how a session learns its own rules — and progress records stay writable,
 * since they carry an account of work rather than authority.
 */
function governanceWriteCommand(command, cwd, projectRoot) {
	if (readOnlyShell(command, cwd)) return false;
	for (const token of shellTokens(command)) {
		if (!token || token.startsWith("-")) continue;
		if (!/[\/.]/.test(token)) continue;
		let resolved;
		try { resolved = path.resolve(cwd, token); } catch { continue; }
		if (!sessionContract.inside(projectRoot, resolved)) continue;
		const state = stateTarget(resolved, cwd);
		if (state?.kind === "progress") continue;
		if (state) return true;
		if (governedTarget(resolved, projectRoot)) return true;
		if (ENTRY_POINTS.has(path.basename(resolved)) && path.dirname(resolved) === projectRoot) return true;
	}
	return false;
}

function routineCommandAllowed(toolName, toolInput, cwd) {
	if (normalizedToolName(toolName) !== "shell") return false;
	const command = String(toolInput?.command || "").trim();
	if (!command) return false;
	const projectRoot = sessionContract.findProjectRoot(cwd);
	if (!projectRoot) return false;
	const allowance = routineAllowance(projectRoot);
	if (!allowance || allowance.default !== "allow") return false;
	if (reviewInvokerCommand(command, cwd)) return true;
	// Command substitution, eval and interpreter -c hide the head of the command
	// from every check below, so they keep needing a contract. Plain variable
	// references do not hide anything and stay routine.
	if (/\$\(|`|(?:^|[\s;&|])(?:eval|xargs)\b|\b(?:sh|bash|zsh|dash|ksh|fish)\s+-[A-Za-z]*c\b/i.test(command)) return false;
	if (nestedModelRuntimeCommand(command)) return false;
	if (governanceWriteCommand(command, cwd, projectRoot)) return false;

	for (const pattern of allowance.contract_required_patterns?.patterns || []) {
		let expression;
		try { expression = new RegExp(pattern, "i"); } catch { continue; }
		if (expression.test(command)) return false;
	}

	const refusedHeads = new Set(
		Object.entries(allowance.contract_required_heads || {})
			.filter(([key]) => key !== "_doc")
			.flatMap(([, value]) => (Array.isArray(value) ? value : [])),
	);
	const refusedSubcommands = allowance.contract_required_subcommands || {};

	for (const statement of splitShellStatements(command)) {
		const tokens = shellTokens(statement);
		if (!tokens.length) continue;
		const head = path.basename(String(tokens[0])).replace(/\.(exe|cmd)$/i, "");
		if (refusedHeads.has(head)) return false;
		const subcommands = refusedSubcommands[head];
		if (Array.isArray(subcommands)) {
			// -C and its value are position flags, not the subcommand.
			const rest = tokens.slice(1).filter((token, index, all) =>
				token !== "-C" && all[index - 1] !== "-C" && !token.startsWith("-"));
			if (rest.some((token) => subcommands.includes(token))) return false;
		}
	}
	return true;
}

/** Statement split that respects quoting; a pipe inside an argument is data. */
function splitShellStatements(source) {
	const statements = [];
	let current = "";
	let quote = null;
	for (const character of String(source || "")) {
		if (quote) { current += character; if (character === quote) quote = null; continue; }
		if (character === '"' || character === "'") { quote = character; current += character; continue; }
		if (character === ";" || character === "|" || character === "&") { statements.push(current); current = ""; continue; }
		current += character;
	}
	statements.push(current);
	return statements.map((statement) => statement.trim()).filter(Boolean);
}

/**
 * Whether an active contract belonging to someone else claims this path.
 *
 * target_ownership exists to stop two sessions from editing the same files, not
 * to shrink what one session may touch. Reading it as a whitelist made a bound
 * session narrower than an unbound one: with no contract a session could create
 * any ordinary file in the project, and the moment it bound one it could not.
 */
function foreignOwnedTarget(target, projectRoot, contractsDir, sessionId) {
	let names = [];
	try { names = fs.readdirSync(contractsDir); } catch { return false; }
	const relative = path.relative(projectRoot, target).replaceAll("\\", "/");
	for (const name of names) {
		if (!name.endsWith(".json") || name.startsWith(".") || name === "schema.json") continue;
		const contract = readJsonFile(path.join(contractsDir, name));
		if (!contract || contract.status !== "active") continue;
		if (contractNamesSession(contract, sessionId)) continue;
		if ((contract.target_ownership || []).some((pattern) => contractPathMatches(pattern, relative))) return true;
	}
	return false;
}

/**
 * An ordinary file outside the contract's declared paths: allowed on the same
 * terms an unbound session gets, minus anything another contract owns.
 */
function ordinaryTargetOutsideContract(filePath, cwd, sessionId) {
	const projectRoot = sessionContract.findProjectRoot(cwd);
	if (!projectRoot) return false;
	const target = path.resolve(cwd, String(filePath));
	if (!sessionContract.inside(projectRoot, target)) return false;
	if (entrypointTarget(filePath, cwd)) return false;
	const state = stateTarget(filePath, cwd);
	if (state) return false;
	if (governedTarget(target, projectRoot)) return false;
	// A nested ADK project governs itself; a parent contract does not reach into it.
	const nestedRoot = targetProjectRoot(target);
	if (nestedRoot && path.resolve(nestedRoot) !== path.resolve(projectRoot)) return false;
	return !foreignOwnedTarget(target, projectRoot, path.join(projectRoot, ".agents", "session-contracts"), sessionId);
}

function unboundOrdinaryMutationAllowed(toolName, toolInput, cwd) {
	if (normalizedToolName(toolName) !== "file-mutation") return false;
	const raw = rawToolName(toolName);
	if (!new Set(["write", "edit", "notebookedit", "apply_patch"]).has(raw)) return false;
	// Deletion is not recoverable from the transcript; it keeps needing a contract.
	if (raw === "apply_patch" && /^\*\*\* Delete File:/m.test(patchSource(toolInput))) return false;
	const projectRoot = sessionContract.findProjectRoot(cwd);
	const targets = fileMutationTargets(toolInput);
	if (!projectRoot || targets.length === 0) return false;
	return targets.every((filePath) => {
		const target = path.resolve(cwd, String(filePath));
		if (!sessionContract.inside(projectRoot, target)) return false;
		if (entrypointTarget(filePath, cwd)) return false;
		const state = stateTarget(filePath, cwd);
		// A progress record is the session's account of its own work. Refusing it
		// while the refusal text promised it was allowed left sessions unable to
		// record what they did; contracts and the registry still carry authority
		// and still need one.
		if (state) return state.kind === "progress";
		return !governedTarget(target, projectRoot);
	});
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
	if (harnessSwitch.findHarnessMarker({ cwd, configDirs: HARNESS_CONFIG_DIRS })) return null;
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
	if (normalizedToolName(toolName) === "shell" && nestedModelRuntimeCommand(toolInput.command) && !reviewInvokerCommand(toolInput.command, cwd)) {
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
	if (resolution.reason !== "derived_delegation_verified" && routineCommandAllowed(toolName, toolInput, cwd)) return null;
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
			const denied = targets.filter((target) =>
				!contractAllowsTarget(resolution, target, cwd) &&
				!ordinaryTargetOutsideContract(target, cwd, sessionId));
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
			// A bound session must not be more restricted than an unbound one.
			// Requiring every command to be declared verbatim meant a contract
			// blocked its own routine work — running tests, inspecting a file.
			// A delegated worker stays narrowed to the validators its brief declared;
			// widening there would dissolve the delegation boundary itself.
			const routine = resolution.reason !== "derived_delegation_verified"
				&& !resolution.derivedTask
				&& routineCommandAllowed(toolName, toolInput, cwd);
			if (!readOnly && !routine &&
				!(resolution.contract.allowed_shell_commands || []).includes(command) &&
				!gitIntegration) {
				return { decision: "block", reason: "⛔ [HARNESS] 변경 가능 셸 명령이 계약의 allowed_shell_commands에 정확히 선언되지 않았습니다." };
			}
		}
		return null;
	}
	if (normalizedToolName(toolName) === "shell" && readOnlyShell(toolInput.command, cwd)) return null;

	return {
		decision: "block",
		reason: `⏸ [HARNESS] SESSION ${resolution.status} — ${resolution.reason}. governed 변경만 보류합니다.\n` +
		`계약은 작업 중지 사유가 아니라 드리프트 방지 장치입니다. 계약을 생성·결박하거나 기존 단일-session 계약을 수정/교체·재결박한 뒤 같은 작업을 재시도하고 계속하세요. 쓰는 순서는 계약 → progress → registry 이며, contract_digest 는 contract_digest 를 뺀 계약의 SHA-256 입니다(순서나 서명이 어긋나면 각 단계가 거부됩니다). ${sessionId} 를 .agents/session-contracts/.session-map.json 의 active 계약 하나에 결박하며, 조건은 .agents/session-contracts/README.md 에 있습니다.\n` +
		"실제 권한 부족, target_ownership 충돌, 무결성 검증 실패일 때만 중지합니다. 계약·registry·progress 쓰기와 읽기 전용 조사는 허용됩니다.",
	};
}

function main() {
	const raw = readStdin();
	let data = {};
	try { data = JSON.parse(raw || "{}"); } catch { /* fail-open */ }
	sessionRecovery.handleEvent("PreToolUse", raw, data.cwd || process.cwd());
	const output = decide(data);
	if (output) {
		// One line on disk per refusal, so "the harness blocked my session" is
		// answerable from the repository instead of from the operator's screen.
		blockLog.record({
			hook: "session-contract-gate", tool: data.tool_name, cwd: data.cwd,
			sessionId: data.session_id, toolInput: data.tool_input, reason: output.reason,
		});
		process.stdout.write(JSON.stringify(output));
	}
}

if (require.main === module) main();
module.exports = { routineAllowance, ordinaryTargetOutsideContract, foreignOwnedTarget, contractNamesSession, governanceWriteCommand, splitShellStatements, bootstrapMutationAllowed, reviewInvokerCommand, routineCommandAllowed, bootstrapWriteAllowed, contractAllowsTarget, contractPathMatches, decide, entrypointMutationOutsideHelper, entrypointTarget, executableReadCommand, explicitlyScopedRead, fallbackAllowsTarget, fileMutationTargets, main, nestedModelRuntimeCommand, normalizedToolName, patchTargets, readOnlyShell, reclaimCommandAllowed, reconstructSingleFilePatch, requestedWorkdirIssue, stateTarget, trustedSessionParserCommand, unboundOrdinaryMutationAllowed };
