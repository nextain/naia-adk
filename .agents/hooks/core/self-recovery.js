"use strict";
/**
 * The one thing every guard must let through: a session repairing its own binding.
 *
 * Guards are written independently and each fails closed on its own terms. That
 * is fine until the thing being guarded is the session's own contract — then a
 * single bad state locks the session out of the only files that could fix it,
 * and a human has to open the file by hand. For an unattended runtime (the
 * Discord gateway, a scheduled job) there is no human to open it, so the session
 * stops for good.
 *
 * A repair write is narrow: it targets the session's own contract, its progress
 * record, or its own entry in the registry. Whether the *content* is acceptable
 * is still judged by the session-contract gate's bootstrap rule, which checks
 * the three files against each other. This module only answers "is this session
 * trying to fix its own binding?", so other guards can step aside instead of
 * standing between a session and its own recovery.
 */
const fs = require("fs");
const path = require("path");

const CONTRACTS_DIR = path.join(".agents", "session-contracts");
const REGISTRY_NAME = ".session-map.json";
const PROGRESS_DIR = path.join(".agents", "progress");

function readJson(filePath) {
	try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
	catch { return null; }
}

/** File paths a mutation touches, across the tool shapes the hosts use. */
function mutationTargets(toolInput) {
	if (!toolInput || typeof toolInput !== "object") return [];
	const targets = [];
	for (const key of ["file_path", "path", "notebook_path"]) {
		if (typeof toolInput[key] === "string" && toolInput[key]) targets.push(toolInput[key]);
	}
	// The hosts do not agree on one key. The session-contract gate reads
	// patch, then command, then input; reading fewer of them here meant the
	// same apply_patch was self-recovery to one guard and an ordinary mutation
	// to another.
	const patch = typeof toolInput.patch === "string" ? toolInput.patch
		: typeof toolInput.command === "string" ? toolInput.command
		: typeof toolInput.input === "string" ? toolInput.input : "";
	for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm)) {
		targets.push(match[1]);
	}
	return targets;
}

/**
 * Whether this path is part of the session's own binding.
 *
 * The registry counts only as "the session's own" because the bootstrap rule
 * limits what a session may write there to its own entry; ownership of the file
 * is shared.
 */
function bindingFileFor(projectRoot, sessionId, target) {
	const relative = path.relative(projectRoot, path.resolve(projectRoot, target)).replaceAll("\\", "/");
	if (relative.startsWith("..")) return null;
	const contractsDir = CONTRACTS_DIR.replaceAll("\\", "/");
	const progressDir = PROGRESS_DIR.replaceAll("\\", "/");

	if (relative === `${contractsDir}/${REGISTRY_NAME}`) return "registry";

	if (relative.startsWith(`${contractsDir}/`) && relative.endsWith(".json") && !path.basename(relative).startsWith(".")) {
		const contract = readJson(path.join(projectRoot, relative));
		// A contract file that names this session — even if its digest no longer
		// matches, which is exactly the state that needs repairing.
		if (Array.isArray(contract?.session_bindings)
			&& contract.session_bindings.some((binding) => binding?.session_id === sessionId)) return "contract";
		return null;
	}

	if (relative.startsWith(`${progressDir}/`) && relative.endsWith(".json")) {
		const progress = readJson(path.join(projectRoot, relative));
		if (!progress?.contract_id) return null;
		const contractPath = path.join(projectRoot, contractsDir, `${progress.contract_id}.json`);
		const contract = readJson(contractPath);
		if (Array.isArray(contract?.session_bindings)
			&& contract.session_bindings.some((binding) => binding?.session_id === sessionId)) return "progress";
		return null;
	}

	return null;
}

/**
 * True when every path this call touches belongs to the session's own binding.
 *
 * All-or-nothing on purpose: a write that repairs the contract *and* edits
 * something else is not a repair, and must be judged normally.
 */
function isSelfRecoveryWrite({ toolInput, projectRoot, sessionId } = {}) {
	if (!projectRoot || !sessionId) return false;
	const targets = mutationTargets(toolInput);
	if (targets.length === 0) return false;
	return targets.every((target) => bindingFileFor(projectRoot, sessionId, target) !== null);
}

module.exports = { bindingFileFor, isSelfRecoveryWrite, mutationTargets };
