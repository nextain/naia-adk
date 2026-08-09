#!/usr/bin/env node
/**
 * Host-neutral lightweight session contract mutation gate.
 * Progress and Markdown session-id strings are diagnostics, not authority.
 */

const fs = require("fs");
const path = require("path");
const sessionContract = require("../../.agents/hooks/core/session-contract.js");
const sessionRecovery = require("../../.agents/harness/session-contract-recovery.cjs");

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

const SAFE_READ_COMMANDS = [
	/^(?:get-content|gc|get-childitem|gci|dir|ls|get-item|gi|get-filehash|test-path|resolve-path)\b/i,
	/^(?:select-string|select-object|sort-object|where-object|measure-object)\b/i,
	/^(?:rg|grep|cat|head|tail|wc|pwd|stat|readlink)\b/i,
	/^git\s+(?:status|diff|log|show|remote|ls-files|check-ignore|rev-parse)\b/i,
	/^git\s+submodule\s+status\b/i,
];

function readOnlyShell(command) {
	const source = String(command || "").trim();
	if (!source) return true;
	if (
		/[><`]/.test(source) ||
		/\$\(/.test(source) ||
		/&&|\|\|/.test(source) ||
		/(?:^|\s)(?:--output(?:=|\s)|-o(?:\s|$))/i.test(source) ||
		/\b(?:set-content|add-content|out-file|tee|new-item|remove-item|move-item|copy-item|rename-item)\b/i.test(source) ||
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

function readStdin() {
	try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

function reclaimCommandAllowed(command, sessionId) {
	const source = String(command || "").trim();
	const match = source.match(/^node\s+["']?(?:\.\/)?\.agents[\\/]harness[\\/]session-contract-recovery\.cjs["']?\s+reclaim\s+--contract\s+([A-Za-z0-9][A-Za-z0-9._-]{0,199})\s+--session\s+([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/);
	return Boolean(match && match[2] === sessionId);
}

function decide(data = {}, env = process.env) {
	const cwd = data.cwd || process.cwd();
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
	if (normalizedToolName(toolName) === "shell" && reclaimCommandAllowed(toolInput.command, sessionId)) return null;

	const resolution = sessionContract.resolveSessionContract({ cwd, sessionId });
	if (bootstrapWriteAllowed(toolName, toolInput, cwd, sessionId)) return null;
	if (resolution.status === sessionContract.STATES.BOUND) {
		if (normalizedToolName(toolName) === "file-mutation") {
			const targets = fileMutationTargets(toolInput);
			if (targets.length === 0) {
				return { decision: "block", reason: "⛔ [HARNESS] 파일 변경 대상을 결정할 수 없어 계약 경로 권한을 검증할 수 없습니다." };
			}
			const denied = targets.filter((target) => !contractAllowsTarget(resolution, target, cwd));
			if (denied.length > 0) {
				return { decision: "block", reason: `⛔ [HARNESS] 계약의 allowed_paths/target_ownership 밖 파일 변경: ${denied.join(", ")}` };
			}
		}
		if (normalizedToolName(toolName) === "shell") {
			const command = String(toolInput.command || "").trim();
			if (!readOnlyShell(command) && !(resolution.contract.allowed_shell_commands || []).includes(command)) {
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
	const raw = readStdin();
	let data = {};
	try { data = JSON.parse(raw || "{}"); } catch { /* fail-open */ }
	sessionRecovery.handleEvent("PreToolUse", raw, data.cwd || process.cwd());
	const output = decide(data);
	if (output) process.stdout.write(JSON.stringify(output));
}

if (require.main === module) main();
module.exports = { bootstrapWriteAllowed, contractAllowsTarget, contractPathMatches, decide, entrypointMutationOutsideHelper, entrypointTarget, fileMutationTargets, main, normalizedToolName, patchTargets, readOnlyShell, reclaimCommandAllowed, stateTarget };
