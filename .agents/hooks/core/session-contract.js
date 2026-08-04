/**
 * Lightweight session-contract resolver shared by session injection and
 * mutation gates. Progress is evidence of execution state, never authority.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STATES = Object.freeze({
	BOUND: "BOUND",
	UNBOUND: "UNBOUND",
	AMBIGUOUS: "AMBIGUOUS",
	STALE: "STALE",
	CROSS_PROJECT: "CROSS_PROJECT",
});

function stableValue(value) {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, stableValue(value[key])]),
	);
}

function contractDigest(contract) {
	const unsigned = { ...contract };
	delete unsigned.contract_digest;
	unsigned.session_bindings = (unsigned.session_bindings || []).map((binding) => {
		if (!binding || typeof binding !== "object") return binding;
		const normalized = { ...binding };
		delete normalized.contract_digest;
		return normalized;
	});
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(stableValue(unsigned)))
		.digest("hex");
}

function inside(parent, candidate) {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findProjectRoot(start) {
	let current = path.resolve(start || process.cwd());
	while (true) {
		if (fs.existsSync(path.join(current, ".agents", "context", "agents-rules.json"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function readJson(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function result(status, projectRoot, reason, extra = {}) {
	return { status, projectRoot, reason, ...extra };
}

function bindingSessionId(binding) {
	return typeof binding === "string" ? binding : binding?.session_id;
}

const REQUIRED_ARRAYS = [
	"scope",
	"non_goals",
	"success_criteria",
	"allowed_paths",
	"target_ownership",
	"audiences",
	"source_refs",
	"session_bindings",
];
const CONTRACT_KEYS = new Set([
	"schema_version", "id", "status", "project_root", "goal", "scope",
	"non_goals", "success_criteria", "allowed_paths", "target_ownership",
	"audiences", "source_refs", "session_bindings", "progress_file",
	"contract_digest", "allowed_shell_commands",
]);

function supportedOwnershipPattern(value) {
	if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("..")) return false;
	const stars = value.match(/\*/g) || [];
	return stars.length === 0 || (stars.length === 2 && value.endsWith("/**"));
}

function validateContractShape(contract) {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return "contract_not_object";
	if (Object.keys(contract).some((key) => !CONTRACT_KEYS.has(key))) return "contract_additional_property";
	if (contract.schema_version !== "1.0") return "unsupported_schema_version";
	if (typeof contract.id !== "string" || !contract.id) return "invalid_contract_id";
	if (!["active", "closed"].includes(contract.status)) return "invalid_contract_status";
	if (contract.project_root !== ".") return "invalid_project_root";
	for (const key of ["goal", "progress_file", "contract_digest"]) {
		if (typeof contract[key] !== "string" || !contract[key]) return `invalid_${key}`;
	}
	for (const key of REQUIRED_ARRAYS) {
		if (!Array.isArray(contract[key])) return `invalid_${key}`;
	}
	for (const key of ["scope", "non_goals", "success_criteria", "allowed_paths", "target_ownership", "audiences", "source_refs"]) {
		if (contract[key].some((item) => typeof item !== "string")) return `invalid_${key}_item`;
	}
	if (contract.allowed_shell_commands != null && (
		!Array.isArray(contract.allowed_shell_commands) ||
		contract.allowed_shell_commands.some((item) => typeof item !== "string" || !item.trim() || /[\r\n]/.test(item))
	)) return "invalid_allowed_shell_commands";
	for (const key of ["scope", "success_criteria", "allowed_paths", "target_ownership", "audiences", "source_refs", "session_bindings"]) {
		if (contract[key].length === 0) return `empty_${key}`;
	}
	if (!contract.allowed_paths.every(supportedOwnershipPattern)) return "unsupported_allowed_path_pattern";
	if (!contract.target_ownership.every(supportedOwnershipPattern)) return "unsupported_target_ownership_pattern";
	if (!contract.session_bindings.every((binding) =>
		binding && typeof binding === "object" && !Array.isArray(binding) &&
		Object.keys(binding).every((key) => ["session_id", "contract_digest"].includes(key)) &&
		typeof binding.session_id === "string" && binding.session_id &&
		/^[a-f0-9]{64}$/.test(binding.contract_digest || "")
	)) return "invalid_session_bindings";
	if (!/^\.agents\/progress\/[^/]+\.json$/.test(contract.progress_file)) return "invalid_progress_file";
	if (!/^[a-f0-9]{64}$/.test(contract.contract_digest)) return "invalid_contract_digest";
	return null;
}

function activeContracts(contractsDir) {
	let names = [];
	try {
		names = fs.readdirSync(contractsDir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.map((name) => {
			const filePath = path.join(contractsDir, name);
			return { filePath, contract: readJson(filePath) };
		})
		.filter(({ contract }) => contract && contract.status === "active");
}

function ownershipPatterns(contract) {
	return Array.isArray(contract.target_ownership) ? contract.target_ownership : [];
}

function ownershipPrefix(pattern) {
	return String(pattern).replace(/\/\*\*.*$/, "").replace(/\/$/, "");
}

function ownershipOverlaps(left, right) {
	for (const a of ownershipPatterns(left)) {
		for (const b of ownershipPatterns(right)) {
			const ap = ownershipPrefix(a);
			const bp = ownershipPrefix(b);
			if (ap === bp || ap.startsWith(`${bp}/`) || bp.startsWith(`${ap}/`)) return true;
		}
	}
	return false;
}

/**
 * Resolve an explicit lightweight session binding in the nearest project only.
 * No ancestor workspace or child project is searched.
 */
function resolveSessionContract({ cwd, sessionId }) {
	const projectRoot = findProjectRoot(cwd);
	if (!projectRoot || !sessionId) {
		return result(STATES.UNBOUND, projectRoot, "missing_project_or_session");
	}

	const contractsDir = path.join(projectRoot, ".agents", "session-contracts");
	const registryPath = path.join(contractsDir, ".session-map.json");
	const registry = readJson(registryPath);
	if (!registry) return result(STATES.UNBOUND, projectRoot, "registry_missing");

	const pointer = registry.bindings?.[sessionId];
	if (!pointer) return result(STATES.UNBOUND, projectRoot, "binding_missing");
	if (!pointer.contract_path || !pointer.contract_id || !pointer.contract_digest) {
		return result(STATES.STALE, projectRoot, "binding_incomplete", { registryPath });
	}

	const contractPath = path.resolve(projectRoot, pointer.contract_path);
	if (!inside(contractsDir, contractPath) || path.basename(contractPath).startsWith(".")) {
		return result(STATES.CROSS_PROJECT, projectRoot, "contract_path_outside_project", {
			registryPath,
			contractPath,
		});
	}

	const duplicates = activeContracts(contractsDir).filter(({ contract }) =>
		(contract.session_bindings || []).some(
			(binding) => bindingSessionId(binding) === sessionId,
		),
	);
	if (duplicates.length > 1) {
		return result(STATES.AMBIGUOUS, projectRoot, "duplicate_session_binding", {
			contractPaths: duplicates.map(({ filePath }) => filePath),
		});
	}

	const contract = readJson(contractPath);
	if (!contract) {
		return result(STATES.STALE, projectRoot, "contract_missing_or_invalid", {
			registryPath,
			contractPath,
		});
	}
	const shapeError = validateContractShape(contract);
	if (shapeError) {
		return result(STATES.STALE, projectRoot, shapeError, {
			registryPath,
			contractPath,
		});
	}
	if (contract.id !== pointer.contract_id || contract.status !== "active") {
		return result(STATES.STALE, projectRoot, "contract_identity_or_status_mismatch", {
			registryPath,
			contractPath,
		});
	}
	const ownershipConflicts = activeContracts(contractsDir).filter(
		({ filePath, contract: candidate }) =>
			path.resolve(filePath) !== contractPath && ownershipOverlaps(contract, candidate),
	);
	if (ownershipConflicts.length > 0) {
		return result(STATES.AMBIGUOUS, projectRoot, "target_ownership_conflict", {
			contractPath,
			conflictingContractPaths: ownershipConflicts.map(({ filePath }) => filePath),
		});
	}

	const declaredRoot = path.resolve(projectRoot, contract.project_root || ".");
	if (declaredRoot !== projectRoot) {
		return result(STATES.CROSS_PROJECT, projectRoot, "contract_project_mismatch", {
			registryPath,
			contractPath,
		});
	}

	const expectedDigest = contractDigest(contract);
	if (
		contract.contract_digest !== expectedDigest ||
		pointer.contract_digest !== expectedDigest
	) {
		return result(STATES.STALE, projectRoot, "contract_digest_mismatch", {
			registryPath,
			contractPath,
			expectedDigest,
		});
	}

	const matchingBindings = (contract.session_bindings || []).filter(
		(binding) => bindingSessionId(binding) === sessionId,
	);
	if (matchingBindings.length > 1) {
		return result(STATES.AMBIGUOUS, projectRoot, "duplicate_binding_in_contract", {
			registryPath,
			contractPath,
		});
	}
	const binding = matchingBindings[0];
	if (!binding || typeof binding === "string" || binding.contract_digest !== expectedDigest) {
		return result(STATES.STALE, projectRoot, "contract_binding_mismatch", {
			registryPath,
			contractPath,
		});
	}

	const progressPath = path.resolve(projectRoot, contract.progress_file || "");
	const progressDir = path.join(projectRoot, ".agents", "progress");
	if (!contract.progress_file || !inside(progressDir, progressPath)) {
		return result(STATES.CROSS_PROJECT, projectRoot, "progress_path_outside_project", {
			registryPath,
			contractPath,
			progressPath,
		});
	}
	const progress = readJson(progressPath);
	if (
		!progress ||
		progress.contract_id !== contract.id ||
		progress.contract_digest !== expectedDigest
	) {
		return result(STATES.STALE, projectRoot, "progress_contract_mismatch", {
			registryPath,
			contractPath,
			progressPath,
		});
	}

	return result(STATES.BOUND, projectRoot, "explicit_binding_verified", {
		registryPath,
		contractPath,
		contract,
		progressPath,
		progress,
	});
}

module.exports = {
	STATES,
	contractDigest,
	findProjectRoot,
	inside,
	ownershipOverlaps,
	resolveSessionContract,
	stableValue,
	supportedOwnershipPattern,
	validateContractShape,
};
