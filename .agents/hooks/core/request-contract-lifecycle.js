"use strict";
module.exports = function createRequestContractModule(api) {
const {
	fs, path, cp, VERSION, DIR_MODE, WINDOWS_CURRENT_PROCESS_IDENTITY, ZERO_HASH, HELD_LOCKS,
	CONTROL_INPUT_NAMES, PRESERVATION_REVIEW_ROLES, sha256, opaqueId, canonicalJson, ensureDir, durableRename, durableUnlink,
	durableRemoveTree, secureJson, appendJsonl, readJson, requiredJson, stateDigest, readUnitState, readJsonlStrict,
	normalizeRel, boundedInteger,
} = api;
function listUnconsumedQuarantine(...args) { return api.listUnconsumedQuarantine(...args); }
function validateSuccessfulTerminalUnlocked(...args) { return api.validateSuccessfulTerminalUnlocked(...args); }

function loadConfig(cwd) {
	const file = path.join(cwd, ".agents", "context", "request-contract.json");
	const parsed = readJson(file, null);
	const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	const productRoots = [...new Set((raw.product_roots || ["."]).map(normalizeRel))].sort();
	const exclusions = [...new Set((raw.exclusions || []).map(normalizeRel))].sort();
	const configErrors = [];
	if (!parsed) configErrors.push(fs.existsSync(file) ? "request_contract_config_unreadable" : "request_contract_config_missing");
	for (const [kind, values] of [["product_root", productRoots], ["exclusion", exclusions]]) {
		for (const value of values) {
			if (path.isAbsolute(value) || value === ".." || value.startsWith("../") || value.includes("/../")) configErrors.push(`${kind}_escape:${value}`);
		}
	}
	const canonical = {
		version: raw.version || VERSION,
		installation_state: raw.installation_state || (raw.enabled_by_default === true ? "enforced" : "unprovisioned"),
		enabled_by_default: raw.enabled_by_default === true,
		minimum_clean_rounds: boundedInteger(raw.minimum_clean_rounds, "minimum_clean_rounds", 2, 2, 64, configErrors),
		stop_attempt_limit: boundedInteger(raw.stop_attempt_limit, "stop_attempt_limit", 3, 3, 100, configErrors),
		product_roots: productRoots,
		exclusions,
		preservation: {
			required: Boolean(raw.preservation && raw.preservation.required),
			protect_test_contracts: !raw.preservation || raw.preservation.protect_test_contracts !== false,
			protect_vendor_sources: !raw.preservation || raw.preservation.protect_vendor_sources !== false,
			allowed_adapter_digests: [...new Set((raw.preservation && raw.preservation.allowed_adapter_digests) || [])].sort(),
		},
		release: {
			shell_tools: [...new Set((raw.release && raw.release.shell_tools) || ["Bash", "shell_command"])].sort(),
			command_patterns: [...new Set((raw.release && raw.release.command_patterns) || [])].sort(),
		},
		supported_clients: raw.supported_clients || {},
		authority: {
			public_key_env: (raw.authority && raw.authority.public_key_env) || "REQUEST_CONTRACT_PUBLIC_KEY",
			public_key_path: normalizeRel((raw.authority && raw.authority.public_key_path) || ".agents/context/request-contract-authority.pub"),
			credential_id: (raw.authority && raw.authority.credential_id) || "",
			require_user_presence: !raw.authority || raw.authority.require_user_presence !== false,
			require_non_exportable: !raw.authority || raw.authority.require_non_exportable !== false,
		},
			reviewer: {
			public_key_env: (raw.reviewer && raw.reviewer.public_key_env) || "REQUEST_CONTRACT_REVIEWER_PUBLIC_KEY",
			public_key_path: normalizeRel((raw.reviewer && raw.reviewer.public_key_path) || ".agents/context/request-contract-reviewer.pub"),
			credential_id: (raw.reviewer && raw.reviewer.credential_id) || "",
			require_no_network: !raw.reviewer || raw.reviewer.require_no_network !== false,
			require_repository_blind: !raw.reviewer || raw.reviewer.require_repository_blind !== false,
				require_home_blind: !raw.reviewer || raw.reviewer.require_home_blind !== false,
				allowed_attestor_digests: [...new Set((raw.reviewer && raw.reviewer.allowed_attestor_digests) || [])].sort(),
				required_roles: [...new Set((raw.reviewer && raw.reviewer.required_roles) || (raw.preservation && raw.preservation.required ? PRESERVATION_REVIEW_ROLES : []))].sort(),
			},
			review_runner: {
				public_key_env: (raw.review_runner && raw.review_runner.public_key_env) || "REQUEST_CONTRACT_REVIEW_RUNNER_PUBLIC_KEY",
				public_key_path: normalizeRel((raw.review_runner && raw.review_runner.public_key_path) || ".agents/context/request-contract-review-runner.pub"),
				credential_id: (raw.review_runner && raw.review_runner.credential_id) || "",
				allowed_reviewer_digests: [...new Set((raw.review_runner && raw.review_runner.allowed_reviewer_digests) || [])].sort(),
				allowed_sandbox_digests: [...new Set((raw.review_runner && raw.review_runner.allowed_sandbox_digests) || [])].sort(),
				allowed_attestor_digests: [...new Set((raw.review_runner && raw.review_runner.allowed_attestor_digests) || [])].sort(),
			},
			retention: {
				success_hours: boundedInteger(raw.retention && raw.retention.success_hours, "retention_success_hours", 24, 1, 87_600, configErrors),
			},
	};
	if (!["unprovisioned", "enforced"].includes(canonical.installation_state)) configErrors.push("installation_state_invalid");
	if (canonical.installation_state === "unprovisioned" && canonical.enabled_by_default) configErrors.push("unprovisioned_default_enable_invalid");
	for (const tool of canonical.release.shell_tools) if (typeof tool !== "string" || !tool.trim()) configErrors.push("release_shell_tool_invalid");
	for (const pattern of canonical.release.command_patterns) {
		if (typeof pattern !== "string" || !pattern.trim() || pattern.length > 512) configErrors.push("release_command_pattern_invalid");
		else try { new RegExp(pattern, "i"); } catch { configErrors.push("release_command_pattern_invalid"); }
	}
	for (const role of canonical.reviewer.required_roles) if (typeof role !== "string" || !/^[a-z][a-z0-9_-]{2,63}$/.test(role)) configErrors.push("reviewer_required_role_invalid");
	for (const digest of canonical.preservation.allowed_adapter_digests) if (!/^[a-f0-9]{64}$/.test(digest)) configErrors.push("preservation_adapter_digest_invalid");
	for (const client of ["claude", "codex"]) {
		if (typeof canonical.supported_clients[client] !== "string" || !/^>=\d+\.\d+\.\d+$/.test(canonical.supported_clients[client])) configErrors.push(`supported_client_invalid:${client}`);
	}
	return { ...canonical, digest: sha256(canonicalJson(canonical)), file, errors: configErrors };
}

function loadAuthorityKey(cwd, config = loadConfig(cwd), env = process.env) {
	const inline = String(env[config.authority.public_key_env] || "").replace(/\\n/g, "\n").trim();
	if (inline) return inline;
	try {
		const candidate = path.resolve(cwd, config.authority.public_key_path);
		if (candidate !== cwd && !candidate.startsWith(cwd + path.sep)) return null;
		return fs.readFileSync(candidate, "utf8").trim() || null;
	} catch {
		return null;
	}
}

function loadConfiguredKey(cwd, envName, relativePath, env = process.env) {
	const inline = String(env[envName] || "").replace(/\\n/g, "\n").trim();
	if (inline) return inline;
	try {
		const candidate = path.resolve(cwd, relativePath);
		if (candidate !== cwd && !candidate.startsWith(cwd + path.sep)) return null;
		return fs.readFileSync(candidate, "utf8").trim() || null;
	} catch {
		return null;
	}
}

function loadReviewerKey(cwd, config = loadConfig(cwd), env = process.env) {
	return loadConfiguredKey(cwd, config.reviewer.public_key_env, config.reviewer.public_key_path, env);
}

function loadReviewRunnerKey(cwd, config = loadConfig(cwd), env = process.env) {
	return loadConfiguredKey(cwd, config.review_runner.public_key_env, config.review_runner.public_key_path, env);
}

function preservationRunnerContext(cwd, config = loadConfig(cwd), env = process.env) {
	return {
		public_key: loadReviewRunnerKey(cwd, config, env),
		credential_id: config.review_runner.credential_id || null,
		allowed_digests: config.review_runner.allowed_attestor_digests || [],
	};
}

function harnessRoot(cwd) {
	return path.join(cwd, ".agents", "harness");
}

function hasStickyGovernanceState(cwd) {
	// A successful lineage remains authoritative until retention compaction removes
	// its unit.  Counting only unresolved units would let an environment override
	// or a removed marker bypass the completion-proof revalidation paths.
	return hasUnitStorageState(cwd) || listUnconsumedQuarantine(cwd).length > 0;
}

function governed(cwd, env = process.env) {
	const config = loadConfig(cwd);
	const v = String(env.REQUEST_CONTRACT || "").trim().toLowerCase();
	if (hasStickyGovernanceState(cwd)) return true;
	// Once the hook is installed, a missing or corrupt policy file is not an
	// opt-out mechanism. Enter governed mode so SessionStart fails closed with
	// a concrete configuration diagnostic instead of silently allowing work.
	if (config.errors.length) return true;
	if (["on", "1", "true", "yes"].includes(v)) return true;
	// Installation and enforcement are separate states. A repository may carry
	// the complete policy before signer/reviewer/runner credentials are
	// provisioned; that staged installation must not lock every client session.
	// Once enforcement is declared, environment opt-out is no longer accepted.
	if (config.installation_state === "enforced") return true;
	if (["off", "0", "false", "no"].includes(v)) return false;
	if (fs.existsSync(path.join(cwd, ".agents", "harness", "request-contract-on"))) return true;
	return config.enabled_by_default;
}

function unitPaths(cwd, unitId, unitDirectory = null) {
	const unit = unitDirectory || path.join(harnessRoot(cwd), "units", unitId);
	return {
		unit,
		sources: path.join(unit, "sources.jsonl"),
		head: path.join(unit, "head.json"),
		state: path.join(unit, "state.json"),
		binding: path.join(unit, "binding.json"),
		contract: path.join(unit, "contract.json"),
		scopeHistory: path.join(unit, "scope-history.jsonl"),
		scopeHead: path.join(unit, "scope-head.json"),
		reviews: path.join(unit, "reviews.jsonl"),
		reviewHead: path.join(unit, "review-head.json"),
		authority: path.join(unit, "authority"),
		pending: path.join(unit, "pending"),
		transactions: path.join(unit, "transactions"),
		locks: path.join(unit, "locks"),
	};
}

function controlInputPath(unit, kind) {
	if (!CONTROL_INPUT_NAMES[kind]) throw Object.assign(new Error("unknown request-contract control input kind"), { code: "control_input_kind_invalid" });
	return path.join(unit.paths.pending, CONTROL_INPUT_NAMES[kind]);
}

function processIdentity(pid) {
	try {
		if (!Number.isInteger(pid) || pid <= 0) return null;
		if (process.platform === "win32") {
			if (pid === process.pid && WINDOWS_CURRENT_PROCESS_IDENTITY.value) return WINDOWS_CURRENT_PROCESS_IDENTITY.value;
			const script = "$p = Get-Process -Id __PID__ -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)"
				.replace("__PID__", String(pid));
			const ticks = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 15000,
			}).trim();
			if (!/^\d+$/.test(ticks)) return null;
			const identity = "win32:" + pid + ":" + ticks;
			if (pid === process.pid) WINDOWS_CURRENT_PROCESS_IDENTITY.value = identity;
			return identity;
		}
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		const fields = stat.slice(close + 2).split(" ");
		const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return `${bootId}:${fields[19]}`;
	} catch {
		return null;
	}
}

function lockOwnerAlive(owner) {
	if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if (error.code !== "EPERM") return false;
	}
	const currentIdentity = processIdentity(owner.pid);
	return !owner.process_identity || !currentIdentity || owner.process_identity === currentIdentity;
}

function directoryIdentity(directory) {
	const stat = fs.statSync(directory);
	return { dev: stat.dev, ino: stat.ino };
}

function sameDirectoryIdentity(left, right) {
	return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function reapStaleDirectoryLock(lock, now) {
	const reaper = `${lock}.reaper`;
	try {
		fs.mkdirSync(reaper, { mode: DIR_MODE });
	} catch (error) {
		if (error.code === "EEXIST") return false;
		throw error;
	}
	try {
		let stat;
		let owner;
		try {
			stat = fs.statSync(lock);
			owner = readJson(path.join(lock, "owner.json"));
		} catch (error) {
			if (error.code === "ENOENT") return true;
			throw error;
		}
		// A fresh lock is never reapable, so avoid an expensive process-identity
		// probe on every contention retry (PowerShell startup is material on Windows).
		if (now - stat.mtimeMs <= 30_000 || lockOwnerAlive(owner)) return false;
		const stale = `${lock}.stale.${opaqueId()}`;
		durableRename(lock, stale);
		durableRemoveTree(stale);
		return true;
	} finally {
		durableRemoveTree(reaper);
	}
}

function withDirectoryLock(lock, fn, now = Date.now(), timeoutMs = 5000, opts = {}) {
	if (HELD_LOCKS.has(lock)) return fn();
	ensureDir(path.dirname(lock));
	const deadline = Date.now() + timeoutMs;
	let ownerNonce = null;
	let acquiredIdentity = null;
	let lastPublicationCollision = null;
	for (;;) {
		const candidateNonce = opaqueId("LOCK-");
		const candidate = `${lock}.candidate.${candidateNonce}`;
		try {
			fs.mkdirSync(candidate, { mode: DIR_MODE });
			secureJson(path.join(candidate, "owner.json"), { pid: process.pid, process_identity: processIdentity(process.pid), acquired_at: now, nonce: candidateNonce });
			if (opts.afterCandidatePrepared) opts.afterCandidatePrepared({ candidate, nonce: candidateNonce });
			durableRename(candidate, lock);
			ownerNonce = candidateNonce;
			acquiredIdentity = directoryIdentity(lock);
			const owner = requiredJson(path.join(lock, "owner.json"), "lifecycle_lock_owner_corrupt");
			if (owner.nonce !== ownerNonce || !sameDirectoryIdentity(acquiredIdentity, directoryIdentity(lock))) throw Object.assign(new Error("lifecycle lock publication changed during acquisition"), { code: "lifecycle_lock_publish_race" });
			if (opts.afterLockPublished) opts.afterLockPublished({ lock, nonce: ownerNonce, identity: acquiredIdentity });
			break;
		} catch (error) {
			// Windows reports rename-to-existing-directory as EPERM. The winning
			// owner may release the destination before this catch block observes
			// it, so destination existence cannot be required. Preserve the raw
			// publication diagnostic because EPERM can also mean a permission fault;
			// the fail-closed retry remains intentionally conservative.
			const windowsCollision = process.platform === "win32" && error.code === "EPERM" && fs.existsSync(candidate);
			if (windowsCollision || ["EEXIST", "ENOTEMPTY"].includes(error.code)) {
				lastPublicationCollision = {
					code: error.code,
					message: error.message,
					destination_observed: fs.existsSync(lock),
				};
			}
			try { durableRemoveTree(candidate); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
			if (!windowsCollision && !["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
			try {
				if (reapStaleDirectoryLock(lock, Date.now()) && Date.now() < deadline) continue;
			} catch {
				/* retry until the owner record is stable or the timeout expires */
			}
			if (Date.now() >= deadline) {
				const detail = lastPublicationCollision
					? `; last publication error ${lastPublicationCollision.code}; destination observed=${lastPublicationCollision.destination_observed}`
					: "";
				throw Object.assign(new Error(`lifecycle lock busy${detail}`), {
					code: "lifecycle_lock_busy",
					publication_error: lastPublicationCollision,
				});
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	HELD_LOCKS.add(lock);
	try {
		const owner = requiredJson(path.join(lock, "owner.json"), "lifecycle_lock_owner_corrupt");
		if (owner.nonce !== ownerNonce || !sameDirectoryIdentity(acquiredIdentity, directoryIdentity(lock))) throw Object.assign(new Error("lifecycle lock ownership changed before entry"), { code: "lifecycle_lock_ownership_lost" });
		return fn();
	} finally {
		HELD_LOCKS.delete(lock);
		const releaseDeadline = Date.now() + Math.min(timeoutMs, 10_000);
		for (;;) {
			const owner = readJson(path.join(lock, "owner.json"));
			let currentIdentity = null;
			try { currentIdentity = directoryIdentity(lock); } catch (error) { if (error.code === "ENOENT") break; throw error; }
			if (!owner || owner.nonce !== ownerNonce || !sameDirectoryIdentity(acquiredIdentity, currentIdentity)) {
				throw Object.assign(new Error("lifecycle lock ownership changed before release"), { code: "lifecycle_lock_ownership_lost" });
			}
			const released = `${lock}.released.${ownerNonce}`;
			try {
				durableRename(lock, released);
				durableRemoveTree(released);
				break;
			} catch (error) {
				if (error.code === "ENOENT") break;
				const retryable = process.platform === "win32" && ["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code);
				if (!retryable || Date.now() >= releaseDeadline) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
			}
		}
	}
}

function withUnitLock(unit, fn, now = Date.now()) {
	const lock = path.join(unit.paths.locks, "lifecycle");
	return withDirectoryLock(lock, () => {
		recoverUnitTransactions(unit);
		return fn();
	}, now, unit.lockTimeoutMs || 5000);
}

function withRepositoryLock(cwd, fn, now = Date.now(), timeoutMs = 30_000) {
	return withDirectoryLock(path.join(harnessRoot(cwd), "locks", "repository-lifecycle"), fn, now, timeoutMs);
}

function claimGlobalId(cwd, kind, value, owner) {
	if (typeof value !== "string" || !value) throw Object.assign(new Error(`${kind} identifier is missing`), { code: `${kind}_id_missing` });
	const dir = path.join(harnessRoot(cwd), "claims", kind);
	const file = path.join(dir, `${sha256(value)}.json`);
	const claim = { version: VERSION, kind, value_digest: sha256(value), ...owner };
	if (fs.existsSync(file)) {
		const existing = requiredJson(file, `${kind}_claim_corrupt`);
		if (canonicalJson(existing) !== canonicalJson(claim)) throw Object.assign(new Error(`${kind} identifier was already used`), { code: `${kind}_id_replayed` });
		return existing;
	}
	secureJson(file, claim, { exclusive: true });
	return claim;
}

function claimGlobalIds(cwd, entries) {
	const prepared = entries.map(({ kind, value, owner }) => {
		if (typeof value !== "string" || !value) throw Object.assign(new Error(`${kind} identifier is missing`), { code: `${kind}_id_missing` });
		const file = path.join(harnessRoot(cwd), "claims", kind, `${sha256(value)}.json`);
		const claim = { version: VERSION, kind, value_digest: sha256(value), ...owner };
		if (fs.existsSync(file)) {
			const existing = requiredJson(file, `${kind}_claim_corrupt`);
			if (canonicalJson(existing) !== canonicalJson(claim)) throw Object.assign(new Error(`${kind} identifier was already used`), { code: `${kind}_id_replayed` });
			return { file, claim: existing, exists: true };
		}
		return { file, claim, exists: false };
	});
	for (const item of prepared) if (!item.exists) secureJson(item.file, item.claim, { exclusive: true });
	return prepared.map((item) => item.claim);
}

function verifyGlobalClaim(cwd, kind, value, owner) {
	const file = path.join(harnessRoot(cwd), "claims", kind, `${sha256(value)}.json`);
	const existing = requiredJson(file, `${kind}_claim_missing`);
	const expected = { version: VERSION, kind, value_digest: sha256(value), ...owner };
	if (canonicalJson(existing) !== canonicalJson(expected)) throw Object.assign(new Error(`${kind} claim does not match this unit`), { code: `${kind}_claim_mismatch` });
	return existing;
}

function transactionPath(...args) { return api.transactionPath(...args); }
function applyStateTransaction(...args) { return api.applyStateTransaction(...args); }
function applySourceTransaction(...args) { return api.applySourceTransaction(...args); }
function applyScopeTransactionRecord(...args) { return api.applyScopeTransactionRecord(...args); }
function applyBindTransaction(...args) { return api.applyBindTransaction(...args); }
function applyResumeTransaction(...args) { return api.applyResumeTransaction(...args); }
function applyReviewTransaction(...args) { return api.applyReviewTransaction(...args); }
function applySessionTransaction(...args) { return api.applySessionTransaction(...args); }
function recoverUnitTransactions(...args) { return api.recoverUnitTransactions(...args); }
function assertUnitMutable(...args) { return api.assertUnitMutable(...args); }
function listUnits(...args) { return api.listUnits(...args); }
function hasUnitStorageState(...args) { return api.hasUnitStorageState(...args); }
function findUnit(...args) { return api.findUnit(...args); }
function unresolvedUnits(...args) { return api.unresolvedUnits(...args); }
function successfulHandoffExists(...args) { return api.successfulHandoffExists(...args); }
function validateSuccessfulHandoffsBeforeGenesis(...args) { return api.validateSuccessfulHandoffsBeforeGenesis(...args); }


	return {
		listUnconsumedQuarantine,
		validateSuccessfulTerminalUnlocked,
		loadConfig,
		loadAuthorityKey,
		loadConfiguredKey,
		loadReviewerKey,
		loadReviewRunnerKey,
		preservationRunnerContext,
		harnessRoot,
		hasStickyGovernanceState,
		governed,
		unitPaths,
		controlInputPath,
		processIdentity,
		lockOwnerAlive,
		directoryIdentity,
		sameDirectoryIdentity,
		reapStaleDirectoryLock,
		withDirectoryLock,
		withUnitLock,
		withRepositoryLock,
		claimGlobalId,
		claimGlobalIds,
		verifyGlobalClaim,
		transactionPath,
		applyStateTransaction,
		applySourceTransaction,
		applyScopeTransactionRecord,
		applyBindTransaction,
		applyResumeTransaction,
		applyReviewTransaction,
		applySessionTransaction,
		recoverUnitTransactions,
		assertUnitMutable,
		listUnits,
		hasUnitStorageState,
		findUnit,
		unresolvedUnits,
		successfulHandoffExists,
		validateSuccessfulHandoffsBeforeGenesis,
	};
};
