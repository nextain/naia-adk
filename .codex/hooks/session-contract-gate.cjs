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
// Baseline gate helper. A broken helper must not silently disable the gate:
// when a contract declares a baseline and this module is missing, the gate
// fails closed with an explicit message instead of pretending nothing is due.
let sessionBaseline = null;
try { sessionBaseline = require("../../.agents/harness/session-baseline.cjs"); } catch { sessionBaseline = null; }
const sessionRecovery = require("../../.agents/harness/session-contract-recovery.cjs");
const {
	executableReadCommand,
	explicitlyScopedRead,
	nestedModelRuntimeCommand,
	readOnlyShell,
	requestedWorkdirIssue,
	shellTokens,
	trustedSessionParserCommand,
} = require("./session-read-policy.cjs");
const { routineAllowance, routineRefusedSubcommands, routineMutationRefused } = require("./routine-policy.cjs");

const HARNESS_OFF = new Set(["off", "0", "false", "no"]);
const HARNESS_ENV_VARS = ["AI_HARNESS", "CLAUDE_HARNESS", "CODEX_HARNESS"];
const HARNESS_CONFIG_DIRS = [".claude", ".codex", ".pi"];
const ENTRY_POINTS = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);

function normalizedToolName(name) {
	const leaf = String(name || "").split(/[.:/]/).pop().toLowerCase();
	if (["bash", "shell_command", "exec_command", "run_terminal_command"].includes(leaf)) return "shell";
	if (["write", "edit", "notebookedit", "apply_patch", "search_replace"].includes(leaf)) return "file-mutation";
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
	if (relative === ".agents" || relative.startsWith(".agents/")) return true;
	return HARNESS_CONFIG_DIRS.some((dir) => relative === dir || relative.startsWith(dir + "/"));
}

const REVIEW_INVOKER = /(?:^|\/)(?:\.agents\/)?skills\/review-pass\/scripts\/invoke-reviewer\.mjs$/;

function reviewInvokerCommand(command, cwd) {
	const text = String(command || "");
	if (/[\r\n;&|<>\x60]|\$\(/.test(text)) return false;
	const tokens = shellTokens(text);
	if (tokens.length < 2) return false;
	const head = path.basename(String(tokens[0])).replace(/\.(exe|cmd)$/i, "");
	if (head !== "node" && head !== "nodejs") return false;
	const script = tokens[1];
	if (!script || !REVIEW_INVOKER.test(String(script).replace(/\\/g, "/"))) return false;
	const projectRoot = sessionContract.findProjectRoot(cwd);
	const resolved = path.resolve(cwd, String(script));
	return Boolean(projectRoot) && sessionContract.inside(projectRoot, resolved) && fs.existsSync(resolved);
}

/**
 * Shell grammar that is deliberately too ambiguous for the structural
 * routine policy. A contract can authorize an exact command, but the routine
 * carve-out must not grow into a shell parser for wrappers and control flow.
 */
function ambiguousShellWrapper(command) {
	const source = shellTextOutsideQuotes(command);
	if (/[(){}]/.test(source)) return true;
	if (/(?:^|[\s;&|])(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|time|exec|!)(?=\s|$)/i.test(source)) return true;
	return /(?:^|[\s;&|])\\[A-Za-z_./-]+(?:\s|$)/.test(source);
}

/** Remove quoted data before checking shell control grammar. A search pattern
 * such as `handleRequest\\(` is an argument, not shell grouping syntax. */
function shellTextOutsideQuotes(command) {
	let quote = null;
	let escaped = false;
	let result = "";
	for (const character of String(command || "")) {
		if (quote) {
			if (quote === '"' && escaped) {
				escaped = false;
				result += " ";
				continue;
			}
			if (quote === '"' && character === "\\") {
				escaped = true;
				result += " ";
				continue;
			}
			if (character === quote) quote = null;
			result += " ";
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			result += " ";
			continue;
		}
		result += character;
	}
	return result;
}

/**
 * Refuse routine shell commands that write governance, host-policy, or shared
 * entrypoint files. Progress records remain ordinary work records; contract,
 * registry, context, and harness paths remain authority-bearing.
 */
function governanceWriteCommand(command, cwd, projectRoot) {
	if (readOnlyShell(command, cwd)) return false;
	// Keep the legacy all-argument scan alongside destination extraction. Some
	// mutating commands take a governed source or option path that is not their
	// final destination (for example cp --target-directory and multi-target sed).
	const targets = [
		...commandMutationTargets(command),
		...splitShellStatements(command).flatMap(legacyGovernanceScanTargets),
	];
	for (const target of new Set(targets)) {
		if (!target) continue;
		let resolved;
		try { resolved = path.resolve(cwd, target); } catch { continue; }
		// A mutating command may cross into a sibling project or the parent
		// workspace. The routine allowance covers local work only, so any
		// destination outside the resolved project is contract-required.
		if (!sessionContract.inside(projectRoot, resolved)) return true;
		const state = stateTarget(resolved, cwd);
		if (state?.kind === "progress") continue;
		if (state || governedTarget(resolved, projectRoot)) return true;
		if (ENTRY_POINTS.has(path.basename(resolved)) && path.dirname(resolved) === projectRoot) return true;
	}
	return false;
}

const SCRIPT_INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "perl", "ruby", "php", "pwsh", "powershell"]);
const MUTATING_HEADS = new Set(["cp", "copy", "mv", "move", "install", "sed", "touch", "mkdir", "rmdir", "rm", "truncate", "tee"]);

/**
 * Preserve the old command-family scan over every argument while the newer
 * destination parser handles project-boundary details. This catches governed
 * source paths and option values that can still be written by a mutation.
 */
function legacyGovernanceScanTargets(statement) {
	const tokens = shellTokens(statement);
	if (tokens.length === 0) return [];
	const head = path.basename(String(tokens[0])).replace(/\.(exe|cmd)$/i, "").toLowerCase();
	const targets = shellRedirectionTargets(statement);
	if (!MUTATING_HEADS.has(head)) {
		if (head !== "git" || commandMutationTargets(statement).length === 0) return targets;
	}
	targets.push(...tokens.slice(1));
	for (const token of tokens.slice(1)) {
		const targetDirectory = String(token).match(/^--target-directory=(.+)$/);
		if (targetDirectory) targets.push(targetDirectory[1]);
	}
	return targets;
}

/**
 * Extract output-redirection paths without treating `>` inside quoted command
 * arguments as shell syntax. Keep this parser shared by both governance scans
 * so adjacent, spaced, quoted, and repeated redirects receive the same path
 * boundary check.
 */
function shellRedirectionTargets(statement) {
	const source = String(statement || "");
	const targets = [];
	const readWord = (start) => {
		let cursor = start;
		let value = "";
		while (cursor < source.length) {
			const character = source[cursor];
			if (/\s/.test(character) || ";|&<>".includes(character)) break;
			if (character === "'" || character === '"') {
				const quote = character;
				cursor += 1;
				while (cursor < source.length) {
					const quoted = source[cursor];
					if (quote === '"' && quoted === "\\" && cursor + 1 < source.length) {
						value += source[cursor + 1];
						cursor += 2;
						continue;
					}
					if (quoted === quote) {
						cursor += 1;
						break;
					}
					value += quoted;
					cursor += 1;
				}
				continue;
			}
			if (character === "\\" && cursor + 1 < source.length) {
				value += source[cursor + 1];
				cursor += 2;
				continue;
			}
			value += character;
			cursor += 1;
		}
		return { value, end: cursor };
	};

	let quote = null;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (quote) {
			if (quote === '"' && escaped) {
				escaped = false;
				continue;
			}
			if (quote === '"' && character === "\\") {
				escaped = true;
				continue;
			}
			if (character === quote) quote = null;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "\\") {
			index += 1;
			continue;
		}
		if (character !== ">") continue;
		let cursor = index + 1;
		if (source[cursor] === ">") cursor += 1;
		if (source[cursor] === "|") cursor += 1;
		let duplicateFd = false;
		if (source[cursor] === "&") {
			duplicateFd = true;
			cursor += 1;
		}
		while (/\s/.test(source[cursor] || "")) cursor += 1;
		const word = readWord(cursor);
		if (word.value && !(duplicateFd && /^\d+$/.test(word.value))) targets.push(word.value);
		if (word.end > index + 1) index = word.end - 1;
	}
	return targets;
}

function positionalArguments(tokens) {
	return tokens.slice(1).filter((token) => token && token !== "--" && !token.startsWith("-"));
}

function commandMutationTargets(statement) {
	const targets = shellRedirectionTargets(statement);
	const tokens = shellTokens(statement);
	if (tokens.length === 0) return targets;
	const head = path.basename(String(tokens[0])).replace(/\.(exe|cmd)$/i, "").toLowerCase();
	if (SCRIPT_INTERPRETERS.has(head)) return targets;
	if (MUTATING_HEADS.has(head)) {
		const positional = positionalArguments(tokens);
		if (["cp", "copy", "mv", "move", "install", "sed"].includes(head)) return targets.concat(positional.slice(-1));
		return targets.concat(positional);
	}
	if (head === "git") {
		let index = 1;
		const optionsWithValues = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);
		while (index < tokens.length) {
			const token = String(tokens[index]);
			if (optionsWithValues.has(token)) {
				// `git -C <path> add …` mutates the repository rooted at <path>; keep
				// that path in the boundary check as well as the add operands.
				if (token === "-C" && tokens[index + 1]) targets.push(tokens[index + 1]);
				index += 2;
				continue;
			}
			if (/^-C.+$/.test(token) || /^-c.+$/.test(token) || /^(?:--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)=/.test(token)) { index += 1; continue; }
			if (token.startsWith("-")) { index += 1; continue; }
			break;
		}
		const subcommand = String(tokens[index] || "").toLowerCase();
		if (subcommand === "add") return targets.concat(tokens.slice(index + 1).filter((token) => token && token !== "--" && !token.startsWith("-")));
	}
	return targets;
}

/** Split shell statements while preserving separators inside quoted data. */
function splitShellStatements(source) {
	const statements = [];
	let current = "";
	let quote = null;
	for (const character of String(source || "")) {
		if (quote) {
			current += character;
			if (character === quote) quote = null;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			current += character;
			continue;
		}
		if (character === ";" || character === "|" || character === "&" || character === "\n") {
			statements.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	statements.push(current);
	return statements.map((statement) => statement.trim()).filter(Boolean);
}

/**
 * Decide whether a shell call is an ordinary local operation under the
 * repository policy. Dynamic shell construction, nested model runtimes,
 * governance writes, destructive heads/subcommands, and contract-required
 * patterns remain refused. The policy is deliberately structural rather than
 * an unbounded exact-command allow-list, so project tests and builds work.
 */
function routineCommandAllowed(toolName, toolInput, cwd) {
	if (normalizedToolName(toolName) !== "shell") return false;
	const command = String(toolInput?.command || "").trim();
	if (!command) return false;
	const projectRoot = sessionContract.findProjectRoot(cwd);
	if (!projectRoot) return false;
	// A rules file without a routine section means the project has not narrowed
	// anything: the built-in policy applies. Only a malformed policy denies.
	const allowance = routineAllowance(projectRoot) || { default: "allow" };
	if (allowance.default !== "allow") return false;
	if (reviewInvokerCommand(command, cwd)) return true;
	if (governanceWriteCommand(command, cwd, projectRoot)) return false;

	const patterns = [];
	for (const pattern of allowance.contract_required_patterns?.patterns || []) {
		try { patterns.push(new RegExp(pattern, "i")); } catch { /* an unparsable pattern refuses nothing */ }
	}
	if (patterns.some((expression) => expression.test(command))) return false;

	const policy = {
		patterns,
		refusedHeads: new Set(
			Object.entries(allowance.contract_required_heads || {})
				.filter(([key]) => key !== "_doc")
				.flatMap(([, value]) => (Array.isArray(value) ? value : []))
				.map((value) => String(value).toLowerCase()),
		),
		refusedSubcommands: routineRefusedSubcommands(allowance),
	};
	return !splitShellStatements(command).some((statement) => refusedStatement(statement, policy));
}

/**
 * Judge one shell statement by the command it actually runs.
 *
 * The policy names the commands that are hard to undo. Everything that merely
 * moves such a command along the line — `VAR=1 cmd`, `env -i cmd`,
 * `timeout 600 cmd`, `nohup cmd`, `bash -c "cmd"` — used to be refused as
 * "ambiguous" or "hidden", which made ordinary work (`CUDA_VISIBLE_DEVICES=1
 * python …`, `timeout 900 npm test`) need a contract while adding no safety:
 * the real command is right there to read. So read it. Wrappers are peeled,
 * an inline `-c` program is judged by the same rule, and when the head truly
 * cannot be seen (substitution, eval, xargs, shell control flow) every token
 * is checked instead of refusing the whole line. What cannot be judged is
 * allowed: the harness exists to stop drift into irreversible actions, not
 * to out-guess a shell.
 */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const WRAPPER_HEADS = new Set(["command", "env", "chrt", "nice", "nohup", "stdbuf", "timeout", "ionice", "exec", "builtin", "time"]);
const HIDDEN_HEAD = /\$\(|`|(?:^|[\s;&|])(?:eval|xargs)\b/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function commandHead(token) {
	// `(rm x)`, `{ rm x; }`, `$(sudo reboot)` and `\rm` glue shell marks onto the word.
	const bare = String(token || "").replace(/^[$(`{\\]+|[)`}]+$/g, "");
	return path.basename(bare).replace(/\.(exe|cmd)$/i, "").toLowerCase();
}

function unwrapStatement(tokens) {
	const rest = [...tokens];
	for (let depth = 0; depth < 8 && rest.length; depth += 1) {
		while (rest.length && ASSIGNMENT.test(rest[0])) rest.shift();
		if (!rest.length) break;
		const head = commandHead(rest[0]);
		if (!WRAPPER_HEADS.has(head)) break;
		rest.shift();
		while (rest.length && (rest[0].startsWith("-") || ASSIGNMENT.test(rest[0]))) {
			const flag = rest.shift();
			// `-n 5`, `-u NAME`, `-s KILL`, `-o L`: the value belongs to the flag.
			// `-i` and friends take none, so the token after them is the command.
			if (/^-(?:n|u|S|k|s|o|e)$/.test(flag) && rest.length && !rest[0].startsWith("-")) rest.shift();
		}
		if ((head === "timeout" || head === "chrt" || head === "ionice") && rest.length && /^\d+(?:\.\d+)?[smhd]?$/i.test(rest[0])) rest.shift();
	}
	return rest;
}

function refusedSubcommandHit(head, rest, refusedSubcommands) {
	const subcommands = refusedSubcommands[head];
	if (!Array.isArray(subcommands)) return false;
	// -C and its value are position flags, not the subcommand.
	const positional = rest.filter((token, index, all) => token !== "-C" && all[index - 1] !== "-C" && !token.startsWith("-"));
	return positional.some((token) => subcommands.includes(token));
}

function refusedStatement(statement, policy) {
	const { refusedHeads, refusedSubcommands, patterns } = policy;
	const tokens = unwrapStatement(shellTokens(statement));
	if (!tokens.length) return false;
	const unwrapped = tokens.join(" ");
	if (patterns.some((expression) => expression.test(unwrapped))) return true;
	if (routineMutationRefused(unwrapped)) return true;
	const head = commandHead(tokens[0]);
	if (refusedHeads.has(head)) return true;
	if (refusedSubcommandHit(head, tokens.slice(1), refusedSubcommands)) return true;
	if (SHELL_INTERPRETERS.has(head)) {
		// `bash -c 'prog'`, `sh --command "prog"`, `bash --execute='prog'`: the
		// program is everything after the flag, however it was quoted.
		let program = null;
		for (let index = 1; index < tokens.length; index += 1) {
			const token = String(tokens[index]);
			const attached = token.match(/^--(?:command|execute)=(.*)$/);
			if (attached) { program = [attached[1], ...tokens.slice(index + 1)].join(" "); break; }
			if (/^-[A-Za-z]*c$/.test(token) || token === "--command" || token === "--execute") { program = tokens.slice(index + 1).join(" "); break; }
		}
		if (program) {
			const dequoted = program.replace(/\\(["'])/g, "$1").replace(/^(["'])([\s\S]*)\1$/, "$2");
			if (splitShellStatements(dequoted).some((inner) => refusedStatement(inner, policy))) return true;
		}
	}
	if (HIDDEN_HEAD.test(statement) || ambiguousShellWrapper(statement)) {
		for (let index = 1; index < tokens.length; index += 1) {
			const candidate = commandHead(tokens[index]);
			if (refusedHeads.has(candidate)) return true;
			if (refusedSubcommandHit(candidate, tokens.slice(index + 1), refusedSubcommands)) return true;
			if (routineMutationRefused(tokens.slice(index).join(" "))) return true;
		}
	}
	return false;
}

const SHELL_CONTRACT_REASON = "⛔ [HARNESS] 이 셸 명령은 계약 없이는 실행되지 않는 부류입니다: 되돌리기 어려운 명령(삭제·권한 상승·강제 갱신·배포·외부 전송·공개)이거나 governance·계약 파일을 셸로 고칩니다. 일상 명령(빌드·테스트·설치·commit·다른 모델 런타임 실행)은 계약 없이 통과합니다. 정말 필요하면 계약의 allowed_shell_commands 에 이 명령을 그대로 선언한 뒤 재시도하고, governance 파일은 파일 쓰기 도구로 고치세요.";

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
	if (!new Set(["write", "edit", "notebookedit", "apply_patch", "search_replace"]).has(raw)) return false;
	// Deletion is not recoverable from the transcript; it keeps needing a contract.
	if (raw === "apply_patch" && /^\*\*\* Delete File:/m.test(patchSource(toolInput))) return false;
	const projectRoot = sessionContract.findProjectRoot(cwd);
	const targets = fileMutationTargets(toolInput);
	if (!projectRoot || targets.length === 0) return false;
	return targets.every((filePath) => {
		const target = path.resolve(cwd, String(filePath));
		if (!sessionContract.inside(projectRoot, target)) return false;
		if (entrypointTarget(filePath, cwd) || stateTarget(filePath, cwd)) return false;
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

/**
 * A nested project (projects/<name>, its own .git) is part of the workspace
 * that installed the harness, not a separate authority. It was treated as one:
 * a parent contract could not reach into it even when it listed the exact
 * path, while an unbound session wrote the same file freely, so binding a
 * contract took permission away. What a nested project really can have is its
 * own active contract held by another live session; that, and only that, keeps
 * a parent contract out. Liveness that cannot be determined counts as held.
 */
function nestedForeignOwned(target, projectRoot, sessionId) {
	const nestedRoot = targetProjectRoot(target);
	if (!nestedRoot || path.resolve(nestedRoot) === path.resolve(projectRoot)) return false;
	const contractsDir = path.join(nestedRoot, ".agents", "session-contracts");
	let names = [];
	try { names = fs.readdirSync(contractsDir); } catch { return false; }
	const relative = path.relative(nestedRoot, target).replaceAll("\\", "/");
	for (const name of names) {
		if (!name.endsWith(".json") || name.startsWith(".") || name === "schema.json") continue;
		const contract = readJsonFile(path.join(contractsDir, name));
		if (!contract || contract.status !== "active" || !Array.isArray(contract.session_bindings)) continue;
		const holders = contract.session_bindings.map((binding) => binding?.session_id).filter(Boolean);
		if (holders.length === 0 || holders.includes(sessionId)) continue;
		if (!(contract.target_ownership || []).some((pattern) => contractPathMatches(pattern, relative))) continue;
		for (const holder of holders) {
			try {
				const lease = readJsonFile(path.join(contractsDir, ".recovery", "leases", `${holder}.json`));
				if (sessionRecovery.leaseFreshAndActive(nestedRoot, holder) ||
					sessionRecovery.recordedHostProcessLive(lease) ||
					sessionRecovery.sessionProcessLive(holder)) return true;
			} catch { return true; }
		}
	}
	return false;
}

function belongsToResolutionProject(resolution, target) {
	const sessionId = resolution.contract?.session_bindings?.[0]?.session_id || null;
	return !nestedForeignOwned(target, resolution.projectRoot, sessionId);
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
	// A nested repository under the contract's root is part of the same
	// workspace; every staged or named target is still checked against the
	// contract below, including another session's hold on the nested repo.
	const gitProjectRoot = sessionContract.findProjectRoot(gitCwd);
	if (!gitProjectRoot || !sessionContract.inside(resolution.projectRoot, gitProjectRoot)) return false;

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

function rebindCommandAllowed(toolName, toolInput, sessionId) {
	if (normalizedToolName(toolName) !== "shell") return false;
	const command = String(toolInput?.command || "").trim();
	// Every host's session id shape is accepted (OpenCode ses_…, Claude Code
	// UUID, Codex); the command still has to name this very session.
	return /^node\s+\.agents[\\/]session-contracts[\\/]rebind-session\.cjs\s+[A-Za-z0-9][A-Za-z0-9._-]{0,199}\s+[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(command) &&
		command.endsWith(` ${sessionId}`);
}

const BINDING_HELPER = /(?:^|[\s"'/\\])\.agents[\\/](?:harness[\\/]session-contract-recovery\.cjs|session-contracts[\\/]rebind-session\.cjs)(?=$|[\s"'])/;

function bindingHelperInvocation(command) {
	return BINDING_HELPER.test(String(command || ""));
}

function readStdin() {
	try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

/**
 * The baseline ack/status commands are the door every baseline refusal
 * points at; like the reclaim command they must not need declaring in the
 * very contract whose gate is currently refusing.
 */
function baselineCommandAllowed(command, sessionId) {
	const source = String(command || "").trim();
	const match = source.match(/^node\s+["']?(?:\.\/)?\.agents[\\/]harness[\\/]session-baseline\.cjs["']?\s+(ack|status)\s+--session\s+([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/);
	return Boolean(match && match[2] === sessionId);
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
	if (rebindCommandAllowed(toolName, toolInput, sessionId)) return null;
	if (normalizedToolName(toolName) === "shell" && reclaimCommandAllowed(toolInput.command, sessionId)) return null;
	if (normalizedToolName(toolName) === "shell" && baselineCommandAllowed(toolInput.command, sessionId)) return null;
	if (normalizedToolName(toolName) === "shell" && approvalCommandAllowed(toolInput.command)) return null;
	// The binding helpers rewrite contract state, so they run only in the exact
	// shapes above and only for this session; any other spelling — another
	// session id, reordered flags, a joined command — is refused here rather
	// than admitted as an ordinary script run.
	if (normalizedToolName(toolName) === "shell" && bindingHelperInvocation(toolInput.command)) {
		return {
			decision: "block",
			reason: `⛔ [HARNESS] 계약 회복 헬퍼는 현재 세션만 대상으로, 정확한 형태로만 실행됩니다: \`node .agents/harness/session-contract-recovery.cjs reclaim --contract <id> --session ${sessionId}\` · \`node .agents/session-contracts/rebind-session.cjs <id> ${sessionId}\`.`,
		};
	}
	// Launching another model runtime from the shell (`claude -p`, `opencode
	// run`, `codex exec`) is ordinary, reversible work: a runner test, a review,
	// a delegated job. It used to be refused outright in favour of a governed
	// spawn tool, which left unattended sessions unable to exercise their own
	// runners. The child's own hooks govern what the child does.
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
	if (resolution.status !== sessionContract.STATES.BOUND &&
		resolution.reason !== "derived_delegation_verified" &&
		routineCommandAllowed(toolName, toolInput, cwd)) return null;
	if (resolution.status === sessionContract.STATES.BOUND) {
		if (resolution.derivedTask?.read_only === true) {
			if (normalizedToolName(toolName) === "file-mutation") {
				return { decision: "block", reason: "⛔ [HARNESS] 이 파생 워커 계약은 read_only이며 파일 변경을 허용하지 않습니다." };
			}
			if (normalizedToolName(toolName) === "shell" && !readOnlyShell(toolInput.command, cwd)) {
				return { decision: "block", reason: "⛔ [HARNESS] 이 파생 워커 계약은 read_only이며 변경 가능 셸 명령을 허용하지 않습니다." };
			}
		}
		// Baseline gate: after compaction or session start (and, when the
		// contract sets reack_after_mutations, every N allowed mutations) a
		// bound session must re-read its declared baseline before mutating.
		// Read-only investigation and the ack command itself always pass —
		// the refusal names exactly one recoverable door.
		if (resolution.reason !== "derived_delegation_verified") {
			const baselineShell = normalizedToolName(toolName) === "shell" ? String(toolInput.command || "").trim() : null;
			const baselineExempt = baselineShell !== null &&
				(readOnlyShell(baselineShell, cwd) || baselineCommandAllowed(baselineShell, sessionId));
			if (!baselineExempt) {
				const declared = resolution.contract.baseline &&
					Array.isArray(resolution.contract.baseline.required_reads) &&
					resolution.contract.baseline.required_reads.length > 0;
				if (declared && !sessionBaseline) {
					return { decision: "block", reason: "⛔ [HARNESS: BASELINE] 계약이 baseline 을 선언했지만 .agents/harness/session-baseline.cjs 헬퍼를 불러올 수 없습니다. 헬퍼를 복구한 뒤 재시도하세요." };
				}
				if (declared) {
					let gate = { required: true, acked: false, ackCommand: null };
					try { gate = sessionBaseline.gateStatus(resolution.projectRoot, sessionId, resolution.contract); } catch { /* unacked, fail-closed */ }
					if (gate.required && !gate.acked) {
						return {
							decision: "block",
							reason: "⛔ [HARNESS: BASELINE] 컨텍스트 epoch " + (gate.epoch || "?") + " 미확인 — compaction/세션 시작 후 계약 baseline 재확인 전에는 변경 작업이 차단됩니다. 정확히 실행: " + (gate.ackCommand || ("node .agents/harness/session-baseline.cjs ack --session " + sessionId)) + " (읽기 전용 조사는 허용됩니다)",
						};
					}
					if (gate.required && gate.acked) {
						try { sessionBaseline.noteMutation(resolution.projectRoot, sessionId, resolution.contract); } catch { /* best-effort counter */ }
					}
				}
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
			const readOnly = readOnlyShell(command, cwd);
			const gitIntegration = !readOnly && boundGitMutationAllowed(command, resolution, cwd);
			const trustedReview = reviewInvokerCommand(command, cwd);
			if (!readOnly && !trustedReview && governanceWriteCommand(command, cwd, resolution.projectRoot)) {
				return { decision: "block", reason: "⛔ [HARNESS] 셸 변경 대상이 현재 프로젝트의 계약 경계 밖이거나 거버넌스 경로입니다." };
			}
			if (!readOnly && directAccess.required && !gitIntegration) {
				if (!directAccess.active) {
					return { decision: "block", reason: `⛔ [HARNESS] 오케스트레이터 직접 실행은 차단됩니다 (${directAccess.reason}). 테스트·구현은 governed worker에 위임하세요.` };
				}
				if (!directAccess.exactValidators.includes(command)) {
					return { decision: "block", reason: "⛔ [HARNESS] 셸 명령이 현재 task 직접 우회의 exact_validators에 없습니다." };
				}
			}
			// A bound session is never narrower than an unbound one: whatever the
			// routine policy admits runs without being declared, as long as what it
			// writes stays inside the contract's paths. allowed_shell_commands only
			// adds the contract-required forms the contract deliberately authorizes.
			// A delegated worker stays narrowed to the validators its brief declared.
			// Git mutations keep going through boundGitMutationAllowed, which reads
			// the index to check what a commit actually carries.
			const routine = resolution.reason !== "derived_delegation_verified"
				&& !resolution.derivedTask
				&& !/^git(?:\.exe)?\s/i.test(command)
				&& routineCommandAllowed(toolName, toolInput, cwd)
				&& commandMutationTargets(command).every((target) => contractAllowsTarget(resolution, target, cwd));
			if (!readOnly && !routine && !trustedReview &&
				!(resolution.contract.allowed_shell_commands || []).includes(command) &&
				!gitIntegration) {
				return {
					decision: "block",
					reason: touchesOwnBindingFiles(command)
						? "⛔ [HARNESS] 셸로는 자기 계약·progress·registry 를 고칠 수 없습니다. 게이트가 셸 명령의 결과를 확인할 수 없기 때문입니다. 파일 쓰기 도구(write/edit/apply_patch)로 같은 변경을 하면 계약↔progress↔registry 정합성을 검사한 뒤 통과합니다. 세션이 죽은 계약을 넘겨받아야 하면 `node .agents/harness/session-contract-recovery.cjs reclaim --contract <id> --session <현재 세션 id>` 를, 제3자 승인이 필요하면 같은 헬퍼의 approve 를 쓰십시오."
						: `${SHELL_CONTRACT_REASON} 계약 밖 경로를 고치는 셸 명령도 같은 이유로 막힙니다.`,
				};
			}
		}
		return null;
	}
	if (normalizedToolName(toolName) === "shell" && readOnlyShell(toolInput.command, cwd)) return null;
	if (normalizedToolName(toolName) === "shell") {
		return {
			decision: "block",
			reason: touchesOwnBindingFiles(String(toolInput.command || ""))
				? "⛔ [HARNESS] 셸로는 계약·progress·registry 를 고칠 수 없습니다. 파일 쓰기 도구(write/edit/apply_patch)로 같은 변경을 하면 정합성을 검사한 뒤 통과합니다. 죽은 계약을 넘겨받으려면 `node .agents/harness/session-contract-recovery.cjs reclaim --contract <id> --session " + sessionId + "` 을, 재시작 뒤 자기 계약을 다시 잡으려면 `node .agents/session-contracts/rebind-session.cjs <id> " + sessionId + "` 을 쓰십시오."
				: SHELL_CONTRACT_REASON,
		};
	}
	const routinePolicy = routineAllowance(resolution.projectRoot);
	const routineMessage = routinePolicy?.default === "allow"
		? "현재 정책이 허용한 일상 로컬 작업은 계약 없이 수행할 수 있습니다."
		: "현재 정책은 일상 로컬 셸 작업에도 계약을 요구합니다.";

	return {
		decision: "block",
		reason: `⛔ [HARNESS] SESSION ${resolution.status} — ${resolution.reason}. 변경을 막습니다.\n` +
		"계약 없이 거버넌스·호스트 정책·공유 진입점·삭제·파괴적/원격·외부 작업은 허용되지 않습니다.\n" +
		routineMessage + "\n\n" +
		"결박 조건:\n" +
		`  1) .agents/session-contracts/.session-map.json에서 ${sessionId}를 정확히 한 active 계약에 결박\n` +
		"  2) registry digest, contract_digest, session_bindings[], progress contract reference를 일치\n" +
		"  3) 병렬 active 계약의 target_ownership 경로가 겹치지 않아야 함\n\n" +
		"계약/registry/progress 파일을 갱신하는 bootstrap 편집과 읽기 전용 조사는 허용됩니다.",
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
module.exports = { routineAllowance, routineRefusedSubcommands, routineMutationRefused, governanceWriteCommand, shellRedirectionTargets, splitShellStatements, ambiguousShellWrapper, reviewInvokerCommand, routineCommandAllowed, baselineCommandAllowed, bootstrapMutationAllowed, bootstrapWriteAllowed, contractAllowsTarget, contractPathMatches, decide, entrypointMutationOutsideHelper, entrypointTarget, executableReadCommand, explicitlyScopedRead, fallbackAllowsTarget, fileMutationTargets, main, nestedModelRuntimeCommand, normalizedToolName, patchTargets, readOnlyShell, rebindCommandAllowed, reclaimCommandAllowed, reconstructSingleFilePatch, requestedWorkdirIssue, stateTarget, trustedSessionParserCommand, unboundOrdinaryMutationAllowed };
