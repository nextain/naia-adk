#!/usr/bin/env node
/**
 * Host-neutral lightweight session contract mutation gate.
 * Progress and Markdown session-id strings are diagnostics, not authority.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sessionContract = require("../../.agents/hooks/core/session-contract.js");

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
	if (readOnlyShell(command)) return false;
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

function contractPathMatches(pattern, relativePath) {
	const normalizedPattern = String(pattern).replaceAll("\\", "/").replace(/^\.\//, "");
	const normalizedPath = String(relativePath).replaceAll("\\", "/").replace(/^\.\//, "");
	if (normalizedPattern.endsWith("/**")) {
		const prefix = normalizedPattern.slice(0, -3).replace(/\/$/, "");
		return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
	}
	return normalizedPath === normalizedPattern;
}

function contractAllowsTarget(resolution, filePath, cwd) {
	const target = path.resolve(cwd, String(filePath));
	if (!sessionContract.inside(resolution.projectRoot, target)) return false;
	const relative = path.relative(resolution.projectRoot, target).replaceAll("\\", "/");
	return [resolution.contract.allowed_paths, resolution.contract.target_ownership]
		.every((patterns) => patterns.some((pattern) => contractPathMatches(pattern, relative)));
}

function fallbackAllowsTarget(resolution, access, filePath, cwd) {
	if (!access?.active) return false;
	const target = path.resolve(cwd, String(filePath));
	if (!sessionContract.inside(resolution.projectRoot, target)) return false;
	const relative = path.relative(resolution.projectRoot, target).replaceAll("\\", "/");
	return access.allowedPaths.some((pattern) => contractPathMatches(pattern, relative));
}

const SAFE_READ_COMMANDS = [
	/^(?:get-content|gc|get-childitem|gci|dir|ls|get-item|gi|get-filehash|test-path|resolve-path)\b/i,
	/^(?:select-string|select-object|sort-object|where-object|measure-object)\b/i,
	/^(?:rg|grep|cat|head|tail|wc|pwd|stat|readlink)\b/i,
	/^git\s+(?:status|diff|log|show|remote|ls-files|check-ignore|rev-parse)\b/i,
	/^git\s+branch(?:\s+(?:--show-current|--list|-l|--all|-a|--remotes|-r|-v|-vv))*\s*$/i,
	/^git\s+submodule\s+status\b/i,
];

// These forms must never be rescued by an exact allowed_shell_commands match.
const NESTED_RUNTIME = /(?:^|[\s;&|()])(?:claude(?:-code)?|codex(?:-cli)?|gemini(?:-cli)?|opencode(?:-ai)?|open-code)(?=\s|$|["'])|@(?:anthropic-ai\/claude-code|google\/gemini-cli|openai\/codex(?:-cli)?|opencode-ai)(?=\s|$|["'])/i;
const DYNAMIC_SHELL = [
	/\$\(|`/,
	/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/,
	/(?:^|[;&|]\s*)[A-Za-z_][A-Za-z0-9_]*\s*=/,
	/\b(?:eval|xargs)\b/i,
	/\b(?:sh|bash|zsh|dash|ksh|fish)\s+-[A-Za-z]*c\b/i,
	/\b(?:node|nodejs|bun|deno|python(?:3)?|perl|ruby|php|pwsh|powershell)\s+(?:-[A-Za-z]*e|-[A-Za-z]*c|--eval|--execute|--command|-[A-Za-z]*Command)\b/i,
	/\bprintf\b/i,
	/\\(?:[0-7]{1,3}|x[0-9a-f]{2})/i,
];

function unsafeShellCommand(command) {
	const source = String(command || "").trim();
	return NESTED_RUNTIME.test(source) || DYNAMIC_SHELL.some((pattern) => pattern.test(source));
}

function readOnlyShell(command) {
	const source = String(command || "").trim();
	if (!source) return true;
	if (
		/[><`]/.test(source) ||
		/\$\(/.test(source) ||
		/&&|\|\|/.test(source) ||
		/(?:^|\s)(?:--output(?:=|\s)|-o(?:\s|$))/i.test(source) ||
		/\brg\b[^;|\n]*(?:^|\s)--pre(?:=|\s|$)/i.test(source) ||
		/\b(?:set-content|add-content|out-file|tee|new-item|remove-item|move-item|copy-item|rename-item)\b/i.test(source) ||
		/\bgit\s+branch\b[^;\n]*(?:\s-(?:d|D|m|M|c|C|f)\b|--delete\b|--move\b|--copy\b|--force\b|--set-upstream-to\b|--unset-upstream\b)/i.test(source) ||
		/\bgit\s+remote\s+(?:add|remove|rm|rename|set-head|set-branches|set-url|prune|update)\b/i.test(source)
	) return false;
	const statements = source
		.split(";")
		.flatMap((statement) => statement.split("|"))
		.map((statement) => statement.trim())
		.filter(Boolean);
	return statements.length > 0 &&
		statements.every((statement) => SAFE_READ_COMMANDS.some((pattern) => pattern.test(statement)));
}

function nestedModelRuntimeCommand(command) {
	const source = String(command || "").trim();
	if (!source) return false;
	const dequoted = source.replace(/\\(.)/gs, "$1").replace(/["']/g, "");
	const provider = /(?:^|[\s"'=;|&\\/])(?:codex|claude|opencode|gemini)(?:\.exe)?(?=$|[\s"';|&])/iu;
	return provider.test(source) || provider.test(dequoted);
}

function executableReadCommand(command) {
	return /\brg\b[^;|\n]*(?:^|\s)--pre(?:=|\s|$)/i.test(String(command || ""));
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
	if (!sessionContract.findProjectRoot(cwd)) return null;
	if (entrypointMutationOutsideHelper(toolName, toolInput, cwd)) {
		return {
			decision: "block",
			reason: "⛔ [HARNESS] 공유 진입점은 전용 validator를 거쳐야 합니다. 후보 파일을 만든 뒤 `node .claude/hooks/sync-entry-points.js --apply <candidate>`를 사용하세요.",
		};
	}
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

	const resolution = resolveSessionContract({ cwd, sessionId });
	// A derived worker already has a verified, parent-owned contract. It must
	// never replace that authority by bootstrapping an explicit child contract.
	if (resolution.reason !== "derived_delegation_verified" && bootstrapMutationAllowed(toolName, toolInput, cwd, sessionId)) return null;
	if (resolution.status === sessionContract.STATES.BOUND) {
		if (resolution.derivedTask?.read_only === true) {
			if (normalizedToolName(toolName) === "file-mutation") {
				return { decision: "block", reason: "⛔ [HARNESS] 이 파생 워커 계약은 read_only이며 파일 변경을 허용하지 않습니다." };
			}
			if (normalizedToolName(toolName) === "shell" && !readOnlyShell(toolInput.command)) {
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
			const readOnly = readOnlyShell(command);
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
				return { decision: "block", reason: "⛔ [HARNESS] 변경 가능 셸 명령이 계약의 allowed_shell_commands에 정확히 선언되지 않았습니다." };
			}
		}
		return null;
	}
	if (normalizedToolName(toolName) === "shell" && readOnlyShell(toolInput.command)) return null;

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
	let data = {};
	try { data = JSON.parse(readStdin() || "{}"); } catch { /* fail-open */ }
	const output = decide(data);
	if (output) process.stdout.write(JSON.stringify(output));
}

if (require.main === module) main();
module.exports = { bootstrapMutationAllowed, bootstrapWriteAllowed, contractAllowsTarget, contractPathMatches, decide, entrypointMutationOutsideHelper, entrypointTarget, executableReadCommand, fallbackAllowsTarget, fileMutationTargets, main, nestedModelRuntimeCommand, normalizedToolName, patchTargets, readOnlyShell, reconstructSingleFilePatch, stateTarget };
