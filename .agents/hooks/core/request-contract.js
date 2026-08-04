/**
 * Request-contract integrity core.
 *
 * Tool-neutral policy for preserving the complete user request before an
 * agent can claim success. Host adapters translate envelopes only; they do
 * not own policy. Runtime instances are private and ignored under
 * .agents/harness/{units,quarantine,receipts-v2}.
 *
 * Threat model: prevents sincere scope drift and stale/self-inconsistent
 * completion. It does not resist an actor that rewrites every local record.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const preservationPolicy = require("./preservation-contract.js");
const preservationReceipts = require("./preservation-receipt-evidence.js");

const VERSION = 1;
const DIR_MODE = 0o700;
const WINDOWS_CURRENT_PROCESS_IDENTITY = { value: null };
const FILE_MODE = 0o600;
const ZERO_HASH = "0".repeat(64);
const TERMINAL = new Set(["done", "superseded", "deferred", "abandoned"]);
const TRACE_KEYS = ["requirements", "use_cases", "use_case_tests", "features", "feature_tests", "implementations", "evidence"];
const TRACE_EDGES = [{ from: "directives", to: "requirements", kind: "directives_to_requirements" }].concat(
	TRACE_KEYS.slice(0, -1).map((from, index) => ({ from, to: TRACE_KEYS[index + 1], kind: `${from}_to_${TRACE_KEYS[index + 1]}` })),
);
const SCOPE_STATES = new Set(["pending", "active", "done", "superseded", "deferred", "abandoned"]);
const CLASSIFICATIONS = new Set(["directive", "context", "reference", "example", "conversation", "approval", "question", "internal", "authority"]);
const SOURCE_SUBJECTS = new Set(["agent_workflow", "artifact_runtime", "artifact_content", "end_user_flow"]);
const SOURCE_EFFECTS = new Set(["background", "precondition", "outcome", "constraint", "presentation", "verification", "audience"]);
const RENDER_POLICIES = new Set(["deny", "derive", "quote", "require"]);
const OUTPUT_KINDS = new Set(["code_symbol", "code_hunk", "ui_string", "document_heading", "document_paragraph", "developer_comment"]);
const OUTPUT_AUDIENCES = new Set(["developer", "reviewer", "internal", "end_user", "partner", "public"]);
const OUTPUT_EXPOSURES = new Set(["internal", "repository", "product_ui", "external"]);
const AUTH_OPS = new Set(["authorize_contract", "amend_scope_add", "amend_scope_replace", "supersede", "defer", "abandon", "resume"]);
const REVIEW_FINDING_CODES = new Set(["FINDING-SEMANTIC-SCOPE-OMISSION", "FINDING-SOURCE-MAPPING", "FINDING-TRACE-GAP", "FINDING-AUTHORITY-MISMATCH", "FINDING-EVIDENCE-GAP", "FINDING-CONTEXT-OUTPUT-SEPARATION", "FINDING-AUDIENCE-SURFACE-FIT", "FINDING-UNJUSTIFIED-PRODUCT-SURFACE", "FINDING-OTHER"]);
const TERMINAL_AUTHORITY_OP = { superseded: "supersede", deferred: "defer", abandoned: "abandon" };
const HELD_LOCKS = new Set();
const ID_PATTERN = /^[A-Z][A-Z0-9_-]{2,127}$/;
const REQUIRED_CLIENT_EVENTS = ["PreToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "PostCompact", "Stop"];
const CONTROL_INPUT_NAMES = Object.freeze({ contract: "contract-input.json", authority: "authority-presentation-input.json", resume: "resume-receipt-input.json" });
const PRESERVATION_REVIEW_STAGES = Object.freeze(["planning", "integration"]);
const PRESERVATION_REVIEW_ROLES = Object.freeze(["source_fidelity", "baseline_preservation", "implementation_test", "authority_release"]);

function closedObject(value, allowed, errors, code) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		errors.push(`${code}_shape_invalid`);
		return false;
	}
	for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${code}_extra_field`);
	return true;
}

function validId(value) {
	return typeof value === "string" && ID_PATTERN.test(value);
}

function sha256(value) {
	return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

function publicKeyFingerprint(value) {
	try {
		const der = crypto.createPublicKey(value).export({ type: "spki", format: "der" });
		return sha256(der);
	} catch {
		return sha256(String(value || "").trim());
	}
}

function opaqueId(prefix = "") {
	return prefix + crypto.randomBytes(16).toString("hex");
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
		return out;
	}
	return value;
}

function canonicalJson(value) {
	return JSON.stringify(canonicalize(value));
}

function ensureDir(dir) {
	const missing = [];
	let cursor = dir;
	while (!fs.existsSync(cursor)) {
		missing.push(cursor);
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	try {
		fs.chmodSync(dir, DIR_MODE);
	} catch {
		/* best effort on platforms without POSIX modes */
	}
	for (const created of missing.reverse()) {
		fsyncDirectory(created);
		const parent = path.dirname(created);
		if (parent !== created) fsyncDirectory(parent);
	}
}

function fsyncDirectory(dir) {
	let fd;
	try {
		fd = fs.openSync(dir, fs.constants.O_RDONLY);
		fs.fsyncSync(fd);
	} catch (error) {
		if (process.platform === "win32" && ["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error.code)) return;
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function durableRename(from, to) {
	fs.renameSync(from, to);
	const fromDir = path.dirname(from);
	const toDir = path.dirname(to);
	fsyncDirectory(toDir);
	if (fromDir !== toDir) fsyncDirectory(fromDir);
}

function durableUnlink(file) {
	try {
		fs.unlinkSync(file);
		fsyncDirectory(path.dirname(file));
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function durableRemoveTree(directory) {
	try {
		fs.rmSync(directory, { recursive: true, force: false });
		fsyncDirectory(path.dirname(directory));
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function secureWrite(file, data, opts = {}) {
	ensureDir(path.dirname(file));
	const payload = Buffer.isBuffer(data) ? data : String(data);
	if (opts.exclusive) {
		const fd = fs.openSync(file, "wx", FILE_MODE);
		try {
			fs.writeFileSync(fd, payload);
			fs.fsyncSync(fd);
		} catch (error) {
			try { fs.closeSync(fd); } finally { durableUnlink(file); }
			throw error;
		} finally {
			try { fs.closeSync(fd); } catch (error) { if (error.code !== "EBADF") throw error; }
		}
		fsyncDirectory(path.dirname(file));
		return;
	}
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${opaqueId()}.tmp`);
	try {
		const fd = fs.openSync(tmp, "wx", FILE_MODE);
		try {
			fs.writeFileSync(fd, payload);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		try {
			fs.chmodSync(tmp, FILE_MODE);
		} catch {
			/* best effort */
		}
		durableRename(tmp, file);
	} catch (error) {
		durableUnlink(tmp);
		throw error;
	}
}

function secureJson(file, value, opts = {}) {
	secureWrite(file, JSON.stringify(value, null, 2) + "\n", opts);
}

function appendJsonl(file, value) {
	ensureDir(path.dirname(file));
	const created = !fs.existsSync(file);
	const fd = fs.openSync(file, "a", FILE_MODE);
	try {
		fs.writeSync(fd, JSON.stringify(value) + "\n");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.chmodSync(file, FILE_MODE);
	} catch {
		/* best effort */
	}
	if (created) fsyncDirectory(path.dirname(file));
}

function readJson(file, fallback = null) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function requiredJson(file, code = "runtime_state_corrupt") {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
		return value;
	} catch (error) {
		throw Object.assign(new Error(`${file}: ${error.message}`), { code });
	}
}

function optionalJson(file, fallback, code = "runtime_state_corrupt") {
	if (!fs.existsSync(file)) return fallback;
	return requiredJson(file, code);
}

function stateDigest(state) {
	return sha256(canonicalJson(state));
}

function readUnitState(unit, head = null) {
	const state = requiredJson(unit.paths.state, "unit_state_corrupt");
	const pinnedHead = head || requiredJson(unit.paths.head, "unit_head_corrupt");
	if (!state.baseline || !/^[a-f0-9]{64}$/.test(state.baseline_digest || "") || state.baseline_digest !== sha256(canonicalJson(state.baseline))) {
		throw Object.assign(new Error("lifecycle baseline manifest does not match its digest"), { code: "unit_baseline_digest_mismatch" });
	}
	if (!/^[a-f0-9]{64}$/.test(pinnedHead.state_digest || "") || pinnedHead.state_digest !== stateDigest(state)) {
		throw Object.assign(new Error("lifecycle state differs from the digest pinned in the unit head"), { code: "unit_state_digest_mismatch" });
	}
	return state;
}

function writeUnitState(unit, state, head = null, opts = {}) {
	if (fs.existsSync(transactionPath(unit, "state"))) recoverUnitTransactions(unit);
	const nextHead = head || requiredJson(unit.paths.head, "unit_head_corrupt");
	nextHead.state_digest = stateDigest(state);
	const transaction = { version: VERSION, kind: "state", state: JSON.parse(JSON.stringify(state)), head: JSON.parse(JSON.stringify(nextHead)) };
	secureJson(transactionPath(unit, "state"), transaction);
	if (opts.afterTransactionPrepared) opts.afterTransactionPrepared(transaction);
	applyStateTransaction(unit, transaction, opts);
	return transaction.head;
}

function readJsonl(file) {
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function readJsonlStrict(file, code = "runtime_jsonl_corrupt", opts = {}) {
	try {
		const raw = fs.readFileSync(file, "utf8");
		if (raw && !raw.endsWith("\n")) throw new Error("truncated final record");
		return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch (error) {
		if (opts.allowMissing && error.code === "ENOENT") return [];
		throw Object.assign(new Error(`${file}: ${error.message}`), { code });
	}
}

function normalizeRel(p) {
	const value = String(p || "");
	return (process.platform === "win32" ? value.replace(/\\/g, "/") : value)
		.replace(/^\.\//, "")
		.replace(/\/+$/, "");
}

function boundedInteger(raw, key, fallback, minimum, maximum, errors) {
	if (raw === undefined) return fallback;
	if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < minimum || raw > maximum) {
		errors.push(`${key}_invalid`);
		return fallback;
	}
	return raw;
}

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

function transactionPath(unit, kind) {
	return path.join(unit.paths.transactions, `${kind}.json`);
}

function applyStateTransaction(unit, transaction, opts = {}) {
	secureJson(unit.paths.state, transaction.state);
	if (opts.afterStateWritten) opts.afterStateWritten(transaction);
	secureJson(unit.paths.head, transaction.head);
	durableUnlink(transactionPath(unit, "state"));
	unit.head = transaction.head;
}

function applySourceTransaction(unit, transaction) {
	const records = readJsonlStrict(unit.paths.sources, "source_log_corrupt", { allowMissing: true });
	const expected = transaction.expected;
	if (records.length === expected.count && (records.length ? records.at(-1).record_hash : ZERO_HASH) === expected.chain_head) {
		appendJsonl(unit.paths.sources, transaction.record);
	} else if (records.length !== expected.count + 1 || records.at(-1).record_hash !== transaction.record.record_hash) {
		throw Object.assign(new Error("source transaction conflicts with source log"), { code: "source_transaction_conflict" });
	}
	secureJson(unit.paths.head, transaction.head);
	durableUnlink(transactionPath(unit, "source"));
}

function applyScopeTransactionRecord(unit, transaction) {
	const records = readJsonlStrict(unit.paths.scopeHistory, "scope_history_corrupt", { allowMissing: true });
	const expected = transaction.expected_scope;
	if (records.length === expected.count && (records.length ? records.at(-1).record_hash : ZERO_HASH) === expected.chain_head) {
		appendJsonl(unit.paths.scopeHistory, transaction.scope_record);
	} else if (records.length !== expected.count + 1 || records.at(-1).record_hash !== transaction.scope_record.record_hash) {
		throw Object.assign(new Error("binding transaction conflicts with scope history"), { code: "binding_transaction_conflict" });
	}
	secureJson(unit.paths.scopeHead, transaction.scope_head);
}

function applyBindTransaction(unit, transaction) {
	applyScopeTransactionRecord(unit, transaction);
	secureJson(unit.paths.contract, transaction.contract);
	secureJson(unit.paths.binding, transaction.binding);
	secureJson(unit.paths.state, transaction.state);
	secureJson(unit.paths.head, transaction.head);
	for (const pending of transaction.pending_updates || []) secureJson(path.join(unit.paths.pending, pending.name), pending.value);
	durableUnlink(transactionPath(unit, "bind"));
}

function applyResumeTransaction(unit, transaction) {
	secureJson(unit.paths.state, transaction.state);
	secureJson(unit.paths.head, transaction.head);
	if (transaction.binding) secureJson(unit.paths.binding, transaction.binding);
	for (const pending of transaction.pending_updates || []) secureJson(path.join(unit.paths.pending, pending.name), pending.value);
	durableUnlink(path.join(unit.paths.locks, "success.lock"));
	durableUnlink(transactionPath(unit, "resume"));
}

function applyReviewTransaction(unit, transaction) {
	const records = readJsonlStrict(unit.paths.reviews, "review_log_corrupt", { allowMissing: true });
	const expected = transaction.expected_review;
	if (records.length === expected.count && (records.length ? records.at(-1).record_hash : ZERO_HASH) === expected.chain_head) {
		appendJsonl(unit.paths.reviews, transaction.record);
	} else if (records.length !== expected.count + 1 || records.at(-1).record_hash !== transaction.record.record_hash) {
		throw Object.assign(new Error("review transaction conflicts with review log"), { code: "review_transaction_conflict" });
	}
	secureJson(unit.paths.reviewHead, transaction.review_head);
	secureJson(path.join(unit.paths.pending, transaction.invocation_name), transaction.invocation);
	if (transaction.private_bundle_name) {
		durableUnlink(path.join(unit.paths.pending, transaction.private_bundle_name));
	}
	durableUnlink(transactionPath(unit, "review"));
}

function applySessionTransaction(unit, transaction) {
	if (transaction.binding) secureJson(unit.paths.binding, transaction.binding);
	secureJson(unit.paths.head, transaction.head);
	durableUnlink(transactionPath(unit, "session"));
}

function recoverUnitTransactions(unit) {
	for (const [kind, apply] of [["state", applyStateTransaction], ["source", applySourceTransaction], ["bind", applyBindTransaction], ["resume", applyResumeTransaction], ["review", applyReviewTransaction], ["session", applySessionTransaction]]) {
		const file = transactionPath(unit, kind);
		if (!fs.existsSync(file)) continue;
		const transaction = requiredJson(file, `${kind}_transaction_corrupt`);
		if (transaction.kind !== kind || transaction.version !== VERSION) throw Object.assign(new Error(`${kind} transaction shape invalid`), { code: `${kind}_transaction_corrupt` });
		apply(unit, transaction);
	}
}

function assertUnitMutable(unit) {
	const terminal = readUnitState(unit).terminal;
	if (terminal) throw Object.assign(new Error(`unit is terminal: ${terminal.status}`), { code: "unit_terminal" });
}

function listUnits(cwd) {
	const dir = path.join(harnessRoot(cwd), "units");
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && /^[a-f0-9]{32}$/.test(e.name))
			.map((e) => e.name);
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw Object.assign(new Error("request-contract unit storage cannot be read"), { code: "unit_storage_unreadable", cause: error });
	}
}

function hasUnitStorageState(cwd) {
	const dir = path.join(harnessRoot(cwd), "units");
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory() || entry.isFile());
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw Object.assign(new Error("request-contract unit storage cannot be read"), { code: "unit_storage_unreadable", cause: error });
	}
}

function findUnit(cwd, client, sessionId) {
	const matches = [];
	for (const id of listUnits(cwd)) {
		const p = unitPaths(cwd, id);
		const head = readJson(p.head);
		const bindings = (head && head.session_bindings) || (head ? [{ client: head.client, session_id: head.session_id }] : []);
		if (head && bindings.some((b) => b.client === client && b.session_id === sessionId) && head.lifecycle !== "compacted") matches.push({ id, paths: p, head });
	}
	if (matches.length > 1) return { error: "duplicate_runtime_binding", matches };
	return matches[0] || null;
}

function unresolvedUnits(cwd) {
	return listUnits(cwd)
		.map((id) => {
			const paths = unitPaths(cwd, id);
			const head = readJson(paths.head);
			const state = readJson(paths.state);
			const corrupt = !head || !state || !/^[a-f0-9]{64}$/.test(head.state_digest || "") || head.state_digest !== stateDigest(state);
			return { id, paths, head, state, corrupt };
		})
		.filter((unit) => {
			if (unit.corrupt) return true;
			if (!unit.head || unit.head.lifecycle === "compacted") return false;
			const terminal = unit.state.terminal;
			return !terminal || terminal.status !== "success";
		});
}

function successfulHandoffExists(cwd, unit, head, terminal) {
	const proof = terminal && terminal.completion_proof;
	if (!proof || !/^[a-f0-9]{64}$/.test(proof.workspace_digest || "")) return false;
	for (const id of listUnits(cwd)) {
		if (id === unit.id) continue;
		const paths = unitPaths(cwd, id);
		const successorHead = readJson(paths.head);
		const successorState = readJson(paths.state);
		if (!successorHead || !successorState || successorHead.created_at < terminal.at) continue;
		if (successorHead.state_digest !== stateDigest(successorState)) continue;
		if (successorHead.config_digest !== head.config_digest) continue;
		if (successorState.genesis_workspace_digest === proof.workspace_digest) return true;
	}
	return false;
}

function validateSuccessfulHandoffsBeforeGenesis(cwd) {
	for (const id of listUnits(cwd)) {
		const unit = { id, paths: unitPaths(cwd, id) };
		withUnitLock(unit, () => {
			const head = requiredJson(unit.paths.head, "unit_head_corrupt");
			const state = readUnitState(unit, head);
			if (!state.terminal || state.terminal.status !== "success") return;
			const verified = validateSuccessfulTerminalUnlocked(unit, cwd, { allowHandoff: true });
			if (!verified.ok) throw Object.assign(new Error(verified.errors.join(", ")), { code: "completion_proof_invalid", errors: verified.errors });
		});
	}
}

function addSessionBinding(unit, client, sessionId, clientVersion = null, hostProcessId = null, hostProcessIdentity = null) {
	const cwd = path.dirname(path.dirname(path.dirname(path.dirname(unit.paths.unit))));
	return withRepositoryLock(cwd, () => {
		const existing = findUnit(cwd, client, sessionId);
		if (existing && (existing.error || existing.id !== unit.id)) {
			throw Object.assign(new Error("runtime session is already bound to another active lineage"), { code: "session_already_bound" });
		}
		return withUnitLock(unit, () => {
			assertUnitMutable(unit);
			const head = JSON.parse(JSON.stringify(requiredJson(unit.paths.head, "unit_head_corrupt")));
			head.session_bindings = head.session_bindings || [{ client: head.client, session_id: head.session_id }];
			const previousSessionBinding = head.session_bindings.find((b) => b.client === client && b.session_id === sessionId) || {};
			let sessionBinding = head.session_bindings.find((b) => b.client === client && b.session_id === sessionId);
			const added = !sessionBinding;
			if (!sessionBinding) {
				sessionBinding = { client, session_id: sessionId };
				head.session_bindings.push(sessionBinding);
			}
			sessionBinding.host_process_ids = [...new Set([...(sessionBinding.host_process_ids || []), hostProcessId].filter((value) => Number.isInteger(value) && value > 0))];
			sessionBinding.host_process_identities = [...new Set([...(sessionBinding.host_process_identities || []), hostProcessIdentity].filter(Boolean))];
			head.client_versions = head.client_versions || {};
			const clientVersionChanged = Boolean(clientVersion && head.client_versions[client] && head.client_versions[client] !== clientVersion);
			if (clientVersion) head.client_versions[client] = clientVersion;
			let binding = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
			const hostProcessChanged = (hostProcessId && !(previousSessionBinding.host_process_ids || []).includes(hostProcessId))
				|| (hostProcessIdentity && !(previousSessionBinding.host_process_identities || []).includes(hostProcessIdentity));
			if (added || clientVersionChanged || hostProcessChanged) {
				head.work_revision += 1;
				if (binding) binding = { ...binding, binding_epoch: binding.binding_epoch + 1 };
			}
			const transaction = { version: VERSION, kind: "session", created_at: Date.now(), head, binding };
			secureJson(transactionPath(unit, "session"), transaction, { exclusive: true });
			applySessionTransaction(unit, transaction);
			unit.head = head;
			return unit;
		});
	});
}

function pathExcluded(rel, exclusions) {
	rel = normalizeRel(rel);
	return exclusions.some((x) => (x.includes("/") ? rel === x || rel.startsWith(x + "/") : rel.split("/").includes(x)));
}

function governedWorkspacePath(cwd, rel, config, opts = {}) {
	rel = normalizeRel(rel);
	if (!rel || path.isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.includes("/../")) return { ok: false, reason: "invalid" };
	if (pathExcluded(rel, config.exclusions)) return { ok: false, reason: "excluded" };
	const rooted = config.product_roots.some((root) => !root || root === "." || rel === root || rel.startsWith(root + "/"));
	if (!rooted) return { ok: false, reason: "outside_product_roots" };
	const absolute = path.resolve(cwd, rel);
	if (absolute !== cwd && !absolute.startsWith(cwd + path.sep)) return { ok: false, reason: "escape" };
	if (opts.physical) {
		try {
			const physicalRoot = fs.realpathSync.native(cwd);
			const physical = fs.realpathSync.native(absolute);
			if (physical !== physicalRoot && !physical.startsWith(physicalRoot + path.sep)) return { ok: false, reason: "symlink_escape" };
			let cursor = cwd;
			for (const segment of rel.split("/")) {
				cursor = path.join(cursor, segment);
				if (fs.lstatSync(cursor).isSymbolicLink()) return { ok: false, reason: "symlink" };
			}
			return { ok: true, rel, absolute, physical };
		} catch {
			return { ok: false, reason: "unreadable" };
		}
	}
	return { ok: true, rel, absolute };
}

function setManifestEntry(out, rel, value) {
	if (Object.prototype.hasOwnProperty.call(out, rel)) throw Object.assign(new Error("workspace paths collide after canonicalization"), { code: "workspace_manifest_path_collision", path: rel });
	out[rel] = value;
}

function walkEntry(abs, rel, exclusions, out, gitlinks = new Set(), cwd = "", gitModes = new Map()) {
	if (pathExcluded(rel, exclusions)) return;
	if (rel && gitlinks.has(rel)) {
		const submodule = path.join(cwd, rel);
		const initialized = fs.existsSync(path.join(submodule, ".git"));
		const commit = initialized ? gitStrict(submodule, ["rev-parse", "HEAD"]) : null;
		const digest = initialized ? workspaceRepositoryDigest(submodule, exclusions) : sha256(canonicalJson({ missing: true }));
		const reference = initialized ? referenceRepositoryDigest(submodule, commit, exclusions) : null;
		setManifestEntry(out, rel, { type: "gitlink", commit, dirty: !reference || digest !== reference, dirty_digest: digest });
		return;
	}
	let st;
	try {
		st = fs.lstatSync(abs);
	} catch (error) {
		throw Object.assign(new Error("workspace entry cannot be inspected"), { code: "workspace_manifest_unreadable", operation: "lstat", path: rel || ".", cause: error });
	}
	if (st.isSymbolicLink()) {
		setManifestEntry(out, rel, { type: "symlink", mode: process.platform === "win32" ? 0o777 : st.mode & 0o777, link: fs.readlinkSync(abs) });
		return;
	}
	if (st.isFile()) {
		setManifestEntry(out, rel, { type: "file", mode: process.platform === "win32" ? (gitModes.get(rel) || 0o644) : st.mode & 0o777, size: st.size, digest: sha256(fs.readFileSync(abs)) });
		return;
	}
	if (!st.isDirectory()) throw Object.assign(new Error("workspace entry type is unsupported"), { code: "workspace_manifest_unsupported_type", path: rel || "." });
	let entries = [];
	try {
		entries = fs.readdirSync(abs, { withFileTypes: true });
	} catch (error) {
		throw Object.assign(new Error("workspace directory cannot be read"), { code: "workspace_manifest_unreadable", operation: "readdir", path: rel || ".", cause: error });
	}
	for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (e.name === ".git") continue;
		const childRel = normalizeRel(path.posix.join(rel, e.name));
		walkEntry(path.join(abs, e.name), childRel, exclusions, out, gitlinks, cwd, gitModes);
	}
}

function git(cwd, args) {
	try {
		return cp.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
	} catch {
		return "";
	}
}

function gitBuffer(cwd, args) {
	try {
		return cp.execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
	} catch {
		return Buffer.alloc(0);
	}
}

function gitStrict(cwd, args) {
	try {
		return cp.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
	} catch (error) {
		throw Object.assign(new Error("Git manifest operation failed"), { code: "workspace_manifest_git_error", operation: args[0], cause: error });
	}
}

function gitBufferStrict(cwd, args) {
	try {
		return cp.execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
	} catch (error) {
		throw Object.assign(new Error("Git manifest operation failed"), { code: "workspace_manifest_git_error", operation: args[0], cause: error });
	}
}

function parseGitTree(raw) {
	const parsed = [];
	const paths = new Set();
	for (const entry of raw.toString("utf8").split("\0").filter(Boolean)) {
		const match = entry.match(/^(\d+)\s+(\S+)\s+([a-f0-9]+)\t([\s\S]+)$/);
		if (!match) throw Object.assign(new Error("Git tree output is malformed"), { code: "workspace_manifest_git_parse_error" });
		const [, mode, type, oid, rawPath] = match;
		const rel = normalizeRel(rawPath);
		if (!rel || paths.has(rel)) throw Object.assign(new Error("Git tree path set is invalid"), { code: "workspace_manifest_git_parse_error" });
		paths.add(rel);
		parsed.push({ mode, type, oid, rel });
	}
	return parsed;
}

function gitIndexMetadata(repo) {
	const links = new Set();
	const modes = new Map();
	const raw = gitBufferStrict(repo, ["ls-files", "-s", "-z"]);
	for (const entry of raw.toString("utf8").split("\0").filter(Boolean)) {
		const match = entry.match(/^(\d+) ([a-f0-9]+) (\d+)\t([\s\S]+)$/);
		if (!match) throw Object.assign(new Error("Git index output is malformed"), { code: "workspace_manifest_git_parse_error" });
		const rel = normalizeRel(match[4]);
		if (match[1] === "160000") links.add(rel);
		else modes.set(rel, match[1] === "100755" ? 0o755 : match[1] === "120000" ? 0o777 : 0o644);
	}
	return { links, modes };
}
function referenceRepositoryDigest(repo, commit, exclusions) {
	const files = {};
	const raw = gitBufferStrict(repo, ["ls-tree", "-rz", "--full-tree", "-r", commit]);
	for (const { mode, type, oid, rel } of parseGitTree(raw)) {
		if (pathExcluded(rel, exclusions)) continue;
		if (mode === "160000" || type === "commit") {
			const nested = path.join(repo, rel);
			setManifestEntry(files, rel, { type: "gitlink", commit: oid, dirty: false, dirty_digest: fs.existsSync(path.join(nested, ".git")) ? referenceRepositoryDigest(nested, oid, exclusions) : sha256(canonicalJson({ missing: true, commit: oid })) });
			continue;
		}
		const blob = gitBufferStrict(repo, ["cat-file", "blob", oid]);
		if (mode === "120000") setManifestEntry(files, rel, { type: "symlink", mode: 0o777, link: blob.toString("utf8") });
		else setManifestEntry(files, rel, { type: "file", mode: mode === "100755" ? 0o755 : 0o644, size: blob.length, digest: sha256(blob) });
	}
	return sha256(canonicalJson({ head: commit, index_digest: sha256(""), files }));
}

function workspaceRepositoryDigest(repo, exclusions) {
	if (!fs.existsSync(repo)) return sha256(canonicalJson({ missing: true }));
	const files = {};
	const { links: gitlinks, modes: gitModes } = gitIndexMetadata(repo);
	walkEntry(repo, "", exclusions, files, gitlinks, repo, gitModes);
	return sha256(canonicalJson({
		head: gitStrict(repo, ["rev-parse", "HEAD"]),
		index_digest: sha256(gitBufferStrict(repo, ["diff", "--cached", "--binary", "--no-ext-diff"])),
		files,
	}));
}

function referenceManifest(cwd, config = loadConfig(cwd)) {
	if (config.errors && config.errors.length) throw Object.assign(new Error(config.errors.join(", ")), { code: "request_contract_config_invalid", errors: config.errors });
	const files = {};
	const raw = gitBufferStrict(cwd, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
	for (const { mode, type, oid, rel } of parseGitTree(raw)) {
		if (!governedWorkspacePath(cwd, rel, config).ok) continue;
		if (mode === "160000" || type === "commit") {
			const submodule = path.join(cwd, rel);
			setManifestEntry(files, rel, { type: "gitlink", commit: oid, dirty: false, dirty_digest: fs.existsSync(path.join(submodule, ".git")) ? referenceRepositoryDigest(submodule, oid, config.exclusions) : sha256(canonicalJson({ missing: true, commit: oid })) });
			continue;
		}
		const blob = gitBufferStrict(cwd, ["cat-file", "blob", oid]);
		if (mode === "120000") setManifestEntry(files, rel, { type: "symlink", mode: 0o777, link: blob.toString("utf8") });
		else setManifestEntry(files, rel, { type: "file", mode: mode === "100755" ? 0o755 : 0o644, size: blob.length, digest: sha256(blob) });
	}
	const manifest = {
		version: VERSION,
		config_digest: config.digest,
		head: gitStrict(cwd, ["rev-parse", "HEAD"]),
		index_digest: sha256(""),
		submodules_digest: sha256(canonicalJson(Object.entries(files).filter(([, value]) => value.type === "gitlink").map(([rel, value]) => [rel, value.commit]))),
		files,
	};
	return { manifest, digest: sha256(canonicalJson(manifest)) };
}

function workspaceManifest(cwd, config = loadConfig(cwd)) {
	if (config.errors && config.errors.length) throw Object.assign(new Error(config.errors.join(", ")), { code: "request_contract_config_invalid", errors: config.errors });
	const files = {};
	const { links: gitlinks, modes: gitModes } = gitIndexMetadata(cwd);
	for (const root of config.product_roots) {
		if (!root || root === ".") {
			walkEntry(cwd, "", config.exclusions, files, gitlinks, cwd, gitModes);
			continue;
		}
		const rootPath = path.join(cwd, root);
		if (!fs.existsSync(rootPath)) setManifestEntry(files, root, { type: "missing" });
		else walkEntry(rootPath, root, config.exclusions, files, gitlinks, cwd, gitModes);
	}
	const manifest = {
		version: VERSION,
		config_digest: config.digest,
		head: gitStrict(cwd, ["rev-parse", "HEAD"]),
		index_digest: sha256(gitBufferStrict(cwd, ["diff", "--cached", "--binary", "--no-ext-diff"])),
		submodules_digest: sha256(canonicalJson(Object.entries(files).filter(([, value]) => value.type === "gitlink").map(([rel, value]) => [rel, value.commit]))),
		files,
	};
	return { manifest, digest: sha256(canonicalJson(manifest)) };
}

function diffManifests(before, after) {
	const out = [];
	const a = (before && before.files) || {};
	const b = (after && after.files) || {};
	for (const rel of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
		const av = a[rel] || null;
		const bv = b[rel] || null;
		if (canonicalJson(av) === canonicalJson(bv)) continue;
		out.push({ path: rel, kind: av && bv ? "modify" : av ? "delete" : "add", before: av, after: bv });
	}
	for (const field of ["head", "index_digest", "submodules_digest"]) {
		const av = before && before[field];
		const bv = after && after[field];
		if (av !== bv) out.push({ path: `@workspace/${field}`, kind: "metadata", before: av || null, after: bv || null });
	}
	return out;
}

function quarantineRoot(cwd) {
	return path.join(harnessRoot(cwd), "quarantine");
}

function listQuarantine(cwd) {
	const dir = quarantineRoot(cwd);
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => {
				const item = { id: e.name, dir: path.join(dir, e.name), head: readJson(path.join(dir, e.name, "head.json")) };
				if (!item.head || typeof item.head !== "object") item.corrupt = "quarantine_head_corrupt";
				return item;
				});
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw Object.assign(new Error("request-contract quarantine storage cannot be read"), { code: "quarantine_storage_unreadable", cause: error });
	}
}

function quarantineAdoptionProjection(adoption) {
	return {
		version: adoption && adoption.version,
		quarantine_id: adoption && adoption.quarantine_id,
		chain_head: adoption && adoption.chain_head,
		count: adoption && adoption.count,
		source_ids: adoption && adoption.source_ids,
		consumed_by_unit: adoption && adoption.consumed_by_unit,
	};
}

function findQuarantineAdoption(cwd, q, verified) {
	for (const id of listUnits(cwd)) {
		const head = readJson(unitPaths(cwd, id).head);
		for (const adoption of head && head.adopted_quarantines || []) {
			const expected = {
				version: VERSION,
				quarantine_id: q.id,
				chain_head: q.head.chain_head,
				count: q.head.count,
				source_ids: verified.records.map((record) => record.source_id),
				consumed_by_unit: id,
			};
			if (canonicalJson(quarantineAdoptionProjection(adoption)) === canonicalJson(expected) && adoption.consumption_digest === sha256(canonicalJson(expected))) return { adoption, head };
		}
	}
	return null;
}

function listUnconsumedQuarantine(cwd) {
	const unresolved = [];
	for (const q of listQuarantine(cwd)) {
		if (q.corrupt) {
			unresolved.push(q);
			continue;
		}
		const verified = verifyQuarantineChain(q);
		if (!verified.ok) {
			q.corrupt = verified.errors[0] || "quarantine_chain_corrupt";
			unresolved.push(q);
			continue;
		}
		const adoption = findQuarantineAdoption(cwd, q, verified);
		if (q.head.consumed === true) {
			const expectedDigest = adoption && adoption.adoption.consumption_digest;
			if (!adoption || q.head.consumed_by_unit !== adoption.adoption.consumed_by_unit || q.head.consumption_digest !== expectedDigest) {
				q.corrupt = "quarantine_consumption_unbound";
				unresolved.push(q);
			}
			continue;
		}
		if (adoption) {
			q.head.consumed = true;
			q.head.consumed_by_unit = adoption.adoption.consumed_by_unit;
			q.head.consumption_digest = adoption.adoption.consumption_digest;
			q.head.consumed_at = q.head.consumed_at || Date.now();
			secureJson(path.join(q.dir, "head.json"), q.head);
			continue;
		}
		unresolved.push(q);
	}
	return unresolved;
}

function verifyQuarantineChain(q) {
	const errors = [];
	if (!q || q.corrupt || !q.head) return { ok: false, errors: [q && q.corrupt || "quarantine_head_corrupt"], records: [] };
	let records = [];
	try {
		records = readJsonlStrict(path.join(q.dir, "sources.jsonl"), "quarantine_source_corrupt", { allowMissing: true });
	} catch (error) {
		return { ok: false, errors: [error.code], records: [] };
	}
	let prev = ZERO_HASH;
	for (let index = 0; index < records.length; index++) {
		const r = records[index];
		const base = { version: r.version, source_id: r.source_id, seq: r.seq, ts: r.ts, origin: r.origin, prompt_digest: r.prompt_digest, prev_hash: r.prev_hash };
		if (r.seq !== index + 1) errors.push("quarantine_sequence_gap");
		if (r.prev_hash !== prev) errors.push("quarantine_prev_hash_mismatch");
		if (sha256(r.prompt || "") !== r.prompt_digest) errors.push("quarantine_prompt_digest_mismatch");
		if (sha256(canonicalJson(base)) !== r.record_hash) errors.push("quarantine_record_hash_mismatch");
		prev = r.record_hash;
	}
	if (records.length !== q.head.count) errors.push("quarantine_head_count_mismatch");
	if ((records.length ? prev : ZERO_HASH) !== q.head.chain_head) errors.push("quarantine_head_digest_mismatch");
	return { ok: errors.length === 0, errors: [...new Set(errors)], records };
}

function appendQuarantine(cwd, client, sessionId, prompt, now = Date.now(), origin = "ambiguous") {
	return withRepositoryLock(cwd, () => appendQuarantineUnlocked(cwd, client, sessionId, prompt, now, origin), now);
}

function recoverQuarantineHead(q) {
	let records;
	try {
		records = readJsonlStrict(path.join(q.dir, "sources.jsonl"), "quarantine_source_corrupt", { allowMissing: true });
	} catch (error) {
		throw Object.assign(new Error(error.message), { code: error.code });
	}
	let prev = ZERO_HASH;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		const base = { version: record.version, source_id: record.source_id, seq: record.seq, ts: record.ts, origin: record.origin, prompt_digest: record.prompt_digest, prev_hash: record.prev_hash };
		if (record.seq !== index + 1 || record.prev_hash !== prev || sha256(record.prompt || "") !== record.prompt_digest || sha256(canonicalJson(base)) !== record.record_hash) {
			throw Object.assign(new Error("quarantine chain is not recoverable"), { code: "quarantine_chain_corrupt" });
		}
		prev = record.record_hash;
	}
	if (q.head.count > records.length) throw Object.assign(new Error("quarantine head is ahead of its log"), { code: "quarantine_chain_corrupt" });
	if (q.head.count !== records.length || q.head.chain_head !== (records.length ? prev : ZERO_HASH)) {
		q.head.count = records.length;
		q.head.chain_head = records.length ? prev : ZERO_HASH;
		secureJson(path.join(q.dir, "head.json"), q.head);
	}
	return q;
}

function appendQuarantineUnlocked(cwd, client, sessionId, prompt, now = Date.now(), origin = "ambiguous") {
	ensureDir(quarantineRoot(cwd));
	let q = listUnconsumedQuarantine(cwd).find((x) => x.head && x.head.client === client && x.head.session_id === sessionId);
	if (!q) {
		const id = opaqueId();
		const dir = path.join(quarantineRoot(cwd), id);
		ensureDir(dir);
		q = { id, dir, head: { version: VERSION, id, client, session_id: sessionId, count: 0, chain_head: ZERO_HASH, consumed: false } };
		secureJson(path.join(q.dir, "head.json"), q.head, { exclusive: true });
	}
	recoverQuarantineHead(q);
	const seq = q.head.count + 1;
	const sourceId = `SRC-${opaqueId()}`;
	const promptDigest = sha256(prompt);
	const base = { version: VERSION, source_id: sourceId, seq, ts: now, origin: origin === "native_user" ? "native_user" : "ambiguous", prompt_digest: promptDigest, prev_hash: q.head.chain_head };
	const record = { ...base, prompt, record_hash: sha256(canonicalJson(base)) };
	appendJsonl(path.join(q.dir, "sources.jsonl"), record);
	q.head.count = seq;
	q.head.chain_head = record.record_hash;
	secureJson(path.join(q.dir, "head.json"), q.head);
	return { sourceId, quarantineId: q.id };
}

function createGenesis(cwd, client, sessionId, now = Date.now(), opts = {}) {
	return withRepositoryLock(cwd, () => createGenesisUnlocked(cwd, client, sessionId, now, opts), now);
}

function createGenesisUnlocked(cwd, client, sessionId, now = Date.now(), opts = {}) {
	const quarantined = listUnconsumedQuarantine(cwd);
	const corrupt = quarantined.flatMap((q) => verifyQuarantineChain(q).errors);
	if (corrupt.length) throw Object.assign(new Error(corrupt.join(", ")), { code: "quarantine_chain_corrupt", errors: corrupt });
	if (quarantined.length && !opts.adoptQuarantine) throw Object.assign(new Error("unconsumed quarantine chains"), { code: "unconsumed_quarantine" });
	const existing = findUnit(cwd, client, sessionId);
	if (existing) return existing;
	const unresolved = unresolvedUnits(cwd);
	if (unresolved.some((candidate) => candidate.corrupt)) {
		throw Object.assign(new Error("corrupt unresolved request lineage"), { code: "corrupt_unresolved_unit" });
	}
	validateSuccessfulHandoffsBeforeGenesis(cwd);
	const config = loadConfig(cwd);
	if (config.errors.length) throw Object.assign(new Error(config.errors.join(", ")), { code: "request_contract_config_invalid", errors: config.errors });
	const authorityKey = loadAuthorityKey(cwd, config);
	const reviewerKey = loadReviewerKey(cwd, config);
	const reviewRunnerKey = loadReviewRunnerKey(cwd, config);
	const credentialIds = [config.authority.credential_id, config.reviewer.credential_id, config.review_runner.credential_id];
	const keyFingerprints = [authorityKey, reviewerKey, reviewRunnerKey].filter(Boolean).map(publicKeyFingerprint);
	const pinnedExecutables = [config.reviewer.allowed_attestor_digests, config.review_runner.allowed_reviewer_digests, config.review_runner.allowed_sandbox_digests, config.review_runner.allowed_attestor_digests];
	if (!authorityKey || !reviewerKey || !reviewRunnerKey || credentialIds.some((id) => !id) || new Set(credentialIds).size !== credentialIds.length || new Set(keyFingerprints).size !== 3 || pinnedExecutables.some((digests) => !digests.length || digests.some((digest) => !/^[a-f0-9]{64}$/.test(digest)))) {
		throw Object.assign(new Error("governed mode requires three distinct pinned authority, reviewer, and review-runner credentials"), { code: "request_contract_credentials_unprovisioned" });
	}
	const baseline = referenceManifest(cwd, config);
	const genesisWorkspace = workspaceManifest(cwd, config);
	const id = opaqueId();
	const p = unitPaths(cwd, id);
	const stagingUnit = `${p.unit}.creating.${opaqueId()}`;
	const staged = Object.fromEntries(Object.entries(p).map(([key, value]) => [key, typeof value === "string" && value.startsWith(p.unit) ? stagingUnit + value.slice(p.unit.length) : value]));
	ensureDir(staged.unit);
	const initialState = { version: VERSION, baseline: baseline.manifest, baseline_digest: baseline.digest, genesis_workspace_digest: genesisWorkspace.digest, observed_workspace: baseline.manifest, occurrences: [], stop: null };
	const head = {
		version: VERSION,
		unit_id: id,
		client,
		session_id: sessionId,
		session_bindings: [{ client, session_id: sessionId, host_process_ids: [opts.hostProcessId || process.pid], host_process_identities: [opts.hostProcessIdentity || processIdentity(opts.hostProcessId || process.pid)].filter(Boolean) }],
		client_versions: opts.clientVersion ? { [client]: opts.clientVersion } : {},
		created_at: now,
		lifecycle: "active",
		config_digest: config.digest,
		authority_key_fingerprint: authorityKey ? publicKeyFingerprint(authorityKey) : null,
		reviewer_key_fingerprint: publicKeyFingerprint(reviewerKey),
		review_runner_key_fingerprint: publicKeyFingerprint(reviewRunnerKey),
		source_count: 0,
		source_head: ZERO_HASH,
		scope_epoch: 0,
		work_revision: 0,
		contract_digest: null,
		state_digest: stateDigest(initialState),
	};
	secureJson(staged.head, head, { exclusive: true });
	secureJson(staged.state, initialState, { exclusive: true });
	durableRename(staged.unit, p.unit);
	const unit = { id, paths: p, head };
	captureWorkspaceOccurrences(unit, cwd);
	if (opts.adoptQuarantine) adoptQuarantine(unit, cwd, now);
	return unit;
}

function adoptQuarantine(unit, cwd, now = Date.now()) {
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => adoptQuarantineUnlocked(unit, cwd, now), now), now);
}

function adoptQuarantineUnlocked(unit, cwd, now = Date.now()) {
	const bindingHead = requiredJson(unit.paths.head, "unit_head_corrupt");
	const boundSessions = new Set((bindingHead.session_bindings || [{ client: bindingHead.client, session_id: bindingHead.session_id }])
		.map((binding) => `${binding.client}\u0000${binding.session_id}`));
	for (const q of listUnconsumedQuarantine(cwd).sort((a, b) => a.id.localeCompare(b.id))) {
		recoverQuarantineHead(q);
		const verified = verifyQuarantineChain(q);
		if (!verified.ok) throw Object.assign(new Error(verified.errors.join(", ")), { code: "quarantine_chain_corrupt", errors: verified.errors });
		if (q.corrupt) throw Object.assign(new Error(q.corrupt), { code: q.corrupt });
		if (!boundSessions.has(`${q.head.client}\u0000${q.head.session_id}`)) continue;
		const destinationHead = requiredJson(unit.paths.head, "unit_head_corrupt");
		const destinationChain = verifySourceChain(unit.paths, destinationHead);
		if (!destinationChain.ok) throw Object.assign(new Error(destinationChain.errors.join(", ")), { code: "source_log_corrupt", errors: destinationChain.errors });
		const destinationSources = new Map(destinationChain.records.map((record) => [record.source_id, record]));
		for (const record of verified.records) {
			const existing = destinationSources.get(record.source_id);
			if (existing) {
				if (existing.prompt_digest !== record.prompt_digest || existing.prompt !== record.prompt) throw Object.assign(new Error("quarantine source ID collides with different destination content"), { code: "quarantine_adoption_collision" });
				continue;
			}
			const appended = appendSourceUnlocked(unit, record.prompt || "", record.origin || "ambiguous", record.ts || now, { sourceId: record.source_id });
			destinationSources.set(appended.source_id, appended);
		}
		const adoptedHead = requiredJson(unit.paths.head, "unit_head_corrupt");
		const adoption = {
			version: VERSION,
			quarantine_id: q.id,
			chain_head: q.head.chain_head,
			count: q.head.count,
			source_ids: verified.records.map((record) => record.source_id),
			consumed_by_unit: unit.id,
		};
		adoption.consumption_digest = sha256(canonicalJson(quarantineAdoptionProjection(adoption)));
		adoptedHead.adopted_quarantines = adoptedHead.adopted_quarantines || [];
		const priorAdoption = adoptedHead.adopted_quarantines.find((item) => item.quarantine_id === q.id);
		if (priorAdoption && canonicalJson(priorAdoption) !== canonicalJson(adoption)) throw Object.assign(new Error("quarantine adoption binding conflicts with destination head"), { code: "quarantine_adoption_collision" });
		if (!priorAdoption) adoptedHead.adopted_quarantines.push(adoption);
		secureJson(unit.paths.head, adoptedHead);
		q.head.consumed = true;
		q.head.consumed_by_unit = unit.id;
		q.head.consumed_at = now;
		q.head.consumption_digest = adoption.consumption_digest;
		secureJson(path.join(q.dir, "head.json"), q.head);
	}
	return unit;
}

function verifySourceChain(paths, head) {
	let records;
	try {
		records = readJsonlStrict(paths.sources, "source_log_corrupt", { allowMissing: true });
	} catch (error) {
		return { ok: false, errors: [error.code], records: [] };
	}
	const errors = [];
	let prev = ZERO_HASH;
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		const base = { version: r.version, source_id: r.source_id, seq: r.seq, ts: r.ts, origin: r.origin, prompt_digest: r.prompt_digest, prev_hash: r.prev_hash };
		if (r.seq !== i + 1) errors.push("source_sequence_gap");
		if (r.prev_hash !== prev) errors.push("source_prev_hash_mismatch");
		if (sha256(r.prompt || "") !== r.prompt_digest) errors.push("source_prompt_digest_mismatch");
		if (sha256(canonicalJson(base)) !== r.record_hash) errors.push("source_record_hash_mismatch");
		prev = r.record_hash;
	}
	if (records.length !== head.source_count) errors.push("source_head_count_mismatch");
	if ((records.length ? prev : ZERO_HASH) !== head.source_head) errors.push("source_head_digest_mismatch");
	return { ok: errors.length === 0, errors: [...new Set(errors)], records };
}

function appendSource(unit, prompt, origin = "ambiguous", now = Date.now(), opts = {}) {
	return withUnitLock(unit, () => appendSourceUnlocked(unit, prompt, origin, now, opts), now);
}

function appendSourceUnlocked(unit, prompt, origin = "ambiguous", now = Date.now(), opts = {}) {
	assertUnitMutable(unit);
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const existingChain = verifySourceChain(unit.paths, head);
	if (!existingChain.ok) throw Object.assign(new Error(existingChain.errors.join(", ")), { code: "source_log_corrupt", errors: existingChain.errors });
	if (opts.sourceId) {
		const existing = existingChain.records.find((record) => record.source_id === opts.sourceId);
		if (existing) {
			if (existing.prompt_digest !== sha256(prompt)) throw Object.assign(new Error("imported source id conflicts with existing source"), { code: "source_import_conflict" });
			return existing;
		}
	}
	const seq = head.source_count + 1;
	const sourceId = opts.sourceId || `SRC-${opaqueId()}`;
	const base = {
		version: VERSION,
		source_id: sourceId,
		seq,
		ts: now,
		origin: origin || "ambiguous",
		prompt_digest: sha256(prompt),
		prev_hash: head.source_head,
	};
	const record = { ...base, prompt, record_hash: sha256(canonicalJson(base)) };
	const nextHead = { ...head, source_count: seq, source_head: record.record_hash, work_revision: head.work_revision + 1 };
	const transaction = { version: VERSION, kind: "source", created_at: now, expected: { count: head.source_count, chain_head: head.source_head }, record, head: nextHead };
	secureJson(transactionPath(unit, "source"), transaction, { exclusive: true });
	if (opts.afterTransactionPrepared) opts.afterTransactionPrepared(transaction);
	applySourceTransaction(unit, transaction);
	unit.head = nextHead;
	return record;
}

function contractDigest(contract) {
	return sha256(canonicalJson(contract));
}

function directiveScopeProjection(d) {
	return {
		id: d.id,
		statement: d.statement,
		state: TERMINAL_AUTHORITY_OP[d.state] ? d.state : "open",
		source_ids: d.source_ids || [],
		targets: d.targets || [],
		acceptance_criteria: d.acceptance_criteria || [],
	};
}

function scopeProjection(contract) {
	const projection = {
		sources: (contract.sources || []).map((s) => ({ id: s.id, classification: s.classification, source_kind: s.source_kind, derived_from: s.derived_from, derivation_kind: s.derivation_kind, directive_ids: s.directive_ids || [], obligation_atoms: s.obligation_atoms || [] })),
		directives: (contract.directives || []).map(directiveScopeProjection),
		authorities: (contract.authorities || []).map((a) => ({
			id: a.id,
			operation: a.operation,
			source_id: a.source_id,
			source_digest: a.source_digest,
			target_directive_ids: a.target_directive_ids || [],
			affected_source_ids: a.affected_source_ids || [],
			affected_prior_ids: a.affected_prior_ids || [],
			replacement_ids: a.replacement_ids || [],
			tombstone_ids: a.tombstone_ids || [],
			receipt_nonce: a.receipt && a.receipt.nonce,
		})),
		tombstones: contract.tombstones || [],
	};
	if (contract.preservation) projection.preservation = contract.preservation;
	return projection;
}

function directiveDisposedScopeIds(directive, edges = []) {
	const ids = new Set([
		directive.id,
		...(directive.targets || []).map((target) => target.id),
		...(directive.acceptance_criteria || []).map((criterion) => criterion.id),
	]);
	for (const key of TRACE_KEYS) for (const id of (directive.trace && directive.trace[key]) || []) ids.add(id);
	for (const spec of TRACE_EDGES) {
		const fromIds = new Set(spec.from === "directives" ? [directive.id] : (directive.trace && directive.trace[spec.from]) || []);
		const toIds = new Set((directive.trace && directive.trace[spec.to]) || []);
		for (const edge of edges || []) if (edge.kind === spec.kind && fromIds.has(edge.from) && toIds.has(edge.to)) ids.add(edge.id);
	}
	return [...ids].sort();
}

function semanticSubset(prior, next) {
	if (Array.isArray(prior)) {
		if (!Array.isArray(next)) return false;
		return prior.every((item) => {
			if (item && typeof item === "object" && item.id) return next.some((candidate) => candidate && candidate.id === item.id && semanticSubset(item, candidate));
			return next.some((candidate) => canonicalJson(candidate) === canonicalJson(item));
		});
	}
	if (prior && typeof prior === "object") {
		if (!next || typeof next !== "object" || Array.isArray(next)) return false;
		return Object.keys(prior).every((key) => Object.prototype.hasOwnProperty.call(next, key) && semanticSubset(prior[key], next[key]));
	}
	return prior === next;
}

function validateAuthorityReceipt(receipt, publicKeyPem, now = Date.now(), opts = {}) {
	const errors = [];
	closedObject(receipt, ["operation", "nonce", "issued_at", "expires_at", "prior_scope_digest", "resulting_scope_digest", "resulting_scope_epoch", "binding_epoch", "challenge", "presentation_digest", "target_directive_ids", "affected_source_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids", "sign_count", "user_presence", "signature"], errors, "authority_receipt");
	if (!receipt || !AUTH_OPS.has(receipt.operation)) errors.push("authority_operation_invalid");
	if (!receipt || !receipt.user_presence || receipt.user_presence.present !== true) errors.push("authority_user_presence_missing");
	if (!receipt || !receipt.user_presence || receipt.user_presence.non_exportable !== true) errors.push("authority_non_exportable_missing");
	if (!receipt || !receipt.user_presence || !receipt.user_presence.credential_id) errors.push("authority_credential_missing");
	if (!receipt || typeof receipt.nonce !== "string" || receipt.nonce.length < 16 || typeof receipt.signature !== "string" || !receipt.signature) errors.push("authority_signature_missing");
	if (receipt && (!Number.isInteger(receipt.issued_at) || !Number.isInteger(receipt.expires_at) || receipt.expires_at <= receipt.issued_at)) errors.push("authority_time_window_invalid");
	if (!receipt || typeof receipt.challenge !== "string" || receipt.challenge.length < 16 || !/^[a-f0-9]{64}$/.test(receipt.presentation_digest || "")) errors.push("authority_challenge_missing");
	if (!receipt || !Number.isInteger(receipt.sign_count) || receipt.sign_count < 1) errors.push("authority_sign_counter_invalid");
	if (!receipt || !Array.isArray(receipt.target_directive_ids)) errors.push("authority_target_set_missing");
	for (const field of ["target_directive_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids"]) {
		if (!receipt || !Array.isArray(receipt[field])) errors.push(`authority_${field}_missing`);
		else if (new Set(receipt[field]).size !== receipt[field].length || receipt[field].some((id) => !validId(id))) errors.push(`authority_${field}_invalid`);
	}
	if (!receipt || !Array.isArray(receipt.affected_source_ids)) errors.push("authority_affected_source_ids_missing");
	else if (new Set(receipt.affected_source_ids).size !== receipt.affected_source_ids.length || receipt.affected_source_ids.some((id) => !/^SRC-[a-f0-9]{32}$/.test(id))) errors.push("authority_affected_source_ids_invalid");
	if (receipt && receipt.user_presence) {
		closedObject(receipt.user_presence, ["present", "non_exportable", "credential_id", "authenticator_kind"], errors, "authority_user_presence");
		if (!['platform', 'passkey', 'hardware'].includes(receipt.user_presence.authenticator_kind)) errors.push("authority_authenticator_kind_invalid");
	}
	if (opts.checkExpiry !== false && receipt && receipt.expires_at != null && now > receipt.expires_at) errors.push("authority_expired");
	if (receipt && receipt.issued_at != null && receipt.issued_at > now + 60_000) errors.push("authority_issued_in_future");
	if (receipt && receipt.operation !== "authorize_contract") {
		for (const f of ["prior_scope_digest", "resulting_scope_digest", "resulting_scope_epoch", "binding_epoch"]) {
			if (receipt[f] == null) errors.push(`authority_${f}_missing`);
		}
	}
	if (receipt && (!/^[a-f0-9]{64}$/.test(receipt.resulting_scope_digest || "") || !Number.isInteger(receipt.resulting_scope_epoch) || !Number.isInteger(receipt.binding_epoch) || receipt.binding_epoch < 1)) errors.push("authority_scope_binding_invalid");
	if (receipt && receipt.prior_scope_digest != null && !/^[a-f0-9]{64}$/.test(receipt.prior_scope_digest)) errors.push("authority_prior_scope_digest_invalid");
	if (!publicKeyPem) errors.push("authority_public_key_unavailable");
	if (publicKeyPem && receipt && receipt.signature) {
		try {
			const payload = { ...receipt };
			delete payload.signature;
			const ok = crypto.verify(null, Buffer.from(canonicalJson(payload)), publicKeyPem, Buffer.from(receipt.signature, "base64"));
			if (!ok) errors.push("authority_signature_invalid");
		} catch {
			errors.push("authority_signature_invalid");
		}
	}
	return { ok: errors.length === 0, errors };
}

function authorityPresentation(authority, priorScope, nextScope, nextEpoch, nextBindingEpoch) {
	return {
		operation: authority.operation,
		source_id: authority.source_id,
		source_digest: authority.source_digest,
		target_directive_ids: [...(authority.target_directive_ids || [])].sort(),
		affected_source_ids: [...(authority.affected_source_ids || [])].sort(),
		affected_prior_ids: [...(authority.affected_prior_ids || [])].sort(),
		replacement_ids: [...(authority.replacement_ids || [])].sort(),
		tombstone_ids: [...(authority.tombstone_ids || [])].sort(),
		prior_scope_digest: priorScope,
		resulting_scope_digest: nextScope,
		resulting_scope_epoch: nextEpoch,
		binding_epoch: nextBindingEpoch,
	};
}

function issueAuthorityChallenge(unit, cwd, presentation, now = Date.now()) {
	return withUnitLock(unit, () => {
		const presentations = Array.isArray(presentation) ? presentation : [presentation];
		if (!presentations.length || presentations.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw Object.assign(new Error("one or more canonical authority presentations are required"), { code: "authority_presentation_invalid" });
			const terminal = readUnitState(unit).terminal;
		if (terminal && !(terminal.status === "incomplete" && presentations.length === 1 && presentations[0].operation === "resume")) assertUnitMutable(unit);
		const key = loadAuthorityKey(cwd);
		if (!key) throw Object.assign(new Error("authority public key unavailable"), { code: "authority_public_key_unavailable" });
		const presentationDigests = presentations.map((item) => sha256(canonicalJson(item))).sort();
		if (new Set(presentationDigests).size !== presentationDigests.length) throw Object.assign(new Error("authority transaction contains a duplicate presentation"), { code: "authority_presentation_invalid" });
		const bindingEpochs = [...new Set(presentations.map((item) => item.binding_epoch))];
		if (bindingEpochs.length !== 1) throw Object.assign(new Error("authority transaction presentations must share one binding epoch"), { code: "authority_presentation_invalid" });
		const requestDigest = sha256(canonicalJson({ unit_id: unit.id, binding_epoch: bindingEpochs[0], presentation_digests: presentationDigests }));
		ensureDir(unit.paths.pending);
		for (const entry of fs.readdirSync(unit.paths.pending, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.startsWith("authority-") || !entry.name.endsWith(".json")) continue;
			const file = path.join(unit.paths.pending, entry.name);
			const prior = readJson(file);
			if (!prior || prior.consumed || prior.superseded) continue;
			if (prior.request_digest === requestDigest && now <= prior.expires_at) return prior;
			prior.superseded = true;
			prior.superseded_at = now;
			prior.superseded_by_request_digest = requestDigest;
			secureJson(file, prior);
		}
		const challenge = opaqueId("AUT-");
		const pending = {
			version: VERSION,
			challenge,
			issued_at: now,
			expires_at: now + 10 * 60_000,
			presentation_digest: presentations.length === 1 ? presentationDigests[0] : null,
			presentation_digests: presentationDigests,
			request_digest: requestDigest,
			binding_epoch: bindingEpochs[0],
			operation: presentations.length === 1 ? presentations[0].operation : "mixed",
			target_directive_ids: [...new Set(presentations.flatMap((item) => item.target_directive_ids || []))].sort(),
			consumed_presentation_digests: [],
			consumed: false,
		};
		secureJson(path.join(unit.paths.pending, `authority-${challenge}.json`), pending, { exclusive: true });
		return pending;
	}, now);
}

function consumeAuthorityReceipt(unit, authority, presentation, cwd, state, now = Date.now(), opts = {}) {
	const receipt = authority.receipt || {};
	const config = loadConfig(cwd);
	const errors = validateAuthorityReceipt(receipt, loadAuthorityKey(cwd, config), now).errors;
	const expectedDigest = sha256(canonicalJson(presentation));
	if (receipt.presentation_digest !== expectedDigest) errors.push("authority_presentation_digest_mismatch");
	if (canonicalJson([...(receipt.target_directive_ids || [])].sort()) !== canonicalJson(presentation.target_directive_ids)) errors.push("authority_target_set_mismatch");
	for (const field of ["affected_source_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids"]) {
		if (canonicalJson([...(receipt[field] || [])].sort()) !== canonicalJson(presentation[field] || [])) errors.push(`authority_${field}_mismatch`);
	}
	let pending = null;
	let pendingPath = null;
	if (receipt.challenge) {
		pendingPath = path.join(unit.paths.pending, `authority-${receipt.challenge}.json`);
		pending = opts.pendingCache && opts.pendingCache.get(pendingPath) || readJson(pendingPath);
		if (!pending) errors.push("authority_challenge_unknown");
		else {
			if (pending.consumed || (pending.consumed_presentation_digests || []).includes(expectedDigest)) errors.push("authority_challenge_replayed");
			if (pending.superseded) errors.push("authority_challenge_superseded");
			if (now > pending.expires_at) errors.push("authority_challenge_expired");
			if (!(pending.presentation_digests || [pending.presentation_digest]).includes(expectedDigest)) errors.push("authority_challenge_presentation_mismatch");
		}
	}
	const credentialId = receipt.user_presence && receipt.user_presence.credential_id;
	if (config.authority.credential_id && credentialId !== config.authority.credential_id) errors.push("authority_credential_mismatch");
	state.authority_counters = state.authority_counters || {};
	if (credentialId && receipt.sign_count <= (state.authority_counters[credentialId] || 0)) errors.push("authority_sign_counter_rollback");
	state.consumed_authority_nonces = state.consumed_authority_nonces || [];
	if (state.consumed_authority_nonces.includes(receipt.nonce)) errors.push("authority_nonce_replayed");
	if (errors.length) throw Object.assign(new Error(errors.join(", ")), { code: "authority_receipt_invalid", errors });
	pending.consumed_presentation_digests = [...new Set([...(pending.consumed_presentation_digests || []), expectedDigest])].sort();
	pending.authority_ids = [...new Set([...(pending.authority_ids || []), authority.id])].sort();
	pending.consumed = pending.consumed_presentation_digests.length === (pending.presentation_digests || [pending.presentation_digest]).length;
	if (pending.consumed) pending.consumed_at = now;
	state.authority_counters[credentialId] = receipt.sign_count;
	state.consumed_authority_nonces.push(receipt.nonce);
	if (opts.pendingCache) opts.pendingCache.set(pendingPath, pending);
	if (opts.persistPending !== false) secureJson(pendingPath, pending);
	return { pendingPath, pending };
}

function validateContract(contract, sourceRecords = [], occurrences = [], opts = {}) {
	const errors = [];
	const workspaceConfig = opts.cwd ? opts.config || loadConfig(opts.cwd) : null;
	if (!contract || contract.kind !== "request-contract" || ![1, 2].includes(contract.version)) return { ok: false, errors: ["contract_shape_invalid"] };
	const contextOutputV2 = contract.version === 2;
	closedObject(contract, ["kind", "version", "id", "status", "sources", "directives", "artifacts", "edges", "authorities", "tombstones", "changes", "preservation"], errors, "contract");
	if (!contract.id || !Array.isArray(contract.sources) || !Array.isArray(contract.directives) || !contract.artifacts || !Array.isArray(contract.edges)) errors.push("contract_required_field_missing");
	if (!validId(contract.id)) errors.push("contract_id_invalid");
	if (!["draft", "active", "complete", "incomplete"].includes(contract.status)) errors.push("contract_status_invalid");
	for (const field of ["authorities", "tombstones", "changes"]) if (!Array.isArray(contract[field])) errors.push(`contract_${field}_missing`);
	const sourceIds = new Set(sourceRecords.map((s) => s.source_id));
	const sourceRecordMap = new Map(sourceRecords.map((source) => [source.source_id, source]));
	const declaredSources = new Map();
	const obligations = new Map();
	for (const s of contract.sources || []) {
		closedObject(s, ["id", "classification", "source_kind", "derived_from", "derivation_kind", "directive_ids", "obligation_atoms"], errors, "contract_source");
		if (!s.id || declaredSources.has(s.id)) errors.push("contract_source_id_duplicate");
		if (typeof s.id !== "string" || !/^SRC-[a-f0-9]{32}$/.test(s.id)) errors.push("contract_source_id_invalid");
		declaredSources.set(s.id, s);
		if (!CLASSIFICATIONS.has(s.classification)) errors.push("contract_source_classification_invalid");
		if (!Array.isArray(s.directive_ids)) errors.push("contract_source_mapping_missing");
		else if (new Set(s.directive_ids).size !== s.directive_ids.length || s.directive_ids.some((id) => !validId(id))) errors.push("contract_source_mapping_invalid");
		if (!Array.isArray(s.obligation_atoms) || s.obligation_atoms.length === 0) errors.push(`contract_source_obligations_missing:${s.id}`);
		else {
			for (const atom of s.obligation_atoms) {
				closedObject(atom, ["id", "text", "directive_ids", "subject", "effect", "render_policy"], errors, "contract_source_obligation");
				if (!atom || !validId(atom.id) || obligations.has(atom.id)) errors.push(`contract_source_obligation_id_invalid:${s.id}`);
				if (atom && atom.id && !obligations.has(atom.id)) obligations.set(atom.id, { source: s, atom });
				if (!atom || typeof atom.text !== "string" || atom.text.length === 0 || !Array.isArray(atom.directive_ids) || new Set(atom.directive_ids).size !== atom.directive_ids.length || atom.directive_ids.some((id) => !validId(id))) errors.push(`contract_source_obligation_invalid:${s.id}:${atom && atom.id}`);
				if (contextOutputV2 && (!SOURCE_SUBJECTS.has(atom.subject) || !SOURCE_EFFECTS.has(atom.effect) || !RENDER_POLICIES.has(atom.render_policy))) errors.push(`contract_source_render_metadata_invalid:${s.id}:${atom && atom.id}`);
			}
			const sourceRecord = sourceRecordMap.get(s.id);
			if (sourceRecord && s.obligation_atoms.map((atom) => atom.text || "").join("") !== sourceRecord.prompt) errors.push(`contract_source_obligation_coverage_mismatch:${s.id}`);
		}
		if (["directive", "approval", "authority"].includes(s.classification) && (!Array.isArray(s.directive_ids) || s.directive_ids.length === 0)) errors.push(`contract_actionable_source_unmapped:${s.id}`);
		if (contextOutputV2 && !["directive", "approval", "authority"].includes(s.classification)) {
			if ((s.directive_ids || []).length !== 0) errors.push(`contract_nonactionable_source_mapped:${s.id}`);
			for (const atom of s.obligation_atoms || []) if ((atom.directive_ids || []).length !== 0) errors.push(`contract_nonactionable_atom_mapped:${s.id}:${atom.id}`);
		}
	}
	for (const id of sourceIds) if (!declaredSources.has(id)) errors.push(`contract_source_uncovered:${id}`);
	for (const id of declaredSources.keys()) if (!sourceIds.has(id)) errors.push(`contract_source_unknown:${id}`);
	const declaredDirectiveIds = new Set((contract.directives || []).map((directive) => directive && directive.id).filter(Boolean));
	const validateObligationRefs = (refs, context) => {
		if (!Array.isArray(refs) || refs.length === 0) {
			errors.push(`contract_obligation_refs_missing:${context}`);
			return;
		}
		if (new Set(refs).size !== refs.length || refs.some((id) => !validId(id) || !obligations.has(id))) errors.push(`contract_obligation_refs_invalid:${context}`);
	};

	closedObject(contract.artifacts, TRACE_KEYS, errors, "contract_artifacts");
	const artifactMaps = {};
	const artifactIds = new Set();
	for (const category of TRACE_KEYS) {
		artifactMaps[category] = new Map();
		const entries = contract.artifacts && contract.artifacts[category];
		if (!Array.isArray(entries)) {
			errors.push(`contract_artifact_category_missing:${category}`);
			continue;
		}
		for (const artifact of entries) {
			closedObject(artifact, category === "evidence" ? ["id", "statement", "obligation_atom_ids", "kind", "subject_id", "locator", "digest"] : ["id", "statement", "obligation_atom_ids"], errors, `contract_artifact_${category}`);
			if (!artifact || !artifact.id || artifactMaps[category].has(artifact.id) || artifactIds.has(artifact.id) || declaredDirectiveIds.has(artifact.id)) errors.push(`contract_artifact_id_duplicate:${category}`);
			if (!artifact || !validId(artifact.id)) errors.push(`contract_artifact_id_invalid:${category}`);
			if (!artifact || typeof artifact.statement !== "string" || !artifact.statement.trim()) errors.push(`contract_artifact_definition_missing:${category}:${artifact && artifact.id}`);
			validateObligationRefs(artifact && artifact.obligation_atom_ids, `${category}:${artifact && artifact.id}`);
			if (category === "evidence" && (typeof artifact.kind !== "string" || !artifact.kind.trim() || !artifact.subject_id || typeof artifact.locator !== "string" || !artifact.locator.trim() || !/^[a-f0-9]{64}$/.test(artifact.digest || ""))) errors.push(`contract_evidence_definition_missing:${artifact && artifact.id}`);
			if (category === "evidence" && artifact && artifact.locator && workspaceConfig) {
				const location = governedWorkspacePath(opts.cwd, artifact.locator, workspaceConfig, { physical: true });
				if (!location.ok) errors.push(`contract_evidence_locator_${location.reason}:${artifact.id}`);
				else {
					try {
						if (sha256(fs.readFileSync(location.absolute)) !== artifact.digest) errors.push(`contract_evidence_digest_mismatch:${artifact.id}`);
					} catch {
						errors.push(`contract_evidence_unreadable:${artifact.id}`);
					}
				}
			}
			if (artifact && artifact.id) {
				artifactMaps[category].set(artifact.id, artifact);
				artifactIds.add(artifact.id);
			}
		}
	}
	const edgeIds = new Set();
	const edges = Array.isArray(contract.edges) ? contract.edges : [];
	const edgeByKind = new Map(TRACE_EDGES.map((spec) => [spec.kind, []]));
	for (const edge of edges) {
		closedObject(edge, ["id", "kind", "from", "to"], errors, "contract_edge");
		if (!edge || !edge.id || edgeIds.has(edge.id)) errors.push("contract_edge_id_duplicate");
		if (!edge || !validId(edge.id) || !validId(edge.from) || !validId(edge.to)) errors.push("contract_edge_id_invalid");
		if (edge && edge.id) edgeIds.add(edge.id);
		const spec = TRACE_EDGES.find((candidate) => candidate.kind === (edge && edge.kind));
		if (!spec) {
			errors.push(`contract_edge_kind_invalid:${edge && edge.id}`);
			continue;
		}
		if (spec.from === "directives" ? !declaredDirectiveIds.has(edge.from) : !artifactMaps[spec.from].has(edge.from)) errors.push(`contract_edge_from_unknown:${edge.id}`);
		if (!artifactMaps[spec.to].has(edge.to)) errors.push(`contract_edge_to_unknown:${edge.id}`);
		edgeByKind.get(spec.kind).push(edge);
	}
	for (const spec of TRACE_EDGES) if ((edgeByKind.get(spec.kind) || []).length === 0) errors.push(`contract_edge_kind_missing:${spec.kind}`);
	for (const evidence of artifactMaps.evidence.values()) {
		if (!artifactMaps.implementations.has(evidence.subject_id)) errors.push(`contract_evidence_subject_unknown:${evidence.id}`);
		if (!(edgeByKind.get("implementations_to_evidence") || []).some((edge) => edge.from === evidence.subject_id && edge.to === evidence.id)) errors.push(`contract_evidence_subject_edge_missing:${evidence.id}`);
	}

	const directives = new Map();
	const targetIds = new Set();
	const criterionIds = new Set();
	for (const d of contract.directives || []) {
		closedObject(d, ["id", "statement", "state", "source_ids", "targets", "acceptance_criteria", "trace", "authority_id"], errors, "contract_directive");
		if (!d.id || directives.has(d.id)) errors.push("contract_directive_id_duplicate");
		if (!validId(d.id)) errors.push("contract_directive_id_invalid");
		directives.set(d.id, d);
		if (!SCOPE_STATES.has(d.state)) errors.push(`contract_directive_state_invalid:${d.id}`);
		if (typeof d.statement !== "string" || !d.statement.trim() || !Array.isArray(d.source_ids) || d.source_ids.length === 0) errors.push(`contract_directive_definition_missing:${d.id}`);
		if (Array.isArray(d.source_ids) && new Set(d.source_ids).size !== d.source_ids.length) errors.push(`contract_directive_source_duplicate:${d.id}`);
		if (!Array.isArray(d.targets) || !Array.isArray(d.acceptance_criteria)) errors.push(`contract_directive_collections_invalid:${d.id}`);
		for (const sid of d.source_ids || []) if (!sourceIds.has(sid)) errors.push(`contract_directive_source_unknown:${d.id}:${sid}`);
		for (const t of d.targets || []) {
			closedObject(t, ["id", "path", "description", "obligation_atom_ids", "kind", "audience", "exposure", "objective_atom_ids", "content_source_atom_ids"], errors, "contract_target");
			if (!t.id || targetIds.has(t.id)) errors.push("contract_target_id_duplicate");
			if (!validId(t.id) || typeof t.path !== "string" || !t.path.trim()) errors.push(`contract_target_definition_missing:${d.id}`);
			if (t.description != null && typeof t.description !== "string") errors.push(`contract_target_description_invalid:${d.id}:${t.id}`);
			validateObligationRefs(t.obligation_atom_ids, `target:${d.id}:${t.id}`);
			for (const atomId of t.obligation_atom_ids || []) {
				const obligation = obligations.get(atomId);
				if (obligation && !(obligation.atom.directive_ids || []).includes(d.id)) errors.push(`contract_target_obligation_directive_mismatch:${d.id}:${t.id}:${atomId}`);
			}
			if (contextOutputV2) {
				if (!OUTPUT_KINDS.has(t.kind) || !OUTPUT_AUDIENCES.has(t.audience) || !OUTPUT_EXPOSURES.has(t.exposure)) errors.push(`contract_target_output_metadata_invalid:${d.id}:${t.id}`);
				for (const [field, refs] of [["objective", t.objective_atom_ids], ["content_source", t.content_source_atom_ids]]) {
					if (!Array.isArray(refs) || new Set(refs || []).size !== (refs || []).length || (refs || []).some((id) => !obligations.has(id))) errors.push(`contract_target_${field}_refs_invalid:${d.id}:${t.id}`);
				}
				for (const atomId of t.objective_atom_ids || []) {
					const obligation = obligations.get(atomId);
					if (obligation && !(obligation.atom.directive_ids || []).includes(d.id)) errors.push(`contract_target_objective_not_authorized:${d.id}:${t.id}:${atomId}`);
				}
				for (const atomId of t.content_source_atom_ids || []) {
					const obligation = obligations.get(atomId);
					if (!obligation) continue;
					const atom = obligation.atom;
					if (atom.render_policy === "deny") errors.push(`contract_target_content_render_denied:${d.id}:${t.id}:${atomId}`);
					const workflowContext = atom.subject === "agent_workflow" && ["background", "precondition"].includes(atom.effect);
					if (workflowContext && t.kind !== "developer_comment") errors.push(`contract_target_workflow_context_leak:${d.id}:${t.id}:${atomId}`);
					if (workflowContext && t.kind === "developer_comment" && (!["developer", "reviewer"].includes(t.audience) || !["derive", "quote"].includes(atom.render_policy))) errors.push(`contract_target_developer_comment_scope_invalid:${d.id}:${t.id}:${atomId}`);
				}
				if (t.exposure === "product_ui" && t.audience !== "end_user") errors.push(`contract_target_audience_surface_mismatch:${d.id}:${t.id}`);
				if (t.exposure === "external" && !["end_user", "partner", "public"].includes(t.audience)) errors.push(`contract_target_audience_surface_mismatch:${d.id}:${t.id}`);
			}
			targetIds.add(t.id);
			if (workspaceConfig && t.path) {
				const location = governedWorkspacePath(opts.cwd, t.path, workspaceConfig);
				if (!location.ok) errors.push(`contract_target_${location.reason}:${d.id}:${t.id}`);
			}
		}
		for (const a of d.acceptance_criteria || []) {
			closedObject(a, ["id", "statement", "obligation_atom_ids"], errors, "contract_acceptance");
			if (!a.id || criterionIds.has(a.id)) errors.push("contract_acceptance_id_duplicate");
			if (!validId(a.id) || typeof a.statement !== "string" || !a.statement.trim()) errors.push(`contract_acceptance_definition_missing:${d.id}`);
			validateObligationRefs(a.obligation_atom_ids, `acceptance:${d.id}:${a.id}`);
			for (const atomId of a.obligation_atom_ids || []) {
				const obligation = obligations.get(atomId);
				if (obligation && !(obligation.atom.directive_ids || []).includes(d.id)) errors.push(`contract_acceptance_obligation_directive_mismatch:${d.id}:${a.id}:${atomId}`);
			}
			criterionIds.add(a.id);
		}
		if (!Array.isArray(d.targets) || d.targets.length === 0) errors.push(`contract_target_missing:${d.id}`);
		if (!Array.isArray(d.acceptance_criteria) || d.acceptance_criteria.length === 0) errors.push(`contract_acceptance_missing:${d.id}`);
		if (d.trace != null || d.state === "active" || d.state === "done") {
			for (const key of TRACE_KEYS) {
				if (!d.trace || !Array.isArray(d.trace[key]) || d.trace[key].length === 0) errors.push(`contract_trace_missing:${d.id}:${key}`);
					else {
						if (new Set(d.trace[key]).size !== d.trace[key].length) errors.push(`contract_trace_duplicate:${d.id}:${key}`);
						for (const id of d.trace[key]) {
							const artifact = artifactMaps[key].get(id);
							if (!artifact) errors.push(`contract_trace_artifact_unknown:${d.id}:${key}:${id}`);
							else for (const atomId of artifact.obligation_atom_ids || []) {
								const obligation = obligations.get(atomId);
								if (obligation && !(obligation.atom.directive_ids || []).includes(d.id)) errors.push(`contract_artifact_obligation_directive_mismatch:${d.id}:${key}:${id}:${atomId}`);
							}
						}
					}
			}
			if (d.trace != null) closedObject(d.trace, TRACE_KEYS, errors, "contract_trace");
			for (const spec of TRACE_EDGES) {
				const fromIds = new Set(spec.from === "directives" ? [d.id] : (d.trace && d.trace[spec.from]) || []);
				const toIds = new Set((d.trace && d.trace[spec.to]) || []);
				const relevant = (edgeByKind.get(spec.kind) || []).filter((edge) => fromIds.has(edge.from) && toIds.has(edge.to));
				for (const id of fromIds) if (!relevant.some((edge) => edge.from === id)) errors.push(`contract_trace_edge_missing:${d.id}:${spec.kind}:${id}`);
				for (const id of toIds) if (!relevant.some((edge) => edge.to === id)) errors.push(`contract_trace_edge_missing:${d.id}:${spec.kind}:${id}`);
			}
		}
		if (["superseded", "deferred", "abandoned"].includes(d.state) && !d.authority_id) errors.push(`contract_terminal_authority_missing:${d.id}`);
	}
	for (const s of declaredSources.values()) {
		const actionable = ["directive", "approval", "authority"].includes(s.classification);
		const semanticSurfaces = new Map((s.directive_ids || []).filter((did) => directives.has(did)).map((did) => {
			const directive = directives.get(did);
			return [did, [directive.statement, ...(directive.targets || []).map((target) => target.description || ""), ...(directive.acceptance_criteria || []).map((criterion) => criterion.statement || "")].join("\n")];
		}));
		const atomDirectiveIds = [...new Set((s.obligation_atoms || []).flatMap((atom) => atom.directive_ids || []))].sort();
		if (actionable && canonicalJson(atomDirectiveIds) !== canonicalJson([...(s.directive_ids || [])].sort())) errors.push(`contract_source_obligation_mapping_mismatch:${s.id}`);
		for (const atom of s.obligation_atoms || []) {
			if (actionable && (!atom.directive_ids || atom.directive_ids.length === 0)) errors.push(`contract_source_obligation_unmapped:${s.id}:${atom.id}`);
			for (const did of atom.directive_ids || []) {
				if (!(s.directive_ids || []).includes(did)) errors.push(`contract_source_obligation_directive_mismatch:${s.id}:${atom.id}:${did}`);
				else if (!semanticSurfaces.has(did) || !semanticSurfaces.get(did).includes(atom.text)) errors.push(`contract_source_obligation_not_declared:${s.id}:${atom.id}:${did}`);
				const directive = directives.get(did);
				if (!directive) continue;
				if (!(directive.targets || []).some((target) => (target.obligation_atom_ids || []).includes(atom.id))) errors.push(`contract_source_obligation_target_uncovered:${s.id}:${atom.id}:${did}`);
				if (!(directive.acceptance_criteria || []).some((criterion) => (criterion.obligation_atom_ids || []).includes(atom.id))) errors.push(`contract_source_obligation_acceptance_uncovered:${s.id}:${atom.id}:${did}`);
				for (const key of TRACE_KEYS) {
					const coveredArtifacts = ((directive.trace && directive.trace[key]) || []).map((id) => artifactMaps[key].get(id)).filter((artifact) => artifact && (artifact.obligation_atom_ids || []).includes(atom.id));
					if (!coveredArtifacts.length) errors.push(`contract_source_obligation_artifact_uncovered:${s.id}:${atom.id}:${did}:${key}`);
				}
				for (const spec of TRACE_EDGES) {
					const fromIds = spec.from === "directives"
						? [did]
						: ((directive.trace && directive.trace[spec.from]) || []).filter((id) => (artifactMaps[spec.from].get(id)?.obligation_atom_ids || []).includes(atom.id));
					const toIds = ((directive.trace && directive.trace[spec.to]) || []).filter((id) => (artifactMaps[spec.to].get(id)?.obligation_atom_ids || []).includes(atom.id));
					const relevant = (edgeByKind.get(spec.kind) || []).filter((edge) => fromIds.includes(edge.from) && toIds.includes(edge.to));
					if (!fromIds.length || !toIds.length || !relevant.length) errors.push(`contract_source_obligation_edge_uncovered:${s.id}:${atom.id}:${did}:${spec.kind}`);
					for (const id of fromIds) if (!relevant.some((edge) => edge.from === id)) errors.push(`contract_source_obligation_edge_from_uncovered:${s.id}:${atom.id}:${did}:${spec.kind}:${id}`);
					for (const id of toIds) if (!relevant.some((edge) => edge.to === id)) errors.push(`contract_source_obligation_edge_to_uncovered:${s.id}:${atom.id}:${did}:${spec.kind}:${id}`);
				}
			}
		}
		for (const did of s.directive_ids || []) {
			if (!directives.has(did)) errors.push(`contract_source_directive_unknown:${s.id}:${did}`);
			else if (!(directives.get(did).source_ids || []).includes(s.id)) errors.push(`contract_source_mapping_not_reciprocal:${s.id}:${did}`);
		}
	}
	for (const d of directives.values()) {
		for (const sid of d.source_ids || []) if (declaredSources.has(sid) && !(declaredSources.get(sid).directive_ids || []).includes(d.id)) errors.push(`contract_directive_mapping_not_reciprocal:${d.id}:${sid}`);
	}

	const authIds = new Set();
	const authorities = new Map();
	for (const a of contract.authorities || []) {
		closedObject(a, ["id", "operation", "source_id", "source_digest", "target_directive_ids", "affected_source_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids", "receipt"], errors, "contract_authority");
		if (!a.id || authIds.has(a.id)) errors.push("contract_authority_id_duplicate");
		if (!validId(a.id)) errors.push("contract_authority_id_invalid");
		authIds.add(a.id);
		authorities.set(a.id, a);
		if (!AUTH_OPS.has(a.operation)) errors.push(`contract_authority_operation_invalid:${a.id}`);
		if (typeof a.source_id !== "string" || !/^SRC-[a-f0-9]{32}$/.test(a.source_id) || !declaredSources.has(a.source_id)) errors.push(`contract_authority_source_invalid:${a.id}`);
		if (!/^[a-f0-9]{64}$/.test(a.source_digest || "") || !sourceRecordMap.has(a.source_id) || sourceRecordMap.get(a.source_id).prompt_digest !== a.source_digest) errors.push(`contract_authority_source_digest_invalid:${a.id}`);
		if (!sourceRecordMap.has(a.source_id) || sourceRecordMap.get(a.source_id).origin !== "native_user") errors.push(`contract_authority_source_origin_invalid:${a.id}`);
		for (const field of ["target_directive_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids"]) {
			if (!Array.isArray(a[field])) errors.push(`contract_authority_${field}_missing:${a.id}`);
			else if (new Set(a[field]).size !== a[field].length || a[field].some((id) => !validId(id))) errors.push(`contract_authority_${field}_invalid:${a.id}`);
		}
		if (!Array.isArray(a.affected_source_ids)) errors.push(`contract_authority_affected_source_ids_missing:${a.id}`);
		else if (new Set(a.affected_source_ids).size !== a.affected_source_ids.length || a.affected_source_ids.some((id) => !/^SRC-[a-f0-9]{32}$/.test(id) || !declaredSources.has(id))) errors.push(`contract_authority_affected_source_ids_invalid:${a.id}`);
		for (const directiveId of a.target_directive_ids || []) if (!directives.has(directiveId)) errors.push(`contract_authority_target_unknown:${a.id}:${directiveId}`);
		if (declaredSources.has(a.source_id)) for (const directiveId of a.target_directive_ids || []) if (!(declaredSources.get(a.source_id).directive_ids || []).includes(directiveId)) errors.push(`contract_authority_source_target_mismatch:${a.id}:${directiveId}`);
		if (a.receipt && a.receipt.operation !== a.operation) errors.push(`contract_authority_wrapper_operation_mismatch:${a.id}`);
		if (a.receipt && canonicalJson([...(a.receipt.target_directive_ids || [])].sort()) !== canonicalJson([...(a.target_directive_ids || [])].sort())) errors.push(`contract_authority_wrapper_target_mismatch:${a.id}`);
		for (const field of ["affected_source_ids", "affected_prior_ids", "replacement_ids", "tombstone_ids"]) {
			if (a.receipt && canonicalJson([...(a.receipt[field] || [])].sort()) !== canonicalJson([...(a[field] || [])].sort())) errors.push(`contract_authority_wrapper_${field}_mismatch:${a.id}`);
		}
		if (!a.receipt) errors.push(`contract_authority_receipt_missing:${a.id}`);
		else {
			const ar = validateAuthorityReceipt(a.receipt, opts.publicKeyPem, opts.now, { checkExpiry: false });
			for (const e of ar.errors) errors.push(`${e}:${a.id}`);
		}
	}
	for (const d of directives.values()) if (d.authority_id && !authIds.has(d.authority_id)) errors.push(`contract_authority_unknown:${d.id}`);
	const tombstones = new Map();
	const tombstoneIds = new Set();
	for (const tombstone of contract.tombstones || []) {
		closedObject(tombstone, ["id", "directive_id", "state", "authority_id", "disposed_scope_ids", "statement"], errors, "contract_tombstone");
		if (!tombstone || !validId(tombstone.id) || tombstoneIds.has(tombstone.id) || !tombstone.directive_id || tombstones.has(tombstone.directive_id)) errors.push("contract_tombstone_duplicate");
		else tombstones.set(tombstone.directive_id, tombstone);
		if (tombstone && validId(tombstone.id)) tombstoneIds.add(tombstone.id);
		if (!tombstone || !validId(tombstone.directive_id) || !validId(tombstone.authority_id) || !["superseded", "deferred", "abandoned"].includes(tombstone.state) || !Array.isArray(tombstone.disposed_scope_ids) || new Set(tombstone.disposed_scope_ids || []).size !== (tombstone.disposed_scope_ids || []).length || (tombstone.disposed_scope_ids || []).some((id) => !validId(id)) || typeof tombstone.statement !== "string" || !tombstone.statement.trim()) errors.push("contract_tombstone_definition_invalid");
	}
	for (const d of directives.values()) {
		if (!["superseded", "deferred", "abandoned"].includes(d.state)) continue;
		const authority = authorities.get(d.authority_id);
		const tombstone = tombstones.get(d.id);
		if (!tombstone) errors.push(`contract_tombstone_missing:${d.id}`);
		else if (tombstone.state !== d.state || tombstone.authority_id !== d.authority_id || !tombstone.statement) errors.push(`contract_tombstone_mismatch:${d.id}`);
		if (tombstone) {
			const expectedDisposed = directiveDisposedScopeIds(d, contract.edges || []);
			if (canonicalJson([...(tombstone.disposed_scope_ids || [])].sort()) !== canonicalJson(expectedDisposed)) errors.push(`contract_tombstone_scope_mismatch:${d.id}`);
		}
		if (!authority || authority.operation !== TERMINAL_AUTHORITY_OP[d.state] || !(authority.target_directive_ids || []).includes(d.id)) errors.push(`contract_terminal_authority_mismatch:${d.id}`);
	}
	for (const directiveId of tombstones.keys()) if (!directives.has(directiveId)) errors.push(`contract_tombstone_directive_unknown:${directiveId}`);

	if (!(contract.authorities || []).some((a) => a.operation === "authorize_contract")) errors.push("contract_initial_authority_missing");

	const occurrenceIds = new Set(occurrences.map((o) => o.id));
	const mapped = new Set();
	const implementationIds = new Set();
	const evidenceIds = new Set();
	for (const d of directives.values()) {
		for (const id of (d.trace && d.trace.implementations) || []) implementationIds.add(id);
		for (const id of (d.trace && d.trace.evidence) || []) evidenceIds.add(id);
	}
	for (const c of contract.changes || []) {
		closedObject(c, ["id", "directive_id", "implementation_id", "evidence_id"], errors, "contract_change");
		if (!c.id || mapped.has(c.id)) errors.push("contract_change_duplicate");
		if (typeof c.id !== "string" || !/^CHG-[a-f0-9]{32}$/.test(c.id)) errors.push("contract_change_id_invalid");
		if (!validId(c.directive_id) || !validId(c.implementation_id) || !validId(c.evidence_id)) errors.push("contract_change_reference_invalid");
		mapped.add(c.id);
		if (!occurrenceIds.has(c.id)) errors.push(`contract_change_unknown:${c.id}`);
		const directive = directives.get(c.directive_id);
		if (!directive || !c.implementation_id || !c.evidence_id) errors.push(`contract_change_trace_missing:${c.id}`);
		if (c.implementation_id && !implementationIds.has(c.implementation_id)) errors.push(`contract_change_implementation_unknown:${c.id}`);
		if (c.evidence_id && !evidenceIds.has(c.evidence_id)) errors.push(`contract_change_evidence_unknown:${c.id}`);
		if (directive && (!(directive.trace && directive.trace.implementations || []).includes(c.implementation_id) || !(directive.trace && directive.trace.evidence || []).includes(c.evidence_id))) errors.push(`contract_change_cross_directive:${c.id}`);
		const evidence = artifactMaps.evidence.get(c.evidence_id);
		if (evidence && evidence.subject_id !== c.implementation_id) errors.push(`contract_change_evidence_subject_mismatch:${c.id}`);
	}
	for (const id of occurrenceIds) if (!mapped.has(id)) errors.push(`contract_change_uncovered:${id}`);
	const preservation = preservationPolicy.validateDeclaration(contract, {
		config: workspaceConfig,
		sourceRecords,
		probeRunner: opts.cwd && workspaceConfig ? preservationRunnerContext(opts.cwd, workspaceConfig, opts.env || process.env) : opts.probeRunner,
	});
	if (!preservation.ok) errors.push(...preservation.errors);
	return {
		ok: errors.length === 0,
		errors: [...new Set(errors)],
		ids: {
			sourceIds: [...sourceIds],
				sourceMappings: [...declaredSources.values()].map((s) => canonicalJson({ source_id: s.id, classification: s.classification, source_kind: s.source_kind, derived_from: s.derived_from, derivation_kind: s.derivation_kind, directive_ids: s.directive_ids || [], obligation_atoms: (s.obligation_atoms || []).map((atom) => ({ id: atom.id, subject: atom.subject, effect: atom.effect, render_policy: atom.render_policy, directive_ids: atom.directive_ids || [] })) })),
			directiveIds: [...directives.keys()],
			targetIds: [...targetIds],
			criterionIds: [...criterionIds],
			authorityIds: [...authIds],
			authorityMappings: [...authorities.values()].map((a) => canonicalJson({ authority_id: a.id, operation: a.operation, source_id: a.source_id, target_directive_ids: a.target_directive_ids || [], affected_source_ids: a.affected_source_ids || [], affected_prior_ids: a.affected_prior_ids || [], replacement_ids: a.replacement_ids || [], tombstone_ids: a.tombstone_ids || [] })),
			tombstoneIds: [...tombstones.values()].map((tombstone) => tombstone.id),
			tombstoneMappings: [...tombstones.values()].map((tombstone) => canonicalJson({ tombstone_id: tombstone.id, directive_id: tombstone.directive_id, state: tombstone.state, authority_id: tombstone.authority_id, disposed_scope_ids: tombstone.disposed_scope_ids || [] })),
			artifactIds: [...artifactIds],
			edgeIds: [...edgeIds],
			occurrenceIds: [...occurrenceIds],
			changeMappings: (contract.changes || []).map((change) => canonicalJson({ change_id: change.id, directive_id: change.directive_id, implementation_id: change.implementation_id, evidence_id: change.evidence_id })),
		},
		scope_digest: sha256(canonicalJson(scopeProjection(contract))),
	};
}

function bindContract(unit, contract, opts = {}) {
	return withUnitLock(unit, () => bindContractUnlocked(unit, contract, opts));
}

function bindContractUnlocked(unit, contract, opts = {}) {
	assertUnitMutable(unit);
	const cwd = opts.cwd || path.resolve(unit.paths.unit, "../../../..");
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const config = loadConfig(cwd);
	if (config.digest !== head.config_digest) throw Object.assign(new Error("request-contract configuration differs from genesis pin"), { code: "request_contract_config_drift" });
	const authorityKey = loadAuthorityKey(cwd, config);
	if (!authorityKey || !head.authority_key_fingerprint || publicKeyFingerprint(authorityKey) !== head.authority_key_fingerprint) {
		throw Object.assign(new Error("authority key differs from genesis pin"), { code: "authority_key_pin_mismatch" });
	}
	const existing = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
	const storedContract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
	const verifiedScope = verifyScopeHistory(unit);
	if (!verifiedScope.ok) throw Object.assign(new Error(verifiedScope.errors.join(", ")), { code: "scope_history_corrupt", errors: verifiedScope.errors });
	let priorContract = null;
	if (existing) {
		const latestScope = verifiedScope.records.at(-1);
		if (!storedContract || !latestScope || latestScope.contract_digest !== contractDigest(storedContract) || head.contract_digest !== latestScope.contract_digest) throw Object.assign(new Error("stored contract differs from the last verified scope record"), { code: "contract_state_drift" });
		priorContract = latestScope.contract;
	} else if (storedContract || verifiedScope.records.length) {
		throw Object.assign(new Error("unbound contract or scope history already exists"), { code: "contract_state_drift" });
	}
	if (existing && existing.contract_id !== contract.id && existing.state === "active") throw Object.assign(new Error("active binding conflict"), { code: "binding_conflict" });
	const sources = verifySourceChain(unit.paths, head);
	const state = readUnitState(unit, head);
	const validation = validateContract(contract, sources.records, state.occurrences, { ...opts, publicKeyPem: authorityKey, cwd, config });
	if (!validation.ok) throw Object.assign(new Error(validation.errors.join(", ")), { code: "contract_invalid", errors: validation.errors });
	const priorScope = priorContract ? sha256(canonicalJson(scopeProjection(priorContract))) : null;
	const nextScope = validation.scope_digest;
	const nextEpoch = priorContract && priorScope !== nextScope ? head.scope_epoch + 1 : head.scope_epoch;
	const nextBindingEpoch = existing ? existing.binding_epoch + (priorContract && contractDigest(priorContract) !== contractDigest(contract) ? 1 : 0) : 1;
	const priorAuthorityMap = new Map(((priorContract && priorContract.authorities) || []).map((authority) => [authority.id, authority]));
	const nextAuthorityMap = new Map((contract.authorities || []).map((authority) => [authority.id, authority]));
	for (const [id, authority] of priorAuthorityMap) {
		if (!nextAuthorityMap.has(id)) throw Object.assign(new Error("scope authority history cannot disappear"), { code: "scope_authority_removed" });
		if (canonicalJson(authority) !== canonicalJson(nextAuthorityMap.get(id))) throw Object.assign(new Error("scope authority history is immutable; append a new authority"), { code: "scope_authority_history_mutated" });
	}
	const newAuthorities = (contract.authorities || []).filter((authority) => !priorAuthorityMap.has(authority.id));
	const priorDirectiveMap = new Map(((priorContract && priorContract.directives) || []).map((directive) => [directive.id, directive]));
	const nextDirectiveMap = new Map((contract.directives || []).map((directive) => [directive.id, directive]));
	const addedDirectiveIds = [...nextDirectiveMap.keys()].filter((id) => !priorDirectiveMap.has(id));
	for (const id of priorDirectiveMap.keys()) if (!nextDirectiveMap.has(id)) throw Object.assign(new Error("directives must transition to a retained terminal record, not disappear"), { code: "scope_directive_removed" });
	for (const [id, directive] of priorDirectiveMap) {
		if (TERMINAL_AUTHORITY_OP[directive.state] && canonicalJson(nextDirectiveMap.get(id)) !== canonicalJson(directive)) {
			throw Object.assign(new Error("a disposed directive record is canonically immutable; append a new disposition record"), { code: "scope_terminal_directive_immutable" });
		}
	}
	const changedDirectiveIds = [...priorDirectiveMap].filter(([id, directive]) => nextDirectiveMap.has(id) && canonicalJson(directiveScopeProjection(directive)) !== canonicalJson(directiveScopeProjection(nextDirectiveMap.get(id)))).map(([id]) => id);
	const additiveChangedDirectiveIds = changedDirectiveIds.filter((id) => {
		const prior = priorDirectiveMap.get(id);
		const next = nextDirectiveMap.get(id);
		const priorTargetIds = new Set((prior.targets || []).map((target) => target.id));
		const priorCriterionIds = new Set((prior.acceptance_criteria || []).map((criterion) => criterion.id));
		const addsScopedEntity = (next.targets || []).some((target) => !priorTargetIds.has(target.id)) || (next.acceptance_criteria || []).some((criterion) => !priorCriterionIds.has(criterion.id));
		return addsScopedEntity && semanticSubset(directiveScopeProjection(prior), directiveScopeProjection(next));
	});
	const addedTargetIds = changedDirectiveIds.flatMap((id) => {
		const priorIds = new Set((priorDirectiveMap.get(id).targets || []).map((target) => target.id));
		return (nextDirectiveMap.get(id).targets || []).filter((target) => !priorIds.has(target.id)).map((target) => target.id);
	});
	const addedCriterionIds = changedDirectiveIds.flatMap((id) => {
		const priorIds = new Set((priorDirectiveMap.get(id).acceptance_criteria || []).map((criterion) => criterion.id));
		return (nextDirectiveMap.get(id).acceptance_criteria || []).filter((criterion) => !priorIds.has(criterion.id)).map((criterion) => criterion.id);
	});
	const removedTargetIds = [...priorDirectiveMap].flatMap(([id, directive]) => {
		const nextIds = new Set((nextDirectiveMap.get(id).targets || []).map((target) => target.id));
		return (directive.targets || []).filter((target) => !nextIds.has(target.id)).map((target) => target.id);
	});
	const removedCriterionIds = [...priorDirectiveMap].flatMap(([id, directive]) => {
		const nextIds = new Set((nextDirectiveMap.get(id).acceptance_criteria || []).map((criterion) => criterion.id));
		return (directive.acceptance_criteria || []).filter((criterion) => !nextIds.has(criterion.id)).map((criterion) => criterion.id);
	});
	if (removedTargetIds.length || removedCriterionIds.length) throw Object.assign(new Error("target or acceptance-criterion removal must retain and terminally tombstone the prior directive, then add a replacement directive"), { code: "scope_child_removed" });
	const priorSourceMap = new Map(((priorContract && priorContract.sources) || []).map((source) => [source.id, source]));
	const nextSourceMap = new Map((contract.sources || []).map((source) => [source.id, source]));
	for (const id of priorSourceMap.keys()) if (!nextSourceMap.has(id)) throw Object.assign(new Error("classified sources cannot disappear from scope"), { code: "scope_source_removed" });
	const changedSourceIds = [...priorSourceMap].filter(([id, source]) => nextSourceMap.has(id) && canonicalJson(source) !== canonicalJson(nextSourceMap.get(id))).map(([id]) => id);
	const priorTombstoneMap = new Map(((priorContract && priorContract.tombstones) || []).map((tombstone) => [tombstone.id, tombstone]));
	const nextTombstoneMap = new Map((contract.tombstones || []).map((tombstone) => [tombstone.id, tombstone]));
	for (const id of priorTombstoneMap.keys()) if (!nextTombstoneMap.has(id)) throw Object.assign(new Error("scope tombstones cannot disappear"), { code: "scope_tombstone_removed" });
	const changedTombstones = [...nextTombstoneMap].filter(([id, tombstone]) => !priorTombstoneMap.has(id) || canonicalJson(priorTombstoneMap.get(id)) !== canonicalJson(tombstone));
	const modifiedTombstones = changedTombstones.filter(([id]) => priorTombstoneMap.has(id));
	if (modifiedTombstones.length) throw Object.assign(new Error("a terminal tombstone record is canonically immutable; append a new disposition record"), { code: "scope_tombstone_identity_mutated" });
	const replacementOwner = new Map(addedDirectiveIds.map((id) => [id, id]));
	for (const id of changedDirectiveIds) {
		const priorTargetIds = new Set((priorDirectiveMap.get(id).targets || []).map((target) => target.id));
		const priorCriterionIds = new Set((priorDirectiveMap.get(id).acceptance_criteria || []).map((criterion) => criterion.id));
		for (const target of nextDirectiveMap.get(id).targets || []) if (!priorTargetIds.has(target.id)) replacementOwner.set(target.id, id);
		for (const criterion of nextDirectiveMap.get(id).acceptance_criteria || []) if (!priorCriterionIds.has(criterion.id)) replacementOwner.set(criterion.id, id);
	}
	const exactSet = (actual, expected) => canonicalJson([...(actual || [])].sort()) === canonicalJson([...expected].sort());
	if (!priorContract) {
		if (newAuthorities.length !== 1 || newAuthorities[0].operation !== "authorize_contract") throw Object.assign(new Error("initial scope requires exactly one authorize_contract authority"), { code: "initial_authority_missing" });
		const authority = newAuthorities[0];
		const initialIds = [...nextDirectiveMap.keys()];
		if (!exactSet(authority.target_directive_ids, initialIds) || !exactSet(authority.replacement_ids, initialIds) || !exactSet(authority.affected_source_ids, []) || !exactSet(authority.affected_prior_ids, []) || !exactSet(authority.tombstone_ids, [])) throw Object.assign(new Error("initial authority metadata must exactly own the initial directive set"), { code: "initial_authority_target_mismatch" });
	} else {
		if (newAuthorities.some((authority) => authority.operation === "authorize_contract")) throw Object.assign(new Error("authorize_contract is valid only for genesis scope"), { code: "authority_operation_metadata_mismatch" });
		const additionIds = [...addedDirectiveIds, ...addedTargetIds, ...addedCriterionIds];
		const terminalTargetIds = [...new Set([...changedDirectiveIds.filter((id) => TERMINAL_AUTHORITY_OP[nextDirectiveMap.get(id).state]), ...modifiedTombstones.map(([, tombstone]) => tombstone.directive_id)])];
		const replacementChangeIds = changedDirectiveIds.filter((id) => !additiveChangedDirectiveIds.includes(id) && !terminalTargetIds.includes(id));
		const coveredAdditions = new Set();
		const coveredReplacementChanges = new Set();
		const coveredSources = new Set();
		const coveredTerminalTargets = new Set();
		const coveredTombstones = new Set();
		const operationTargets = new Set();
		for (const authority of newAuthorities) {
			const targets = [...(authority.target_directive_ids || [])];
			if (!targets.length) throw Object.assign(new Error(`authority ${authority.id} has no exact target`), { code: "authority_operation_metadata_mismatch" });
			const targetSet = new Set(targets);
			for (const target of targets) {
				const key = `${authority.operation}:${target}`;
				if (operationTargets.has(key)) throw Object.assign(new Error(`authority operation target is owned more than once: ${key}`), { code: "authority_operation_metadata_mismatch" });
				operationTargets.add(key);
			}
			if (authority.operation === "amend_scope_add") {
				const owned = additionIds.filter((id) => replacementOwner.has(id) && targetSet.has(replacementOwner.get(id)));
				const expectedTargets = [...new Set(owned.map((id) => replacementOwner.get(id)))];
				const expectedAffected = expectedTargets.filter((id) => priorDirectiveMap.has(id));
				if (!owned.length || !exactSet(targets, expectedTargets) || !exactSet(authority.replacement_ids, owned) || !exactSet(authority.affected_prior_ids, expectedAffected) || !exactSet(authority.affected_source_ids, []) || !exactSet(authority.tombstone_ids, [])) throw Object.assign(new Error(`additive authority ${authority.id} does not exactly own its additions`), { code: "authority_operation_metadata_mismatch" });
				for (const id of owned) coveredAdditions.add(id);
				continue;
			}
			if (authority.operation === "amend_scope_replace") {
				if (targets.some((id) => !priorDirectiveMap.has(id) || terminalTargetIds.includes(id)) || !exactSet(authority.affected_prior_ids, targets) || !exactSet(authority.replacement_ids, []) || !exactSet(authority.tombstone_ids, [])) throw Object.assign(new Error(`replacement authority ${authority.id} does not exactly own its prior targets`), { code: "authority_operation_metadata_mismatch" });
				for (const sourceId of authority.affected_source_ids || []) {
					const source = nextSourceMap.get(sourceId) || priorSourceMap.get(sourceId);
					const mapped = source && source.directive_ids || [];
					if (!changedSourceIds.includes(sourceId) || (mapped.length && !mapped.some((id) => targetSet.has(id)))) throw Object.assign(new Error(`replacement authority ${authority.id} owns an unrelated source`), { code: "authority_operation_metadata_mismatch" });
					coveredSources.add(sourceId);
				}
				for (const target of targets) {
					const sourceContribution = (authority.affected_source_ids || []).some((sourceId) => {
						const source = nextSourceMap.get(sourceId) || priorSourceMap.get(sourceId);
						const mapped = source && source.directive_ids || [];
						return !mapped.length || mapped.includes(target);
					});
					if (!replacementChangeIds.includes(target) && !sourceContribution) throw Object.assign(new Error(`replacement authority ${authority.id} target has no replacement delta`), { code: "authority_operation_metadata_mismatch" });
					if (replacementChangeIds.includes(target)) coveredReplacementChanges.add(target);
				}
				continue;
			}
			if (["supersede", "defer", "abandon"].includes(authority.operation)) {
				const expectedTombstones = changedTombstones.filter(([, tombstone]) => targetSet.has(tombstone.directive_id) && TERMINAL_AUTHORITY_OP[tombstone.state] === authority.operation).map(([id]) => id);
				if (!expectedTombstones.length || targets.some((id) => !terminalTargetIds.includes(id) || TERMINAL_AUTHORITY_OP[nextDirectiveMap.get(id).state] !== authority.operation) || !exactSet(authority.affected_prior_ids, targets) || !exactSet(authority.affected_source_ids, []) || !exactSet(authority.tombstone_ids, expectedTombstones)) throw Object.assign(new Error(`terminal authority ${authority.id} does not exactly own its dispositions`), { code: "authority_operation_metadata_mismatch" });
				if (authority.operation === "supersede") {
					if ((authority.replacement_ids || []).some((id) => !addedDirectiveIds.includes(id))) throw Object.assign(new Error("supersede replacements must be newly added directive IDs"), { code: "authority_operation_metadata_mismatch" });
					for (const id of authority.replacement_ids || []) coveredAdditions.add(id);
				} else if (!exactSet(authority.replacement_ids, [])) throw Object.assign(new Error("defer/abandon cannot carry replacement IDs"), { code: "authority_operation_metadata_mismatch" });
				for (const id of targets) coveredTerminalTargets.add(id);
				for (const id of expectedTombstones) coveredTombstones.add(id);
				continue;
			}
			throw Object.assign(new Error(`unsupported scope authority operation: ${authority.operation}`), { code: "authority_operation_metadata_mismatch" });
		}
		for (const [name, actual, expected] of [
			["replacement_ids", [...coveredAdditions], additionIds],
			["affected_prior_ids", [...coveredReplacementChanges], replacementChangeIds],
			["affected_source_ids", [...coveredSources], changedSourceIds],
			["terminal_targets", [...coveredTerminalTargets], terminalTargetIds],
			["tombstone_ids", [...coveredTombstones], changedTombstones.map(([id]) => id)],
		]) if (!exactSet(actual, expected)) throw Object.assign(new Error(`authority ${name} do not exactly match scope delta`), { code: `authority_${name}_mismatch` });
	}
	for (const authority of newAuthorities) {
		const receipt = authority.receipt || {};
		if (priorContract && priorSourceMap.has(authority.source_id)) throw Object.assign(new Error("scope authority must cite an exact later source"), { code: "authority_source_not_later" });
		if (receipt.resulting_scope_digest !== nextScope) throw Object.assign(new Error("authority resulting scope mismatch"), { code: "authority_resulting_scope_mismatch" });
		if (receipt.resulting_scope_epoch !== nextEpoch) throw Object.assign(new Error("authority scope epoch mismatch"), { code: "authority_scope_epoch_mismatch" });
		if (receipt.binding_epoch !== nextBindingEpoch) throw Object.assign(new Error("authority binding epoch mismatch"), { code: "authority_binding_epoch_mismatch" });
		if (priorContract && receipt.prior_scope_digest !== priorScope) throw Object.assign(new Error("authority prior scope mismatch"), { code: "authority_prior_scope_mismatch" });
	}
	if (priorContract && priorScope !== nextScope) {
		head.scope_epoch += 1;
	}
	const nextState = JSON.parse(JSON.stringify(state));
	const pendingCache = new Map();
	for (const authority of newAuthorities) {
		const presentation = authorityPresentation(authority, priorScope, nextScope, nextEpoch, nextBindingEpoch);
		consumeAuthorityReceipt(unit, authority, presentation, cwd, nextState, opts.now || Date.now(), { persistPending: false, pendingCache });
	}
	const digest = contractDigest(contract);
	const binding = existing ? JSON.parse(JSON.stringify(existing)) : { version: VERSION, contract_id: contract.id, binding_epoch: 1, state: "active" };
	if (priorContract && contractDigest(priorContract) !== digest) binding.binding_epoch += 1;
	const scopePlan = planScopeVersion(unit, contract, { scope_epoch: head.scope_epoch, binding_epoch: binding.binding_epoch });
	const nextHead = { ...head, contract_digest: digest, work_revision: head.work_revision + 1, state_digest: stateDigest(nextState) };
	binding.planning_work_revision = nextHead.work_revision;
	binding.planning_digest = sha256(canonicalJson({
		source_head: nextHead.source_head,
		contract_digest: digest,
		config_digest: nextHead.config_digest,
		scope_epoch: nextHead.scope_epoch,
		binding_epoch: binding.binding_epoch,
		baseline_digest: sha256(canonicalJson(nextState.baseline)),
		surface_inventory_digest: contract.preservation && contract.preservation.inventory && contract.preservation.inventory.surface_inventory_digest || null,
	}));
	const transaction = {
		version: VERSION,
		kind: "bind",
		created_at: opts.now || Date.now(),
		expected_scope: { count: scopePlan.prior.count, chain_head: scopePlan.prior.chain_head },
		scope_record: scopePlan.record,
		scope_head: scopePlan.head,
		contract,
		binding,
		head: nextHead,
		state: nextState,
		pending_updates: [...pendingCache].map(([pendingPath, pending]) => ({ name: path.basename(pendingPath), value: pending })),
	};
	secureJson(transactionPath(unit, "bind"), transaction, { exclusive: true });
	if (opts.afterTransactionPrepared) opts.afterTransactionPrepared(transaction);
	applyBindTransaction(unit, transaction);
	unit.head = nextHead;
	return { digest, binding };
}

function planScopeVersion(unit, contract, epochs) {
	const scopeHead = optionalJson(unit.paths.scopeHead, { version: VERSION, count: 0, chain_head: ZERO_HASH }, "scope_head_corrupt");
	const payload = {
		version: VERSION,
		scope_version_id: `SCP-${opaqueId()}`,
		seq: scopeHead.count + 1,
		prev_hash: scopeHead.chain_head,
		contract_digest: contractDigest(contract),
		scope_digest: sha256(canonicalJson(scopeProjection(contract))),
		scope_epoch: epochs.scope_epoch,
		binding_epoch: epochs.binding_epoch,
		contract,
	};
	const record = { ...payload, record_hash: sha256(canonicalJson(payload)) };
	return { prior: scopeHead, record, head: { ...scopeHead, count: record.seq, chain_head: record.record_hash } };

}

function appendScopeVersion(unit, contract, epochs) {
	const plan = planScopeVersion(unit, contract, epochs);
	appendJsonl(unit.paths.scopeHistory, plan.record);
	secureJson(unit.paths.scopeHead, plan.head);
	return plan.record;
}

function verifyScopeHistory(unit) {
	let records;
	try {
		records = readJsonlStrict(unit.paths.scopeHistory, "scope_history_corrupt", { allowMissing: true });
	} catch (error) {
		return { ok: false, errors: [error.code], records: [], head: null };
	}
	const head = optionalJson(unit.paths.scopeHead, { count: 0, chain_head: ZERO_HASH }, "scope_head_corrupt");
	const errors = [];
	let prev = ZERO_HASH;
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		const payload = { ...r };
		delete payload.record_hash;
		if (r.seq !== i + 1 || r.prev_hash !== prev) errors.push("scope_history_sequence_invalid");
		if (!/^SCP-[a-f0-9]{32}$/.test(r.scope_version_id || "") || records.slice(0, i).some((prior) => prior.scope_version_id === r.scope_version_id)) errors.push("scope_history_version_id_invalid");
		if (contractDigest(r.contract) !== r.contract_digest) errors.push("scope_history_contract_digest_invalid");
		if (sha256(canonicalJson(scopeProjection(r.contract))) !== r.scope_digest) errors.push("scope_history_scope_digest_invalid");
		if (sha256(canonicalJson(payload)) !== r.record_hash) errors.push("scope_history_record_hash_invalid");
		prev = r.record_hash;
	}
	if (records.length !== head.count || (records.length ? prev : ZERO_HASH) !== head.chain_head) errors.push("scope_history_head_mismatch");
	return { ok: errors.length === 0, errors: [...new Set(errors)], records, head };
}

function scopeHistoryCoverage(records) {
	const scopeVersionIds = [];
	const scopeVersionMappings = [];
	for (const record of records || []) {
		const contract = record.contract || {};
		scopeVersionIds.push(record.scope_version_id);
		scopeVersionMappings.push(canonicalJson({
			scope_version_id: record.scope_version_id,
			// The reviewer attests the complete opaque relationship graph. Exact text,
			// paths, locators, and digests stay inside the signed private bundle.
			contract: contractCoverageProjection(contract),
		}));
	}
	return { scopeVersionIds, scopeVersionMappings };
}

function contractCoverageProjection(contract) {
	const directives = contract.directives || [];
	const artifacts = contract.artifacts || {};
	const projection = {
		sources: (contract.sources || []).map((source) => ({ source_id: source.id, classification: source.classification, source_kind: source.source_kind, derived_from: source.derived_from, derivation_kind: source.derivation_kind, directive_ids: source.directive_ids || [], obligation_atoms: (source.obligation_atoms || []).map((atom) => ({ id: atom.id, subject: atom.subject, effect: atom.effect, render_policy: atom.render_policy, directive_ids: atom.directive_ids || [] })) })),
		directives: directives.map((directive) => ({
			directive_id: directive.id,
			state: directive.state,
			source_ids: directive.source_ids || [],
			obligation_atom_ids: directive.obligation_atom_ids || [],
			target_ids: (directive.targets || []).map((target) => target.id),
			criterion_ids: (directive.acceptance_criteria || []).map((criterion) => criterion.id),
			trace: Object.fromEntries(TRACE_KEYS.map((key) => [key, (directive.trace && directive.trace[key]) || []])),
		})),
		targets: directives.flatMap((directive) => (directive.targets || []).map((target) => ({ target_id: target.id, directive_id: directive.id, obligation_atom_ids: target.obligation_atom_ids || [], kind: target.kind, audience: target.audience, exposure: target.exposure, objective_atom_ids: target.objective_atom_ids || [], content_source_atom_ids: target.content_source_atom_ids || [] }))),
		criteria: directives.flatMap((directive) => (directive.acceptance_criteria || []).map((criterion) => ({ criterion_id: criterion.id, directive_id: directive.id, obligation_atom_ids: criterion.obligation_atom_ids || [] }))),
		artifacts: TRACE_KEYS.flatMap((kind) => (artifacts[kind] || []).map((artifact) => ({ kind, artifact_id: artifact.id, subject_id: artifact.subject_id, obligation_atom_ids: artifact.obligation_atom_ids || [] }))),
		edges: (contract.edges || []).map((edge) => ({ edge_id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, obligation_atom_ids: edge.obligation_atom_ids || [] })),
		authorities: (contract.authorities || []).map((authority) => ({ authority_id: authority.id, operation: authority.operation, source_id: authority.source_id, target_directive_ids: authority.target_directive_ids || [], affected_source_ids: authority.affected_source_ids || [], affected_prior_ids: authority.affected_prior_ids || [], replacement_ids: authority.replacement_ids || [], tombstone_ids: authority.tombstone_ids || [] })),
		tombstones: (contract.tombstones || []).map((tombstone) => ({ tombstone_id: tombstone.id, directive_id: tombstone.directive_id, state: tombstone.state, authority_id: tombstone.authority_id, disposed_scope_ids: tombstone.disposed_scope_ids || [] })),
		changes: (contract.changes || []).map((change) => ({ change_id: change.id, directive_id: change.directive_id, implementation_id: change.implementation_id, evidence_id: change.evidence_id })),
	};
	if (contract.preservation) projection.preservation = contract.preservation;
	return projection;
}

function contractCoverageIds(contract, occurrences = []) {
	const projection = contractCoverageProjection(contract || {});
	return {
		sourceIds: projection.sources.map((item) => item.source_id),
		sourceMappings: projection.sources.map((item) => canonicalJson(item)),
		directiveIds: projection.directives.map((item) => item.directive_id),
		targetIds: projection.targets.map((item) => item.target_id),
		criterionIds: projection.criteria.map((item) => item.criterion_id),
		authorityIds: projection.authorities.map((item) => item.authority_id),
		authorityMappings: projection.authorities.map((item) => canonicalJson(item)),
		tombstoneIds: projection.tombstones.map((item) => item.tombstone_id),
		tombstoneMappings: projection.tombstones.map((item) => canonicalJson(item)),
		artifactIds: projection.artifacts.map((item) => item.artifact_id),
		edgeIds: projection.edges.map((item) => item.edge_id),
		occurrenceIds: (occurrences || []).map((item) => item.id),
		changeMappings: projection.changes.map((item) => canonicalJson(item)),
	};
}

function collectReviewMaterials(cwd, contract, state, workspace) {
	const requested = new Set();
	for (const directive of contract.directives || []) for (const target of directive.targets || []) if (target.path) requested.add(normalizeRel(target.path));
	for (const evidence of ((contract.artifacts && contract.artifacts.evidence) || [])) if (evidence.locator) requested.add(normalizeRel(evidence.locator));
	for (const surface of ((contract.preservation && contract.preservation.surfaces) || [])) {
		for (const rel of [...(surface.baseline_paths || []), ...(surface.current_paths || [])]) requested.add(normalizeRel(rel));
	}
	for (const occurrence of state.occurrences || []) {
		const rel = occurrence.detail && (occurrence.detail.path || occurrence.detail.target);
		if (rel && !path.isAbsolute(rel)) requested.add(normalizeRel(rel));
	}
	const selected = Object.keys(workspace.manifest.files).filter((rel) => [...requested].some((target) => rel === target || rel.startsWith(target + "/")));
	return selected.sort().map((rel) => {
		const metadata = workspace.manifest.files[rel];
		const material = { path: rel, metadata };
		if (metadata.type === "file") {
			const bytes = fs.readFileSync(path.join(cwd, rel));
			if (sha256(bytes) !== metadata.digest || bytes.length !== metadata.size) throw Object.assign(new Error(`review material changed while snapshotting: ${rel}`), { code: "review_bundle_workspace_race" });
			material.content_base64 = bytes.toString("base64");
		}
		return material;
	});
}

function collectBaselineReviewMaterials(cwd, contract, state, currentManifest) {
	const baseline = state.baseline;
	if (!baseline || !baseline.head || !baseline.files) throw Object.assign(new Error("review bundle has no pinned baseline manifest"), { code: "review_bundle_baseline_missing" });
	const requested = new Set();
	for (const surface of ((contract.preservation && contract.preservation.surfaces) || [])) for (const rel of surface.baseline_paths || []) requested.add(normalizeRel(rel));
	for (const occurrence of state.occurrences || []) {
		const rel = occurrence.detail && (occurrence.detail.path || occurrence.detail.target);
		if (rel && !path.isAbsolute(rel)) requested.add(normalizeRel(rel));
	}
	const selected = Object.keys(baseline.files).filter((rel) => {
		const requestedPath = [...requested].some((target) => rel === target || rel.startsWith(target + "/"));
		const changed = canonicalJson(baseline.files[rel]) !== canonicalJson(currentManifest.files[rel] || null);
		return requestedPath || changed;
	});
	return selected.sort().map((rel) => {
		const metadata = baseline.files[rel];
		const material = { path: rel, metadata };
		if (metadata.type === "file") {
			const bytes = gitBufferStrict(cwd, ["show", `${baseline.head}:${rel}`]);
			if (sha256(bytes) !== metadata.digest || bytes.length !== metadata.size) throw Object.assign(new Error(`baseline review material does not match its manifest: ${rel}`), { code: "review_bundle_baseline_digest_mismatch" });
			material.content_base64 = bytes.toString("base64");
		}
		return material;
	});
}

function buildReviewBundle(unit, cwd, opts = {}) {
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const sourceChain = verifySourceChain(unit.paths, head);
	const contract = requiredJson(unit.paths.contract, "contract_state_corrupt");
	const binding = requiredJson(unit.paths.binding, "binding_state_corrupt");
	const state = readUnitState(unit, head);
	const workspace = workspaceManifest(cwd, loadConfig(cwd));
	if (opts.afterWorkspaceSnapshot) opts.afterWorkspaceSnapshot(workspace);
	const scopeHistory = verifyScopeHistory(unit);
	if (!sourceChain.ok) throw Object.assign(new Error(sourceChain.errors.join(", ")), { code: "source_log_corrupt", errors: sourceChain.errors });
	if (!scopeHistory.ok) throw Object.assign(new Error(scopeHistory.errors.join(", ")), { code: "scope_history_corrupt", errors: scopeHistory.errors });
	const materials = collectReviewMaterials(cwd, contract, state, workspace);
	const baselineMaterials = collectBaselineReviewMaterials(cwd, contract, state, workspace.manifest);
	const preservationSurfaceMappings = Object.entries(Object.fromEntries(((contract.preservation && contract.preservation.surfaces) || []).map((surface) =>
		[surface.id, preservationPolicy.surfaceDiffDigest(state.baseline, workspace.manifest, surface)])))
		.sort(([a], [b]) => a.localeCompare(b)).map(([id, digest]) => `${id}:${digest}`);
	const confirmedWorkspace = workspaceManifest(cwd, loadConfig(cwd));
	if (confirmedWorkspace.digest !== workspace.digest) throw Object.assign(new Error("workspace changed while building the review bundle"), { code: "review_bundle_workspace_race" });
	const fullBundle = {
		version: VERSION,
		unit_id: unit.id,
		sources: sourceChain.records.map((r) => ({ source_id: r.source_id, seq: r.seq, origin: r.origin, prompt: r.prompt })),
		contract,
		scope_history: scopeHistory.records,
		binding,
		occurrences: state.occurrences,
		workspace_manifest: workspace.manifest,
		baseline_manifest: state.baseline,
		materials,
		baseline_materials: baselineMaterials,
		review_coverage: { ...contractCoverageIds(contract, state.occurrences), ...scopeHistoryCoverage(scopeHistory.records), preservationSurfaceMappings },
		required_review_roles: loadConfig(cwd).reviewer.required_roles,
		workspace_digest: workspace.digest,
		config_digest: head.config_digest,
		source_head: head.source_head,
		contract_digest: head.contract_digest,
		scope_epoch: head.scope_epoch,
		work_revision: head.work_revision,
		expected_delivery_state: expectedDeliveryState(loadConfig(cwd), contract),
	};
	const fullDigest = sha256(canonicalJson(fullBundle));
	const bundle = opts.stage && opts.role ? buildReviewEvidenceView(fullBundle, opts.stage, opts.role, fullDigest) : fullBundle;
	return { bundle, digest: sha256(canonicalJson(bundle)), full_digest: fullDigest, workspace };
}

function effectiveReviewRoles(config, contract = null) {
	const configured = [...new Set((config.reviewer && config.reviewer.required_roles) || [])];
	if (config.preservation && config.preservation.required || contract && contract.preservation) return [...new Set([...PRESERVATION_REVIEW_ROLES, ...configured])];
	return configured;
}

/** Preservation cannot become release-eligible before the pending signed controls exist. */
function expectedDeliveryState(config, contract = null) {
	return config.preservation && config.preservation.required || contract && contract.preservation ? "REVIEW_ONLY" : "RELEASE_ELIGIBLE";
}

function requiredReviewSlots(config, contract = null) {
	const roles = effectiveReviewRoles(config, contract);
	if (!roles.length) return [{ stage: "integration", role: "general" }];
	const stages = config.preservation && config.preservation.required || contract && contract.preservation ? PRESERVATION_REVIEW_STAGES : ["integration"];
	return stages.flatMap((stage) => roles.map((role) => ({ stage, role })));
}

function planningSeal(unit, config, binding, head, contract = null) {
	const roles = effectiveReviewRoles(config, contract);
	if (!(config.preservation && config.preservation.required || contract && contract.preservation) || !roles.length) return { ok: true, digest: null, records: [] };
	const chain = verifyReviewChain(unit.paths);
	if (!chain.ok) return { ok: false, digest: null, records: [], errors: chain.errors };
	const relevant = [];
	for (const record of chain.records) {
		if (record.review_stage !== "planning" || !roles.includes(record.role)) continue;
		if (record.source_head !== head.source_head || record.contract_digest !== head.contract_digest || record.config_digest !== head.config_digest || record.scope_epoch !== head.scope_epoch || record.binding_epoch !== binding.binding_epoch) continue;
		if (record.planning_digest !== binding.planning_digest || record.work_revision !== binding.planning_work_revision) continue;
		relevant.push(record);
	}
	const minimum = config.minimum_clean_rounds;
	const expectedRoles = Array.from({ length: minimum }, () => roles).flat();
	const records = relevant.slice(-expectedRoles.length);
	if (records.length !== expectedRoles.length || records.some((record, index) => record.verdict !== "CLEAN" || record.role !== expectedRoles[index])) {
		return { ok: false, digest: null, records: [], errors: ["review_planning_stage_incomplete"] };
	}
	return { ok: true, digest: sha256(canonicalJson(records.map((record) => ({ role: record.role, record_hash: record.record_hash })))), records };
}

function buildReviewEvidenceView(full, stage, role, fullDigest = sha256(canonicalJson(full))) {
	if (!PRESERVATION_REVIEW_STAGES.includes(stage)) throw Object.assign(new Error(`unsupported review stage: ${stage}`), { code: "review_stage_invalid" });
	const roles = new Set(["source_fidelity", "baseline_preservation", "implementation_test", "authority_release", "general"]);
	if (!roles.has(role)) throw Object.assign(new Error(`unsupported review role: ${role}`), { code: "review_role_invalid" });
	const contract = full.contract || {};
	const common = {
		version: full.version,
		unit_id: full.unit_id,
		review_stage: stage,
		review_role: role,
		first_verdict_withheld: true,
		full_bundle_digest: fullDigest,
		review_coverage: full.review_coverage,
		config_digest: full.config_digest,
		source_head: full.source_head,
		contract_digest: full.contract_digest,
		scope_epoch: full.scope_epoch,
		work_revision: full.work_revision,
		expected_delivery_state: full.expected_delivery_state,
	};
	let evidence;
	if (role === "source_fidelity") evidence = {
		sources: full.sources,
		contract: { id: contract.id, status: contract.status, sources: contract.sources, directives: contract.directives, authorities: contract.authorities, tombstones: contract.tombstones },
		scope_history: full.scope_history,
		binding: full.binding,
	};
	else if (role === "baseline_preservation") evidence = {
		preservation: contract.preservation,
		baseline_manifest: full.baseline_manifest,
		workspace_manifest: stage === "integration" ? full.workspace_manifest : undefined,
		baseline_materials: full.baseline_materials,
		materials: stage === "integration" ? full.materials : undefined,
	};
	else if (role === "implementation_test") evidence = {
		contract: { id: contract.id, status: contract.status, directives: contract.directives, artifacts: contract.artifacts, edges: contract.edges, changes: contract.changes },
		occurrences: stage === "integration" ? full.occurrences : [],
		workspace_manifest: stage === "integration" ? full.workspace_manifest : undefined,
		materials: stage === "integration" ? full.materials : undefined,
	};
	else if (role === "authority_release") evidence = {
		contract: { id: contract.id, status: contract.status, authorities: contract.authorities, tombstones: contract.tombstones, preservation: contract.preservation },
		scope_history: full.scope_history,
		binding: full.binding,
		workspace_manifest: stage === "integration" ? full.workspace_manifest : undefined,
	};
	else evidence = full;
	const includedSections = Object.keys(evidence).filter((key) => evidence[key] !== undefined).sort();
	const allSections = ["sources", "contract", "scope_history", "binding", "occurrences", "workspace_manifest", "baseline_manifest", "materials", "baseline_materials", "preservation"];
	return {
		...common,
		included_sections: includedSections,
		withheld_sections: allSections.filter((key) => !includedSections.includes(key)),
		evidence,
	};
}

function reviewSignaturePayload(review) {
	const payload = JSON.parse(JSON.stringify(review));
	if (payload.executor) delete payload.executor.signature;
	delete payload.isolation;
	for (const key of ["version", "seq", "prev_hash", "record_hash"]) delete payload[key];
	return payload;
}

function isolationSignaturePayload(isolation) {
	const payload = JSON.parse(JSON.stringify(isolation || {}));
	delete payload.signature;
	return payload;
}

function reviewInvocationProjection(invocation) {
	const fields = ["version", "nonce", "review_run_id", "review_stage", "required_role", "expected_delivery_state", "planning_digest", "planning_seal_digest", "issued_at", "expires_at", "bundle_digest", "full_bundle_digest", "evidence_view_digest", "writer_session_id", "writer_session_ids", "writer_process_ids", "writer_process_identities", "source_head", "contract_digest", "workspace_digest", "config_digest", "scope_epoch", "work_revision", "binding_epoch", "ids"];
	return Object.fromEntries(fields.map((field) => [field, invocation && invocation[field]]));
}

function reviewInvocationDigestValid(invocation) {
	return Boolean(invocation && /^[a-f0-9]{64}$/.test(invocation.invocation_digest || "") && invocation.invocation_digest === sha256(canonicalJson(reviewInvocationProjection(invocation))));
}

function cleanupExpiredReviewInvocations(unit, now = Date.now()) {
	const cleaned = [];
	const retainedBundles = new Set();
	try {
		for (const entry of fs.readdirSync(unit.paths.pending, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.startsWith("review-") || !entry.name.endsWith(".json")) continue;
			const file = path.join(unit.paths.pending, entry.name);
			const invocation = readJson(file);
			const nonce = entry.name.slice("review-".length, -".json".length);
			const derivedBundle = path.join(unit.paths.pending, `bundle-${nonce}.json`);
				if (!invocation) {
					durableUnlink(derivedBundle);
					continue;
				}
				if (!reviewInvocationDigestValid(invocation)) {
					durableUnlink(derivedBundle);
					continue;
				}
			if (invocation.private_bundle_path && path.resolve(invocation.private_bundle_path) !== path.resolve(derivedBundle)) {
				durableUnlink(derivedBundle);
				continue;
			}
			if (!invocation.consumed && !invocation.expired && now <= invocation.expires_at) {
				retainedBundles.add(path.resolve(derivedBundle));
				continue;
			}
			if (invocation.consumed || invocation.expired) {
				durableUnlink(derivedBundle);
				continue;
			}
			durableUnlink(derivedBundle);
			invocation.expired = true;
			invocation.expired_at = now;
			delete invocation.private_bundle_path;
			secureJson(file, invocation);
			cleaned.push(invocation.nonce);
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	try {
		for (const entry of fs.readdirSync(unit.paths.pending, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.startsWith("bundle-") || !entry.name.endsWith(".json")) continue;
			const file = path.resolve(unit.paths.pending, entry.name);
			if (!retainedBundles.has(file)) durableUnlink(file);
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return cleaned;
}

function issueReviewInvocation(unit, cwd, writerSessionId, now = Date.now()) {
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => {
		assertUnitMutable(unit);
		cleanupExpiredReviewInvocations(unit, now);
			const head = requiredJson(unit.paths.head, "unit_head_corrupt");
			const config = loadConfig(cwd);
			if (config.digest !== head.config_digest) throw Object.assign(new Error("request-contract configuration differs from genesis pin"), { code: "request_contract_config_drift" });
			const state = readUnitState(unit, head);
			if (state.active_mutations && Object.keys(state.active_mutations).length) throw Object.assign(new Error("review cannot start while a governed mutation is in flight"), { code: "review_mutation_in_flight" });
		const reviewerKey = loadReviewerKey(cwd, config);
		const runnerKey = loadReviewRunnerKey(cwd, config);
		if (!reviewerKey || publicKeyFingerprint(reviewerKey) !== head.reviewer_key_fingerprint) throw Object.assign(new Error("reviewer key differs from genesis pin"), { code: "reviewer_key_pin_mismatch" });
		if (!runnerKey || publicKeyFingerprint(runnerKey) !== head.review_runner_key_fingerprint) throw Object.assign(new Error("review runner key differs from genesis pin"), { code: "review_runner_key_pin_mismatch" });
		const writerSessionIds = [...new Set((head.session_bindings || [{ session_id: head.session_id }]).map((binding) => binding.session_id))];
		const writerProcessIds = [...new Set((head.session_bindings || []).flatMap((binding) => binding.host_process_ids || []))].sort((a, b) => a - b);
		const writerProcessIdentities = [...new Set((head.session_bindings || []).flatMap((binding) => binding.host_process_identities || []))].sort();
		if (!writerSessionIds.includes(writerSessionId)) throw Object.assign(new Error("writer session is not bound to this request lineage"), { code: "review_writer_session_unbound" });
		const binding = requiredJson(unit.paths.binding, "binding_state_corrupt");
		const contract = requiredJson(unit.paths.contract, "contract_state_corrupt");
		const sources = verifySourceChain(unit.paths, head);
		const cv = validateContract(contract, sources.records, state.occurrences, { publicKeyPem: loadAuthorityKey(cwd), now, cwd });
		if (!cv.ok) throw Object.assign(new Error(cv.errors.join(", ")), { code: "review_contract_invalid", errors: cv.errors });
		const nonce = opaqueId("REV-");
		const reviewRunId = opaqueId("RUN-");
		const reviewChain = verifyReviewChain(unit.paths);
		if (!reviewChain.ok) throw Object.assign(new Error(reviewChain.errors.join(", ")), { code: "review_log_corrupt" });
		const currentWorkspace = workspaceManifest(cwd, config);
		const effectiveRoles = effectiveReviewRoles(config, contract);
		const preservationReview = Boolean(config.preservation.required || contract.preservation);
		const slots = requiredReviewSlots(config, contract);
		const currentRecords = reviewChain.records.filter((record) => {
			const stable = record.source_head === head.source_head && record.contract_digest === head.contract_digest && record.config_digest === head.config_digest && record.scope_epoch === head.scope_epoch && record.binding_epoch === binding.binding_epoch;
			if (!stable) return false;
			return record.review_stage === "planning" || (record.workspace_digest === currentWorkspace.digest && record.work_revision === head.work_revision);
		});
		const currentCleanRecords = [];
		for (const stage of [...new Set(slots.map((slot) => slot.stage))]) {
			const records = currentRecords.filter((record) => record.review_stage === stage);
			let lastNonClean = -1;
			for (let index = 0; index < records.length; index++) if (records[index].verdict !== "CLEAN") lastNonClean = index;
			currentCleanRecords.push(...records.slice(lastNonClean + 1).filter((record) => record.verdict === "CLEAN"));
		}
		const coveredSlots = new Map();
		for (const record of currentCleanRecords) {
			const key = `${record.review_stage}:${record.role}`;
			coveredSlots.set(key, (coveredSlots.get(key) || 0) + 1);
		}
		let requiredSlot = null;
		for (const stage of [...new Set(slots.map((slot) => slot.stage))]) {
			for (let round = 0; round < config.minimum_clean_rounds && !requiredSlot; round++) {
				requiredSlot = slots.find((slot) => slot.stage === stage && (coveredSlots.get(`${slot.stage}:${slot.role}`) || 0) <= round);
			}
			if (requiredSlot) break;
		}
		if (!requiredSlot && !preservationReview && currentCleanRecords.length < config.minimum_clean_rounds) requiredSlot = slots[currentCleanRecords.length % slots.length];
		if (!requiredSlot) throw Object.assign(new Error("all required review slots already have current CLEAN records"), { code: "review_slots_complete" });
		if (requiredSlot.stage === "planning") {
			const baselineChanged = diffManifests(state.baseline, currentWorkspace.manifest).length > 0;
			if (head.work_revision !== binding.planning_work_revision || baselineChanged) throw Object.assign(new Error("planning review must be sealed before the first implementation mutation"), { code: "review_planning_window_closed" });
		}
		const currentPlanningSeal = planningSeal(unit, config, binding, head, contract);
		if (requiredSlot.stage === "integration") {
			const planningRoles = new Set(currentCleanRecords.filter((record) => record.review_stage === "planning").map((record) => record.role));
			if (preservationReview && effectiveRoles.some((role) => !planningRoles.has(role))) throw Object.assign(new Error("integration review cannot begin before every planning role has a CLEAN first verdict"), { code: "review_planning_stage_incomplete" });
			if (!currentPlanningSeal.ok) throw Object.assign(new Error("integration review requires the current planning seal"), { code: "review_planning_stage_incomplete" });
		}
		const bundle = requiredSlot.role === "general" && !effectiveRoles.length
			? buildReviewBundle(unit, cwd)
			: buildReviewBundle(unit, cwd, { stage: requiredSlot.stage, role: requiredSlot.role });
		const requiredRole = requiredSlot.role;
		const bundlePath = path.join(unit.paths.pending, `bundle-${nonce}.json`);
			const manifest = {
			version: VERSION,
				nonce,
			review_run_id: reviewRunId,
			review_stage: requiredSlot.stage,
			required_role: requiredRole,
			expected_delivery_state: expectedDeliveryState(config, contract),
			planning_digest: binding.planning_digest,
			planning_seal_digest: requiredSlot.stage === "integration" ? currentPlanningSeal.digest : null,
			issued_at: now,
			expires_at: now + 10 * 60_000,
			bundle_digest: bundle.digest,
			full_bundle_digest: bundle.full_digest,
			evidence_view_digest: bundle.digest,
			writer_session_id: writerSessionId || "unknown-writer",
			writer_session_ids: writerSessionIds,
			writer_process_ids: writerProcessIds,
			writer_process_identities: writerProcessIdentities,
			source_head: head.source_head,
			contract_digest: head.contract_digest,
			workspace_digest: bundle.workspace.digest,
			config_digest: head.config_digest,
			scope_epoch: head.scope_epoch,
			work_revision: head.work_revision,
			binding_epoch: binding && binding.binding_epoch,
			ids: { ...cv.ids, ...scopeHistoryCoverage(verifyScopeHistory(unit).records), preservationSurfaceMappings: bundle.bundle.review_coverage.preservationSurfaceMappings },
			consumed: false,
				private_bundle_path: bundlePath,
			};
			manifest.invocation_digest = sha256(canonicalJson(reviewInvocationProjection(manifest)));
			secureJson(path.join(unit.paths.pending, `review-${nonce}.json`), manifest, { exclusive: true });
			claimGlobalId(cwd, "review-invocation", nonce, { unit_id: unit.id, invocation_digest: manifest.invocation_digest });
			secureWrite(bundlePath, canonicalJson(bundle.bundle), { exclusive: true });
		const publicManifest = { ...manifest, bundle_locator: normalizeRel(path.relative(cwd, bundlePath)) };
		delete publicManifest.private_bundle_path;
		delete publicManifest.writer_session_id;
		delete publicManifest.writer_session_ids;
		delete publicManifest.writer_process_ids;
		delete publicManifest.writer_process_identities;
		delete publicManifest.ids;
		return { manifest: publicManifest, bundle };
	}, now), now);
}

function observeOccurrence(unit, detail, now = Date.now()) {
	return withUnitLock(unit, () => observeOccurrenceUnlocked(unit, detail, now), now);
}

function observeOccurrenceUnlocked(unit, detail, now = Date.now()) {
	assertUnitMutable(unit);
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const state = readUnitState(unit, head);
	const signature = sha256(canonicalJson(detail));
	const occurrence = { id: `CHG-${opaqueId()}`, ts: now, signature, detail };
	state.occurrences.push(occurrence);
	head.work_revision += 1;
	writeUnitState(unit, state, head);
	return occurrence;
}

function captureWorkspaceOccurrences(unit, cwd, opts = {}) {
	return withUnitLock(unit, () => {
		const head = requiredJson(unit.paths.head, "unit_head_corrupt");
		const lifecycle = readUnitState(unit, head);
		const terminalLease = opts.allowTerminalIncompleteLease && lifecycle.terminal && lifecycle.terminal.status === "incomplete" && lifecycle.active_mutations && lifecycle.active_mutations[opts.allowTerminalIncompleteLease];
		if (!terminalLease) assertUnitMutable(unit);
		const config = loadConfig(cwd);
		const state = lifecycle;
		const current = workspaceManifest(cwd, config);
		if (config.digest !== head.config_digest) return { current, configDrift: true, occurrences: state.occurrences };
		const prior = state.observed_workspace || state.baseline;
		const differences = diffManifests(prior, current.manifest);
		for (const detail of differences) {
			const normalized = { source: "workspace", ...detail };
			state.occurrences.push({ id: `CHG-${opaqueId()}`, ts: Date.now(), signature: sha256(canonicalJson(normalized)), detail: normalized });
		}
		state.observed_workspace = current.manifest;
		if (differences.length) head.work_revision += differences.length;
		writeUnitState(unit, state, head);
		return { current, configDrift: false, occurrences: state.occurrences };
	});
}

function verifyReviewChain(paths) {
	let records;
	try {
		records = readJsonlStrict(paths.reviews, "review_log_corrupt", { allowMissing: true });
	} catch (error) {
		return { ok: false, errors: [error.code], records: [], head: null };
	}
	const head = optionalJson(paths.reviewHead, { count: 0, chain_head: ZERO_HASH }, "review_head_corrupt");
	const errors = [];
	let prev = ZERO_HASH;
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		const payload = { ...r };
		delete payload.record_hash;
		if (r.seq !== i + 1 || r.prev_hash !== prev) errors.push("review_chain_sequence_invalid");
		if (sha256(canonicalJson(payload)) !== r.record_hash) errors.push("review_chain_hash_invalid");
		prev = r.record_hash;
	}
	if (records.length !== head.count || (records.length ? prev : ZERO_HASH) !== head.chain_head) errors.push("review_head_mismatch");
	return { ok: errors.length === 0, errors: [...new Set(errors)], records, head };
}

function appendReview(unit, review, opts = {}) {
	const cwd = opts.cwd || path.resolve(unit.paths.unit, "../../../..");
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => appendReviewUnlocked(unit, review, { ...opts, cwd })), opts.now || Date.now());
}

function appendReviewUnlocked(unit, review, opts = {}) {
	assertUnitMutable(unit);
	const errors = [];
	const now = opts.now || Date.now();
	const cwd = opts.cwd || path.resolve(unit.paths.unit, "../../../..");
	const config = loadConfig(cwd);
	const boundContract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
	const preservationReview = Boolean(config.preservation.required || boundContract && boundContract.preservation);
	cleanupExpiredReviewInvocations(unit, now);
	closedObject(review, ["verdict", "review_stage", "role", "planning_digest", "planning_seal_digest", "delivery_state", "preservation_vetoes", "run_id", "invocation_nonce", "bundle_digest", "full_bundle_digest", "evidence_view_digest", "source_head", "contract_digest", "workspace_digest", "config_digest", "scope_epoch", "work_revision", "binding_epoch", "covered_source_ids", "covered_source_mappings", "covered_directive_ids", "covered_target_ids", "covered_criterion_ids", "covered_authority_ids", "covered_authority_mappings", "covered_tombstone_ids", "covered_tombstone_mappings", "covered_scope_version_ids", "covered_scope_version_mappings", "covered_artifact_ids", "covered_edge_ids", "covered_change_ids", "covered_change_mappings", "covered_preservation_surface_mappings", "finding_codes", "sandbox", "executor", "isolation", "reviewed_at"], errors, "review");
	if (!review || !["CLEAN", "DIRTY"].includes(review.verdict)) errors.push("review_verdict_invalid");
	if (!review || !/^RUN-[a-f0-9]{32}$/.test(review.run_id || "")) errors.push("review_run_id_invalid");
	if (!review || !review.bundle_digest) errors.push("review_bundle_digest_missing");
	if (!review || !review.invocation_nonce) errors.push("review_invocation_nonce_missing");
	if (opts.expectedBundleDigest && review.bundle_digest !== opts.expectedBundleDigest) errors.push("review_bundle_digest_mismatch");
	if (!review || !review.sandbox || review.sandbox.no_network !== true) errors.push("review_network_isolation_missing");
	if (!review || !review.sandbox || review.sandbox.repository_blind !== true) errors.push("review_repository_blindness_missing");
	if (!review || !review.sandbox || review.sandbox.home_blind !== true) errors.push("review_home_blindness_missing");
	if (review && review.sandbox) closedObject(review.sandbox, ["no_network", "repository_blind", "home_blind"], errors, "review_sandbox");
	if (!review || !Array.isArray(review.finding_codes) || review.finding_codes.some((code) => !REVIEW_FINDING_CODES.has(code))) errors.push("review_finding_codes_invalid");
	else if ((review.verdict === "CLEAN" && review.finding_codes.length !== 0) || (review.verdict === "DIRTY" && review.finding_codes.length === 0)) errors.push("review_verdict_findings_mismatch");
	if (!review || typeof review.role !== "string" || !/^[a-z][a-z0-9_-]{2,63}$/.test(review.role)) errors.push("review_role_invalid");
	if (!review || !PRESERVATION_REVIEW_STAGES.includes(review.review_stage)) errors.push("review_stage_invalid");
	if (!review || !/^[a-f0-9]{64}$/.test(review.planning_digest || "")) errors.push("review_planning_digest_invalid");
	if (review && review.review_stage === "integration" && preservationReview && !/^[a-f0-9]{64}$/.test(review.planning_seal_digest || "")) errors.push("review_planning_seal_missing");
	if (review && review.review_stage === "planning" && review.planning_seal_digest !== null) errors.push("review_planning_seal_premature");
	if (!review || !/^[a-f0-9]{64}$/.test(review.full_bundle_digest || "")) errors.push("review_full_bundle_digest_invalid");
	if (!review || review.evidence_view_digest !== review.bundle_digest) errors.push("review_evidence_view_digest_mismatch");
	if (!review || !["RELEASE_ELIGIBLE", "REVIEW_ONLY"].includes(review.delivery_state)) errors.push("review_delivery_state_invalid");
	if (!review || !Array.isArray(review.preservation_vetoes) || review.preservation_vetoes.some((code) => typeof code !== "string" || !code.trim())) errors.push("review_preservation_vetoes_invalid");
	else if (review.verdict === "CLEAN" && (review.delivery_state !== expectedDeliveryState(config, boundContract) || review.preservation_vetoes.length)) errors.push("review_clean_delivery_invalid");
	if (!review || !Number.isInteger(review.reviewed_at)) errors.push("review_reviewed_at_invalid");
	let invocation = null;
	if (review && review.invocation_nonce) {
		invocation = readJson(path.join(unit.paths.pending, `review-${review.invocation_nonce}.json`));
			if (!invocation) errors.push("review_invocation_unknown");
			else {
				if (!reviewInvocationDigestValid(invocation)) errors.push("review_invocation_manifest_tampered");
				if (invocation.consumed) errors.push("review_invocation_replayed");
			if (invocation.expired) errors.push("review_invocation_expired");
			if (now > invocation.expires_at) errors.push("review_invocation_expired");
				if (review.bundle_digest !== invocation.bundle_digest) errors.push("review_invocation_bundle_mismatch");
				if (review.run_id !== invocation.review_run_id) errors.push("review_run_id_not_issued");
				if (review.review_stage !== invocation.review_stage) errors.push("review_stage_not_issued");
				if (review.role !== invocation.required_role) errors.push("review_role_not_issued");
				if (review.delivery_state !== invocation.expected_delivery_state) errors.push("review_delivery_state_not_issued");
				if (review.planning_digest !== invocation.planning_digest) errors.push("review_planning_digest_not_issued");
				if (review.planning_seal_digest !== invocation.planning_seal_digest) errors.push("review_planning_seal_not_issued");
				if (review.full_bundle_digest !== invocation.full_bundle_digest) errors.push("review_full_bundle_digest_not_issued");
				if (review.evidence_view_digest !== invocation.evidence_view_digest) errors.push("review_evidence_view_not_issued");
				for (const field of ["source_head", "contract_digest", "workspace_digest", "config_digest", "scope_epoch", "work_revision", "binding_epoch"]) if (review[field] !== invocation[field]) errors.push(`review_${field}_not_issued`);
				if (Number.isInteger(review.reviewed_at) && (review.reviewed_at < invocation.issued_at || review.reviewed_at > now + 30_000)) errors.push("review_reviewed_at_invalid");
				const expectedBundlePath = path.join(unit.paths.pending, `bundle-${review.invocation_nonce}.json`);
				if (path.resolve(invocation.private_bundle_path || "") !== path.resolve(expectedBundlePath)) errors.push("review_invocation_bundle_path_invalid");
				try {
					if (sha256(fs.readFileSync(expectedBundlePath)) !== invocation.bundle_digest) errors.push("review_invocation_bundle_tampered");
				} catch {
					errors.push("review_invocation_bundle_unavailable");
				}
			}
	}
	const executor = review && review.executor;
	if (executor) closedObject(executor, ["credential_id", "context_id", "process_id", "process_identity", "started_at", "attestor_executable_digest", "signature"], errors, "review_executor");
	if (!executor || !executor.credential_id || !executor.context_id || !executor.process_id || !executor.process_identity || !executor.started_at || !executor.signature) errors.push("review_executor_attestation_missing");
	if (executor && (!/^[a-f0-9]{64}$/.test(executor.attestor_executable_digest || "") || !config.reviewer.allowed_attestor_digests.includes(executor.attestor_executable_digest))) errors.push("review_executor_attestor_not_allowed");
		if (executor && invocation && (invocation.writer_session_ids || [invocation.writer_session_id]).includes(executor.context_id)) errors.push("review_context_not_independent");
		if (executor && invocation && (invocation.writer_process_ids || []).includes(executor.process_id)) errors.push("review_process_not_independent");
		if (executor && invocation && (invocation.writer_process_identities || []).includes(executor.process_identity)) errors.push("review_process_not_independent");
	if (opts.reviewerCredentialId && executor && executor.credential_id !== opts.reviewerCredentialId) errors.push("review_executor_credential_mismatch");
	const isolation = review && review.isolation;
	if (isolation) closedObject(isolation, ["credential_id", "execution_id", "challenge", "bundle_digest", "reviewer_context_id", "reviewer_process_id", "reviewer_process_identity", "launcher_process_id", "sandbox_engine", "sandbox_profile_digest", "sandbox_executable_digest", "reviewer_executable_digest", "attestor_executable_digest", "review_payload_digest", "no_network", "repository_blind", "home_blind", "started_at", "executed_at", "signature"], errors, "review_isolation");
	if (!isolation || !isolation.credential_id || !isolation.execution_id || !isolation.signature) errors.push("review_isolation_attestation_missing");
	if (isolation && invocation) {
		if (isolation.challenge !== invocation.nonce) errors.push("review_isolation_challenge_mismatch");
		if (isolation.bundle_digest !== invocation.bundle_digest) errors.push("review_isolation_bundle_mismatch");
		if (!executor || isolation.reviewer_context_id !== executor.context_id || isolation.reviewer_process_id !== executor.process_id || isolation.reviewer_process_identity !== executor.process_identity) errors.push("review_isolation_executor_mismatch");
		if (review.reviewed_at !== isolation.executed_at) errors.push("review_reviewed_at_invalid");
	}
	if (isolation && (isolation.no_network !== true || isolation.repository_blind !== true || isolation.home_blind !== true)) errors.push("review_isolation_controls_missing");
	if (isolation && (!isolation.launcher_process_id || !["bubblewrap", "codex-windows-elevated"].includes(isolation.sandbox_engine) || !/^[a-f0-9]{64}$/.test(isolation.sandbox_profile_digest || "") || !/^[a-f0-9]{64}$/.test(isolation.sandbox_executable_digest || "") || !/^[a-f0-9]{64}$/.test(isolation.reviewer_executable_digest || ""))) errors.push("review_isolation_execution_evidence_missing");
	if (isolation && !config.review_runner.allowed_sandbox_digests.includes(isolation.sandbox_executable_digest)) errors.push("review_sandbox_executable_not_allowed");
	if (isolation && !config.review_runner.allowed_reviewer_digests.includes(isolation.reviewer_executable_digest)) errors.push("reviewer_executable_not_allowed");
	if (isolation && (!/^[a-f0-9]{64}$/.test(isolation.attestor_executable_digest || "") || !config.review_runner.allowed_attestor_digests.includes(isolation.attestor_executable_digest))) errors.push("review_isolation_attestor_not_allowed");
	if (isolation && isolation.review_payload_digest !== sha256(canonicalJson(reviewSignaturePayload(review)))) errors.push("review_isolation_payload_mismatch");
	if (opts.reviewRunnerCredentialId && isolation && isolation.credential_id !== opts.reviewRunnerCredentialId) errors.push("review_isolation_credential_mismatch");
	if (executor && isolation && executor.credential_id === isolation.credential_id) errors.push("review_isolation_credential_not_separate");
	if (!opts.reviewRunnerPublicKey) errors.push("review_isolation_public_key_unavailable");
	if (opts.reviewRunnerPublicKey && isolation && isolation.signature) {
		try {
			const ok = crypto.verify(null, Buffer.from(canonicalJson(isolationSignaturePayload(isolation))), opts.reviewRunnerPublicKey, Buffer.from(isolation.signature, "base64"));
			if (!ok) errors.push("review_isolation_signature_invalid");
		} catch {
			errors.push("review_isolation_signature_invalid");
		}
	}
	if (invocation && invocation.ids) {
		for (const [field, key] of [
			["covered_source_ids", "sourceIds"], ["covered_source_mappings", "sourceMappings"], ["covered_directive_ids", "directiveIds"], ["covered_target_ids", "targetIds"], ["covered_criterion_ids", "criterionIds"], ["covered_authority_ids", "authorityIds"], ["covered_authority_mappings", "authorityMappings"], ["covered_tombstone_ids", "tombstoneIds"], ["covered_tombstone_mappings", "tombstoneMappings"], ["covered_scope_version_ids", "scopeVersionIds"], ["covered_scope_version_mappings", "scopeVersionMappings"], ["covered_artifact_ids", "artifactIds"], ["covered_edge_ids", "edgeIds"], ["covered_change_ids", "occurrenceIds"], ["covered_change_mappings", "changeMappings"], ["covered_preservation_surface_mappings", "preservationSurfaceMappings"],
		]) if (!arrayExactly(review && review[field], invocation.ids[key] || [])) errors.push(`review_${field}_not_exact`);
	}
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	if (config.digest !== head.config_digest) errors.push("review_config_drift");
	const currentState = readUnitState(unit, head);
	if (currentState.active_mutations && Object.keys(currentState.active_mutations).length) errors.push("review_mutation_in_flight");
	if (invocation) {
		try {
			const currentBinding = requiredJson(unit.paths.binding, "binding_state_corrupt");
			const currentContract = requiredJson(unit.paths.contract, "contract_state_corrupt");
			const currentBundle = invocation.required_role === "general" && !effectiveReviewRoles(config, currentContract).length
				? buildReviewBundle(unit, cwd)
				: buildReviewBundle(unit, cwd, { stage: invocation.review_stage, role: invocation.required_role });
			const currentPlanningSeal = planningSeal(unit, config, currentBinding, head, currentContract);
			const currentBindings = {
				bundle_digest: currentBundle.digest,
				full_bundle_digest: currentBundle.full_digest,
				evidence_view_digest: currentBundle.digest,
				source_head: head.source_head,
				contract_digest: head.contract_digest,
				workspace_digest: currentBundle.workspace.digest,
				config_digest: head.config_digest,
				scope_epoch: head.scope_epoch,
				work_revision: head.work_revision,
				binding_epoch: currentBinding.binding_epoch,
				planning_digest: currentBinding.planning_digest,
				planning_seal_digest: invocation.review_stage === "integration" ? currentPlanningSeal.digest : null,
			};
			if (Object.entries(currentBindings).some(([field, value]) => invocation[field] !== value)) errors.push("review_post_launch_drift");
		} catch {
			errors.push("review_post_launch_drift");
		}
	}
	if (opts.reviewerPublicKey && publicKeyFingerprint(opts.reviewerPublicKey) !== head.reviewer_key_fingerprint) errors.push("reviewer_key_pin_mismatch");
	if (opts.reviewRunnerPublicKey && publicKeyFingerprint(opts.reviewRunnerPublicKey) !== head.review_runner_key_fingerprint) errors.push("review_runner_key_pin_mismatch");
	if (!opts.reviewerPublicKey) errors.push("review_executor_public_key_unavailable");
	if (opts.reviewerPublicKey && executor && executor.signature) {
		try {
			const ok = crypto.verify(null, Buffer.from(canonicalJson(reviewSignaturePayload(review))), opts.reviewerPublicKey, Buffer.from(executor.signature, "base64"));
			if (!ok) errors.push("review_executor_signature_invalid");
		} catch {
			errors.push("review_executor_signature_invalid");
		}
	}
	const priorChain = verifyReviewChain(unit.paths);
	if (!priorChain.ok) errors.push(...priorChain.errors);
	if (priorChain.records.some((record) => record.run_id === (review && review.run_id))) errors.push("review_run_id_replayed");
	if (priorChain.records.some((record) => record.invocation_nonce === (review && review.invocation_nonce))) errors.push("review_invocation_replayed");
	if (priorChain.records.some((record) => record.isolation && review && review.isolation && record.isolation.execution_id === review.isolation.execution_id)) errors.push("review_execution_id_replayed");
	if (priorChain.records.some((record) => record.executor && review && review.executor && record.executor.context_id === review.executor.context_id)) errors.push("review_context_replayed");
	if (priorChain.records.some((record) => record.executor && review && review.executor && record.executor.process_id === review.executor.process_id && record.executor.started_at === review.executor.started_at)) errors.push("review_process_replayed");
	if (review && review.invocation_nonce) {
		try { verifyGlobalClaim(cwd, "review-invocation", review.invocation_nonce, { unit_id: unit.id, invocation_digest: invocation && invocation.invocation_digest }); } catch (error) { errors.push(error.code || "review_invocation_claim_invalid"); }
	}
	if (errors.length) throw Object.assign(new Error(errors.join(", ")), { code: "review_invalid", errors });
	const runner = require("./request-contract-review-runner.js");
	if (!runner.consumeRunEvidence(opts.runnerEvidence, review)) throw Object.assign(new Error("review receipt was not produced by a live trusted runner execution"), { code: "review_runner_provenance_missing" });
	const reviewDigest = sha256(canonicalJson(review));
	claimGlobalIds(cwd, [
		{ kind: "review-run", value: review.run_id, owner: { unit_id: unit.id, review_digest: reviewDigest } },
		{ kind: "review-execution", value: review.isolation.execution_id, owner: { unit_id: unit.id, review_digest: reviewDigest } },
		{ kind: "review-context", value: review.executor.context_id, owner: { unit_id: unit.id, review_digest: reviewDigest } },
		{ kind: "review-process", value: canonicalJson({ process_id: review.executor.process_id, process_identity: review.executor.process_identity, started_at: review.executor.started_at }), owner: { unit_id: unit.id, review_digest: reviewDigest } },
	]);
	const rh = optionalJson(unit.paths.reviewHead, { version: VERSION, count: 0, chain_head: ZERO_HASH }, "review_head_corrupt");
	const payload = { ...review, version: VERSION, seq: rh.count + 1, prev_hash: rh.chain_head };
	const record = { ...payload, record_hash: sha256(canonicalJson(payload)) };
	invocation.consumed = true;
	invocation.consumed_at = now;
	invocation.review_record_hash = record.record_hash;
	const transaction = {
		version: VERSION,
		kind: "review",
		created_at: now,
		expected_review: { count: rh.count, chain_head: rh.chain_head },
		record,
		review_head: { ...rh, count: record.seq, chain_head: record.record_hash },
		invocation_name: `review-${review.invocation_nonce}.json`,
		invocation,
		private_bundle_name: invocation.private_bundle_path ? path.basename(invocation.private_bundle_path) : null,
	};
	secureJson(transactionPath(unit, "review"), transaction, { exclusive: true });
	if (opts.afterTransactionPrepared) opts.afterTransactionPrepared(transaction);
	applyReviewTransaction(unit, transaction);
	return record;
}

function arrayCovers(actual, expected) {
	const set = new Set(actual || []);
	return expected.every((x) => set.has(x));
}

function arrayExactly(actual, expected) {
	return Array.isArray(actual) && actual.length === expected.length && arrayCovers(actual, expected);
}

function evaluateReviews(unit, bindings, minimum = 2) {
	const cwd = bindings.cwd || path.resolve(unit.paths.unit, "../../../..");
	const chain = verifyReviewChain(unit.paths);
	if (!chain.ok) return { ok: false, errors: chain.errors };
	const clean = [];
	const invocationNonces = new Set();
	const executionIds = new Set();
	const reviewerContexts = new Set();
	const reviewerProcesses = new Set();
	const requiredRoles = [...new Set(bindings.required_roles || [])];
	const requiredStages = [...new Set(bindings.required_stages || (requiredRoles.length ? ["integration"] : []))];
	const requiredSlots = requiredRoles.length ? requiredStages.flatMap((stage) => requiredRoles.map((role) => `${stage}:${role}`)) : ["integration:general"];
	const slotStages = new Set(requiredSlots.map((slot) => slot.split(":", 1)[0]));
	const target = requiredRoles.length ? requiredSlots.length * minimum : Math.max(minimum, requiredSlots.length);
	const coveredSlots = new Map();
	const blockedStages = new Set();
	const runCounts = new Map();
	const executionCounts = new Map();
	for (const record of chain.records) {
		if (record.run_id) runCounts.set(record.run_id, (runCounts.get(record.run_id) || 0) + 1);
		if (record.isolation && record.isolation.execution_id) executionCounts.set(record.isolation.execution_id, (executionCounts.get(record.isolation.execution_id) || 0) + 1);
	}
	for (let i = chain.records.length - 1; i >= 0 && clean.length < target; i--) {
		const r = chain.records[i];
		if (!slotStages.has(r.review_stage) || blockedStages.has(r.review_stage)) continue;
		// A DIRTY or malformed record invalidates only the older suffix for its
		// own stage. Planning evidence remains reusable when integration is
		// remediated, matching the stage-local issuance scheduler.
		if (r.verdict !== "CLEAN") { blockedStages.add(r.review_stage); continue; }
		const stableFields = ["source_head", "contract_digest", "config_digest", "scope_epoch", "binding_epoch"];
		const integrationFields = ["workspace_digest", "work_revision"];
		const same = stableFields.every((k) => r[k] === bindings[k]) && (r.review_stage === "planning" || integrationFields.every((k) => r[k] === bindings[k]));
		const covered =
			arrayExactly(r.covered_source_ids, bindings.ids.sourceIds) &&
			arrayExactly(r.covered_source_mappings, bindings.ids.sourceMappings) &&
			arrayExactly(r.covered_directive_ids, bindings.ids.directiveIds) &&
				arrayExactly(r.covered_target_ids, bindings.ids.targetIds) &&
				arrayExactly(r.covered_criterion_ids, bindings.ids.criterionIds) &&
				arrayExactly(r.covered_authority_ids, bindings.ids.authorityIds) &&
				arrayExactly(r.covered_authority_mappings, bindings.ids.authorityMappings) &&
				arrayExactly(r.covered_tombstone_ids, bindings.ids.tombstoneIds) &&
				arrayExactly(r.covered_tombstone_mappings, bindings.ids.tombstoneMappings) &&
				arrayExactly(r.covered_scope_version_ids, bindings.ids.scopeVersionIds) &&
				arrayExactly(r.covered_scope_version_mappings, bindings.ids.scopeVersionMappings) &&
				arrayExactly(r.covered_artifact_ids, bindings.ids.artifactIds) &&
				arrayExactly(r.covered_edge_ids, bindings.ids.edgeIds) &&
				arrayExactly(r.covered_change_ids, bindings.ids.occurrenceIds) &&
				arrayExactly(r.covered_change_mappings, bindings.ids.changeMappings) &&
				arrayExactly(r.covered_preservation_surface_mappings, bindings.ids.preservationSurfaceMappings || []);
		const isolated = r.sandbox && r.sandbox.no_network === true && r.sandbox.repository_blind === true && r.sandbox.home_blind === true;
		const findingsValid = Array.isArray(r.finding_codes) && r.finding_codes.length === 0;
		const preservationValid = Array.isArray(r.preservation_vetoes) && r.preservation_vetoes.length === 0 && r.delivery_state === (bindings.expected_delivery_state || "RELEASE_ELIGIBLE");
		const slot = `${r.review_stage}:${r.role}`;
		const uniqueSlotsRequired = requiredRoles.length > 0;
		const roleValid = requiredSlots.includes(slot) && (!uniqueSlotsRequired || (coveredSlots.get(slot) || 0) < minimum);
		const viewValid = r.evidence_view_digest === r.bundle_digest && /^[a-f0-9]{64}$/.test(r.full_bundle_digest || "");
		const planningValid = r.planning_digest === bindings.planning_digest && (r.review_stage === "planning" ? r.planning_seal_digest === null : r.planning_seal_digest === bindings.planning_seal_digest);
		const sameBundle = requiredSlots.length > 1 || !bindings.bundle_digest || r.bundle_digest === bindings.bundle_digest;
		const invocation = r.invocation_nonce && readJson(path.join(unit.paths.pending, `review-${r.invocation_nonce}.json`));
		const invocationValid = invocation && reviewInvocationDigestValid(invocation) && invocation.consumed === true && invocation.review_record_hash === r.record_hash && !invocationNonces.has(r.invocation_nonce);
		let claimsValid = true;
		try {
			const originalReview = { ...r };
			for (const field of ["version", "seq", "prev_hash", "record_hash"]) delete originalReview[field];
			const reviewDigest = sha256(canonicalJson(originalReview));
			verifyGlobalClaim(cwd, "review-invocation", r.invocation_nonce, { unit_id: unit.id, invocation_digest: invocation && invocation.invocation_digest });
			verifyGlobalClaim(cwd, "review-run", r.run_id, { unit_id: unit.id, review_digest: reviewDigest });
			verifyGlobalClaim(cwd, "review-execution", r.isolation && r.isolation.execution_id, { unit_id: unit.id, review_digest: reviewDigest });
			verifyGlobalClaim(cwd, "review-context", r.executor && r.executor.context_id, { unit_id: unit.id, review_digest: reviewDigest });
			verifyGlobalClaim(cwd, "review-process", canonicalJson({ process_id: r.executor && r.executor.process_id, process_identity: r.executor && r.executor.process_identity, started_at: r.executor && r.executor.started_at }), { unit_id: unit.id, review_digest: reviewDigest });
		} catch {
			claimsValid = false;
		}
		const reviewerProcessIdentity = r.executor && canonicalJson({ process_id: r.executor.process_id, started_at: r.executor.started_at });
		let executorValid = Boolean(r.executor && r.executor.signature && r.executor.context_id && r.executor.credential_id && !reviewerContexts.has(r.executor.context_id) && !reviewerProcesses.has(reviewerProcessIdentity));
		if (bindings.reviewer_credential_id && r.executor && r.executor.credential_id !== bindings.reviewer_credential_id) executorValid = false;
		if (executorValid && bindings.reviewer_public_key) {
			try {
				executorValid = crypto.verify(null, Buffer.from(canonicalJson(reviewSignaturePayload(r))), bindings.reviewer_public_key, Buffer.from(r.executor.signature, "base64"));
			} catch {
				executorValid = false;
			}
		} else executorValid = false;
		let isolationValid = Boolean(r.isolation && r.isolation.signature && r.isolation.execution_id && !executionIds.has(r.isolation.execution_id) && executionCounts.get(r.isolation.execution_id) === 1);
		if (isolationValid && bindings.review_runner_credential_id && r.isolation.credential_id !== bindings.review_runner_credential_id) isolationValid = false;
		if (isolationValid && r.executor && r.isolation.credential_id === r.executor.credential_id) isolationValid = false;
		if (isolationValid && invocation) {
			isolationValid = r.isolation.challenge === invocation.nonce && r.isolation.bundle_digest === invocation.bundle_digest && r.isolation.reviewer_context_id === r.executor.context_id && r.isolation.reviewer_process_id === r.executor.process_id;
		}
		if (isolationValid && bindings.review_runner_public_key) {
			try {
				isolationValid = crypto.verify(null, Buffer.from(canonicalJson(isolationSignaturePayload(r.isolation))), bindings.review_runner_public_key, Buffer.from(r.isolation.signature, "base64"));
			} catch {
				isolationValid = false;
			}
		} else isolationValid = false;
		if (!same || !covered || !isolated || !findingsValid || !preservationValid || !roleValid || !viewValid || !planningValid || !sameBundle || !r.run_id || runCounts.get(r.run_id) !== 1 || !invocationValid || !claimsValid || !executorValid || !isolationValid) { blockedStages.add(r.review_stage); continue; }
		if (clean.some((x) => x.run_id === r.run_id)) { blockedStages.add(r.review_stage); continue; }
		invocationNonces.add(r.invocation_nonce);
		executionIds.add(r.isolation.execution_id);
		reviewerContexts.add(r.executor.context_id);
		reviewerProcesses.add(reviewerProcessIdentity);
		coveredSlots.set(slot, (coveredSlots.get(slot) || 0) + 1);
		clean.push(r);
	}
	const slotCoverage = requiredSlots.every((slot) => (coveredSlots.get(slot) || 0) >= (requiredRoles.length ? minimum : 1));
	const ok = clean.length >= target && slotCoverage;
	const incompleteCode = slotCoverage || !requiredRoles.length ? "review_clean_streak_incomplete" : "review_required_slots_incomplete";
	return { ok, errors: ok ? [] : [incompleteCode], clean };
}

function reconcileOpenMutationLeases(unit, cwd, client, sessionId, now = Date.now()) {
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const state = readUnitState(unit, head);
	const leases = Object.entries(state.active_mutations || {});
	if (!leases.length) return { captured: null, foreign: [] };
	const effectiveSessionId = sessionId || head.session_id;
	const foreign = leases.filter(([, lease]) => lease.client !== client || lease.session_id !== effectiveSessionId);
	if (foreign.length) return { captured: null, foreign: foreign.map(([leaseId]) => leaseId) };
	const captured = captureWorkspaceOccurrences(unit, cwd);
	const nextHead = requiredJson(unit.paths.head, "unit_head_corrupt");
	const nextState = readUnitState(unit, nextHead);
	nextState.closed_mutations = nextState.closed_mutations || [];
	for (const [leaseId, lease] of Object.entries(nextState.active_mutations || {})) {
		nextState.closed_mutations.push({ lease_id: leaseId, ...lease, closed_at: now, close_reason: "stop_reconciliation" });
	}
	nextState.active_mutations = {};
	writeUnitState(unit, nextState, nextHead);
	return { captured, foreign: [] };
}

function stopResult(unit, errors, config, client, now = Date.now(), context = {}) {
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const state = readUnitState(unit, head);
	if (state.terminal && state.terminal.status === "incomplete") return { kind: "incomplete", code: "request_contract_incomplete", message: "Request contract remains incomplete.", terminal: state.terminal };
	const codes = [...new Set(errors)].sort();
	const failureFingerprint = sha256(canonicalJson({ codes, source_head: head.source_head, contract_digest: head.contract_digest, scope_epoch: head.scope_epoch, work_revision: head.work_revision, config_digest: context.config_digest || config.digest, workspace_digest: context.workspace_digest || null, binding_epoch: context.binding_epoch || null }));
	const sameFailure = Boolean(state.stop && state.stop.failure_fingerprint === failureFingerprint);
	const attempt = sameFailure ? state.stop.attempt + 1 : 1;
	state.stop = { episode_id: sameFailure ? state.stop.episode_id : opaqueId("EP-"), attempt, unresolved_codes: codes, failure_fingerprint: failureFingerprint, updated_at: now };
	if (attempt >= config.stop_attempt_limit) {
		state.terminal = { id: opaqueId("TERM-"), status: "incomplete", episode_id: state.stop.episode_id, at: now, error_codes: codes };
		writeUnitState(unit, state, head);
		return { kind: "incomplete", code: "request_contract_incomplete", message: "Request contract could not reach a valid completion state.", terminal: state.terminal };
	}
	writeUnitState(unit, state, head);
	return { kind: "block", code: "request_contract_blocked", message: `Request contract incomplete (${codes.join(", ")}). Continue autonomously and resolve the recorded obligations.`, errors: codes };
}

function completionAssessment(unit, cwd, config, now) {
	const errors = [];
	if (listUnconsumedQuarantine(cwd).length) errors.push("unconsumed_quarantine");
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const sources = verifySourceChain(unit.paths, head);
	if (!sources.ok) errors.push(...sources.errors);
	const scopeHistory = verifyScopeHistory(unit);
	if (!scopeHistory.ok) errors.push(...scopeHistory.errors);
	const ws = captureWorkspaceOccurrences(unit, cwd);
	const currentHead = requiredJson(unit.paths.head, "unit_head_corrupt");
	if (ws.configDrift) errors.push("product_root_config_drift");
	const binding = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
	const contract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
	const lifecycleState = readUnitState(unit, currentHead);
	if (!binding || !contract) errors.push("request_contract_unbound");
	if (contract && (!scopeHistory.records.length || scopeHistory.records.at(-1).contract_digest !== contractDigest(contract))) errors.push("scope_history_current_contract_mismatch");
	let cv = { ok: false, errors: [], ids: { sourceIds: [], sourceMappings: [], directiveIds: [], targetIds: [], criterionIds: [], authorityIds: [], authorityMappings: [], tombstoneIds: [], tombstoneMappings: [], artifactIds: [], edgeIds: [], occurrenceIds: [], changeMappings: [] }, scope_digest: "" };
	let pv = { ok: false, errors: ["preservation_contract_unchecked"], surface_digests: {} };
	if (contract) {
		const digest = contractDigest(contract);
		if (digest !== head.contract_digest) errors.push("contract_digest_mismatch");
		cv = validateContract(contract, sources.records, ws.occurrences, { now, publicKeyPem: loadAuthorityKey(cwd, config), cwd, config });
		if (!cv.ok) errors.push(...cv.errors);
		pv = preservationPolicy.validateWorkspace(contract, { baseline: lifecycleState.baseline, current: ws.current.manifest, cwd, config, sourceRecords: sources.records, probeRunner: preservationRunnerContext(cwd, config) });
		if (!pv.ok) errors.push(...pv.errors);
		if (contract.preservation) {
			const receiptEvidence = preservationReceipts.evaluate({ cwd, unitId: unit.id, file: path.join(unit.paths.unit, "preservation", "decision.json"), contract, binding, head: currentHead, now });
			if (!receiptEvidence.ok) errors.push(...receiptEvidence.errors);
				errors.push("preservation_incident_history_pending", "external_effect_gate_pending");
			if ((contract.preservation.vendor_sources || []).length > 0) errors.push("preservation_vendor_origin_attestation_pending");
		}
		if (contract.status !== "complete") errors.push("contract_status_not_complete");
		for (const directive of contract.directives || []) if (!["done", "superseded", "deferred", "abandoned"].includes(directive.state)) errors.push(`contract_directive_not_disposed:${directive.id}`);
	}
	let reviewBundle = null;
	let reviews = { ok: false, errors: ["review_clean_streak_incomplete"], clean: [] };
	if (binding && contract) {
		reviewBundle = buildReviewBundle(unit, cwd);
		const currentPlanningSeal = planningSeal(unit, config, binding, currentHead, contract);
		reviews = evaluateReviews(
			unit,
			{
				source_head: currentHead.source_head,
				contract_digest: currentHead.contract_digest,
				workspace_digest: ws.current.digest,
				config_digest: currentHead.config_digest,
				scope_epoch: currentHead.scope_epoch,
				work_revision: currentHead.work_revision,
				binding_epoch: binding.binding_epoch,
				bundle_digest: reviewBundle.digest,
				cwd,
					reviewer_public_key: loadReviewerKey(cwd, config),
					reviewer_credential_id: config.reviewer.credential_id || null,
				review_runner_public_key: loadReviewRunnerKey(cwd, config),
					review_runner_credential_id: config.review_runner.credential_id || null,
				required_roles: effectiveReviewRoles(config, contract),
				required_stages: config.preservation.required || contract.preservation ? PRESERVATION_REVIEW_STAGES : ["integration"],
				expected_delivery_state: expectedDeliveryState(config, contract),
				planning_digest: binding.planning_digest,
				planning_seal_digest: currentPlanningSeal.digest,
				ids: { ...cv.ids, ...scopeHistoryCoverage(scopeHistory.records), preservationSurfaceMappings: Object.entries(pv.surface_digests || {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, digest]) => `${id}:${digest}`) },
			},
			config.minimum_clean_rounds,
		);
		if (!reviews.ok) errors.push(...reviews.errors);
	}
	return { errors: [...new Set(errors)], head: currentHead, sources, scopeHistory, ws, binding, contract, cv, pv, reviewBundle, reviews };
}

function completionAssessmentDigest(assessment) {
	return sha256(canonicalJson({
		source_head: assessment.head.source_head,
		contract_digest: assessment.head.contract_digest,
		config_digest: assessment.head.config_digest,
		scope_epoch: assessment.head.scope_epoch,
		work_revision: assessment.head.work_revision,
		state_digest: assessment.head.state_digest,
		workspace_digest: assessment.ws.current.digest,
		binding: assessment.binding,
		scope_history_head: assessment.scopeHistory.head,
		review_bundle_digest: assessment.reviewBundle && assessment.reviewBundle.digest,
		review_record_hashes: (assessment.reviews.clean || []).map((record) => record.record_hash),
		coverage: assessment.cv.ids,
		preservation_surface_digests: assessment.pv && assessment.pv.surface_digests,
	}));
}

function completionProofPayload(proof) {
	const payload = { ...proof };
	delete payload.digest;
	return payload;
}

function verifyCompletionProof(unit, cwd, config, head, state, terminal) {
	const errors = [];
	const proof = terminal && terminal.completion_proof;
	if (!proof || proof.digest !== sha256(canonicalJson(completionProofPayload(proof)))) return { ok: false, errors: ["completion_proof_digest_invalid"] };
	const binding = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
	const contract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
	const sources = verifySourceChain(unit.paths, head);
	const scopeHistory = verifyScopeHistory(unit);
	const reviewChain = verifyReviewChain(unit.paths);
	if (!sources.ok) errors.push(...sources.errors);
	if (!scopeHistory.ok) errors.push(...scopeHistory.errors);
	if (!reviewChain.ok) errors.push(...reviewChain.errors);
	if (!binding || !contract) errors.push("completion_proof_binding_missing");
	for (const field of ["source_head", "contract_digest", "config_digest", "scope_epoch", "work_revision"]) if (proof[field] !== head[field]) errors.push(`completion_proof_${field}_mismatch`);
	if (!binding || proof.binding_epoch !== binding.binding_epoch) errors.push("completion_proof_binding_epoch_mismatch");
	if (!contract || proof.contract_digest !== contractDigest(contract)) errors.push("completion_proof_contract_digest_mismatch");
	if (proof.scope_history_head !== (scopeHistory.head && scopeHistory.head.chain_head)) errors.push("completion_proof_scope_history_mismatch");
	if (proof.review_chain_head !== (reviewChain.head && reviewChain.head.chain_head)) errors.push("completion_proof_review_chain_mismatch");
	const requiredReviewCount = effectiveReviewRoles(config, contract).length ? requiredReviewSlots(config, contract).length * config.minimum_clean_rounds : config.minimum_clean_rounds;
	if (!Array.isArray(proof.review_record_hashes) || proof.review_record_hashes.length < requiredReviewCount) errors.push("completion_proof_review_records_missing");
	let cv = { ok: false, errors: [], ids: { sourceIds: [], sourceMappings: [], directiveIds: [], targetIds: [], criterionIds: [], authorityIds: [], authorityMappings: [], tombstoneIds: [], tombstoneMappings: [], artifactIds: [], edgeIds: [], occurrenceIds: [], changeMappings: [] } };
	if (contract && sources.ok) {
		cv = validateContract(contract, sources.records, state.occurrences || [], { now: terminal.at, publicKeyPem: loadAuthorityKey(cwd, config), cwd, config });
		if (!cv.ok) errors.push(...cv.errors);
		const workspace = workspaceManifest(cwd, config);
		const preservation = preservationPolicy.validateWorkspace(contract, { baseline: state.baseline, current: workspace.manifest, cwd, config, sourceRecords: sources.records, probeRunner: preservationRunnerContext(cwd, config) });
		if (!preservation.ok) errors.push(...preservation.errors);
		if (canonicalJson(proof.preservation_surface_digests || {}) !== canonicalJson(preservation.surface_digests || {})) errors.push("completion_proof_preservation_digest_mismatch");
	}
	if (binding && contract && cv.ok && scopeHistory.ok) {
		const currentPlanningSeal = planningSeal(unit, config, binding, head, contract);
		const reviews = evaluateReviews(unit, {
			source_head: proof.source_head,
			contract_digest: proof.contract_digest,
			workspace_digest: proof.workspace_digest,
			config_digest: proof.config_digest,
			scope_epoch: proof.scope_epoch,
			work_revision: proof.work_revision,
			binding_epoch: proof.binding_epoch,
			bundle_digest: proof.bundle_digest,
			cwd,
			reviewer_public_key: loadReviewerKey(cwd, config),
			reviewer_credential_id: config.reviewer.credential_id || null,
			review_runner_public_key: loadReviewRunnerKey(cwd, config),
			review_runner_credential_id: config.review_runner.credential_id || null,
			required_roles: effectiveReviewRoles(config, contract),
			required_stages: config.preservation.required || contract.preservation ? PRESERVATION_REVIEW_STAGES : ["integration"],
			expected_delivery_state: expectedDeliveryState(config, contract),
			planning_digest: binding.planning_digest,
			planning_seal_digest: currentPlanningSeal.digest,
			ids: { ...cv.ids, ...scopeHistoryCoverage(scopeHistory.records), preservationSurfaceMappings: Object.entries((proof.preservation_surface_digests || {})).sort(([a], [b]) => a.localeCompare(b)).map(([id, digest]) => `${id}:${digest}`) },
		}, config.minimum_clean_rounds);
		if (!reviews.ok) errors.push(...reviews.errors);
		else if (canonicalJson(reviews.clean.map((record) => record.record_hash)) !== canonicalJson(proof.review_record_hashes)) errors.push("completion_proof_review_records_mismatch");
	}
	return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function evaluateCompletion(unit, cwd, client, now = Date.now(), sessionId = null, opts = {}) {
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => evaluateCompletionUnlocked(unit, cwd, client, now, sessionId, opts), now), now);
}

function validateSuccessfulTerminalUnlocked(unit, cwd, opts = {}) {
	const config = loadConfig(cwd);
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const state = readUnitState(unit, head);
	const terminal = state.terminal;
	if (!terminal || terminal.status !== "success") return { ok: false, errors: ["completion_proof_missing"] };
	const verified = verifyCompletionProof(unit, cwd, config, head, state, terminal);
	const errors = [...verified.errors];
	const handedOff = opts.allowHandoff === true && successfulHandoffExists(cwd, unit, head, terminal);
	if (!handedOff && config.digest !== head.config_digest) errors.push("completion_proof_config_digest_mismatch");
	if (!handedOff) {
		const workspace = workspaceManifest(cwd, config);
		if (!terminal.completion_proof || workspace.digest !== terminal.completion_proof.workspace_digest) errors.push("completion_proof_workspace_digest_mismatch");
	}
	return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

const COMPACTION_AUTHORIZATION_KEYS = ["version", "id", "unit_id", "terminal_id", "client", "session_id", "issued_at", "consumed_at", "completion_proof_digest", "source_head", "contract_digest", "workspace_digest", "config_digest", "scope_epoch", "work_revision", "binding_epoch"];

function createCompactionAuthorization(unit, head, state, client, sessionId, now) {
	const terminal = state.terminal;
	const proof = terminal && terminal.completion_proof;
	if (!proof || !/^[a-f0-9]{64}$/.test(proof.digest || "")) throw Object.assign(new Error("current completion proof is required"), { code: "completion_proof_missing" });
	return {
		version: VERSION,
		id: opaqueId("CMP-"),
		unit_id: unit.id,
		terminal_id: terminal.id,
		client,
		session_id: sessionId,
		issued_at: now,
		consumed_at: null,
		completion_proof_digest: proof.digest,
		source_head: head.source_head,
		contract_digest: head.contract_digest,
		workspace_digest: proof.workspace_digest,
		config_digest: head.config_digest,
		scope_epoch: head.scope_epoch,
		work_revision: head.work_revision,
		binding_epoch: proof.binding_epoch,
	};
}

function validateCompactionAuthorization(unit, head, state, client, sessionId) {
	const errors = [];
	const authorization = state.compaction_authorization;
	if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) return { ok: false, errors: ["compaction_authorization_missing"] };
	closedObject(authorization, COMPACTION_AUTHORIZATION_KEYS, errors, "compaction_authorization");
	const terminal = state.terminal;
	const proof = terminal && terminal.completion_proof;
	if (authorization.version !== VERSION || !/^CMP-[a-f0-9]{32}$/.test(authorization.id || "") || authorization.unit_id !== unit.id) errors.push("compaction_authorization_identity_invalid");
	if (!terminal || terminal.status !== "success" || authorization.terminal_id !== terminal.id) errors.push("compaction_authorization_terminal_mismatch");
	if (authorization.client !== client || authorization.session_id !== sessionId) errors.push("compaction_authorization_session_mismatch");
	if (!Number.isInteger(authorization.issued_at) || authorization.issued_at < 0) errors.push("compaction_authorization_time_invalid");
	if (authorization.consumed_at !== null) errors.push("compaction_authorization_consumed");
	if (!proof || authorization.completion_proof_digest !== proof.digest) errors.push("compaction_authorization_proof_mismatch");
	for (const [field, expected] of [
		["source_head", head.source_head],
		["contract_digest", head.contract_digest],
		["workspace_digest", proof && proof.workspace_digest],
		["config_digest", head.config_digest],
		["scope_epoch", head.scope_epoch],
		["work_revision", head.work_revision],
		["binding_epoch", proof && proof.binding_epoch],
	]) if (authorization[field] !== expected) errors.push(`compaction_authorization_${field}_mismatch`);
	return { ok: errors.length === 0, errors: [...new Set(errors)], authorization };
}

function evaluatePreCompact(unit, cwd, client, now = Date.now(), sessionId = null) {
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => {
		let state = readUnitState(unit);
		if (!state.terminal || state.terminal.status !== "success") {
			const completion = evaluateCompletionUnlocked(unit, cwd, client, now, sessionId, { recordStopFailure: false });
			if (completion.kind !== "allow") return completion;
			state = readUnitState(unit);
		}
		const verified = validateSuccessfulTerminalUnlocked(unit, cwd);
		if (!verified.ok) return { kind: "block", code: "request_contract_completion_proof_invalid", message: "Compaction denied because the successful completion proof is no longer current.", errors: verified.errors };
		const head = requiredJson(unit.paths.head, "unit_head_corrupt");
		state = readUnitState(unit, head);
		state.compaction_authorization = createCompactionAuthorization(unit, head, state, client, sessionId, now);
		writeUnitState(unit, state, head);
		return { kind: "allow", code: "request_contract_compaction_ready", message: "Completion proof is current before compaction." };
	}, now), now);
}

function evaluatePostCompact(unit, cwd, client, now = Date.now(), sessionId = null) {
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => {
		const head = requiredJson(unit.paths.head, "unit_head_corrupt");
		const state = readUnitState(unit, head);
		const authorization = validateCompactionAuthorization(unit, head, state, client, sessionId);
		if (!authorization.ok) return { kind: "block", code: "request_contract_postcompact_without_proof", message: "Post-compaction continuation denied because no current one-time pre-compaction authorization exists.", errors: authorization.errors };
		const verified = validateSuccessfulTerminalUnlocked(unit, cwd);
		if (!verified.ok) return { kind: "block", code: "request_contract_postcompact_without_proof", message: "Post-compaction continuation denied because the pre-compaction completion proof is no longer current.", errors: verified.errors };
		state.compaction_authorization.consumed_at = now;
		writeUnitState(unit, state, head);
		return { kind: "context", code: "request_contract_resume", message: "Reload the completed request contract and its verified completion proof before continuing." };
	}, now), now);
}

function completionFailure(unit, errors, config, client, now, context, opts) {
	const codes = [...new Set(errors)].sort();
	if (opts.recordStopFailure === false) return { kind: "block", code: "request_contract_blocked", message: `Request contract incomplete (${codes.join(", ")}). Continue autonomously and resolve the recorded obligations.`, errors: codes };
	return stopResult(unit, codes, config, client, now, context);
}

function evaluateCompletionUnlocked(unit, cwd, client, now = Date.now(), sessionId = null, opts = {}) {
	const config = loadConfig(cwd);
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const initialState = readUnitState(unit, head);
	if (initialState.terminal && initialState.terminal.status === "incomplete") return { kind: "incomplete", code: "request_contract_incomplete", message: "Request contract remains incomplete.", terminal: initialState.terminal };
	if (initialState.terminal && initialState.terminal.status === "success") {
		const verified = validateSuccessfulTerminalUnlocked(unit, cwd);
		return verified.ok
			? { kind: "allow", code: "request_contract_complete", message: "Request contract is already complete and its proof is current." }
			: { kind: "block", code: "request_contract_completion_proof_invalid", message: "Completion cannot be reported because the successful proof is no longer current.", errors: verified.errors };
	}
	if (initialState.active_mutations && Object.keys(initialState.active_mutations).length) {
		const reconciliation = reconcileOpenMutationLeases(unit, cwd, client, sessionId, now);
		if (reconciliation.foreign.length) return { kind: "block", code: "request_contract_mutation_in_flight", message: "Another bound session still owns an in-flight governed mutation." };
	}
	const initial = completionAssessment(unit, cwd, config, now);
	const stopContext = { config_digest: config.digest, workspace_digest: initial.ws.current.digest, binding_epoch: initial.binding && initial.binding.binding_epoch };
	if (initial.errors.length) return completionFailure(unit, initial.errors, config, client, now, stopContext, opts);
	if (typeof opts.beforeFinalValidation === "function") opts.beforeFinalValidation();
	const final = completionAssessment(unit, cwd, config, now);
	if (completionAssessmentDigest(final) !== completionAssessmentDigest(initial)) final.errors.push("completion_state_changed_during_finalize");
	if (final.errors.length) return completionFailure(unit, final.errors, config, client, now, { config_digest: config.digest, workspace_digest: final.ws.current.digest, binding_epoch: final.binding && final.binding.binding_epoch }, opts);
	ensureDir(unit.paths.locks);
	try {
		secureWrite(path.join(unit.paths.locks, "success.lock"), JSON.stringify({ at: now, source_head: final.head.source_head, contract_digest: final.head.contract_digest }) + "\n", { exclusive: true });
	} catch (error) {
		if (error && error.code !== "EEXIST") return completionFailure(unit, ["success_lock_failed"], config, client, now, stopContext, opts);
	}
	const successHead = requiredJson(unit.paths.head, "unit_head_corrupt");
	const state = readUnitState(unit, successHead);
	const reviewChain = verifyReviewChain(unit.paths);
	const proof = {
		version: VERSION,
		validated_at: now,
		source_head: successHead.source_head,
		contract_digest: successHead.contract_digest,
		workspace_digest: final.ws.current.digest,
		config_digest: successHead.config_digest,
		scope_epoch: successHead.scope_epoch,
		work_revision: successHead.work_revision,
		binding_epoch: final.binding.binding_epoch,
		bundle_digest: final.reviewBundle.digest,
		scope_history_head: final.scopeHistory.head.chain_head,
		review_chain_head: reviewChain.head.chain_head,
		review_record_hashes: final.reviews.clean.map((record) => record.record_hash),
		review_roles: final.reviews.clean.map((record) => record.role),
		review_stages: final.reviews.clean.map((record) => record.review_stage),
		preservation_surface_digests: final.pv.surface_digests,
	};
	proof.digest = sha256(canonicalJson(proof));
	state.terminal = { id: opaqueId("TERM-"), status: "success", at: now, completion_proof: proof };
	writeUnitState(unit, state, successHead);
	return { kind: "allow", code: "request_contract_complete", message: "Request contract and two Clean review rounds are current." };
}

function resumeIncomplete(unit, receipt, cwd, now = Date.now(), opts = {}) {
	return withUnitLock(unit, () => resumeIncompleteUnlocked(unit, receipt, cwd, now, opts), now);
}

function resumeIncompleteUnlocked(unit, receipt, cwd, now = Date.now(), opts = {}) {
	const priorHead = requiredJson(unit.paths.head, "unit_head_corrupt");
	const priorState = readUnitState(unit, priorHead);
	if (!priorState.terminal || priorState.terminal.status !== "incomplete") throw Object.assign(new Error("unit is not incomplete"), { code: "resume_state_invalid" });
	const config = loadConfig(cwd);
	if (config.digest !== priorHead.config_digest) throw Object.assign(new Error("request-contract configuration differs from genesis pin"), { code: "request_contract_config_drift" });
	const authorityKey = loadAuthorityKey(cwd, config);
	if (!authorityKey || publicKeyFingerprint(authorityKey) !== priorHead.authority_key_fingerprint) throw Object.assign(new Error("authority key differs from genesis pin"), { code: "authority_key_pin_mismatch" });
	const priorBinding = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
	const contract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
	const scope = contract ? sha256(canonicalJson(scopeProjection(contract))) : null;
	const authority = { id: `AUTH-${opaqueId()}`, operation: "resume", target_directive_ids: [], receipt };
	const presentation = authorityPresentation(authority, scope, scope, priorHead.scope_epoch + 1, (priorBinding && priorBinding.binding_epoch + 1) || 1);
	const state = JSON.parse(JSON.stringify(priorState));
	const consumed = consumeAuthorityReceipt(unit, authority, presentation, cwd, state, now, { persistPending: false });
	state.episodes = state.episodes || [];
	state.episodes.push({ terminal: state.terminal, stop: state.stop || null });
	delete state.terminal;
	state.stop = { episode_id: opaqueId("EP-"), attempt: 0, unresolved_codes: [], resumed_at: now, authority_nonce: receipt.nonce };
	const head = { ...priorHead, scope_epoch: priorHead.scope_epoch + 1, work_revision: priorHead.work_revision + 1, state_digest: stateDigest(state) };
	const binding = priorBinding ? { ...priorBinding, binding_epoch: priorBinding.binding_epoch + 1 } : null;
	const transaction = {
		version: VERSION,
		kind: "resume",
		created_at: now,
		state,
		head,
		binding,
		pending_updates: [{ name: path.basename(consumed.pendingPath), value: consumed.pending }],
	};
	secureJson(transactionPath(unit, "resume"), transaction, { exclusive: true });
	if (opts.afterTransactionPrepared) opts.afterTransactionPrepared(transaction);
	applyResumeTransaction(unit, transaction);
	unit.head = head;
	return { episode_id: state.stop.episode_id, scope_epoch: head.scope_epoch };
}

function cleanupConsumedQuarantines(cwd, unitId) {
	try {
		for (const entry of fs.readdirSync(quarantineRoot(cwd), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(quarantineRoot(cwd), entry.name);
			const qhead = readJson(path.join(dir, "head.json"));
			if (qhead && qhead.consumed === true && qhead.consumed_by_unit === unitId) durableRemoveTree(dir);
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

function compactionReceipt(unit, head, state, reviewHead) {
	const terminal = state && state.terminal;
	return {
		version: VERSION,
		receipt_id: head.compaction_receipt_id,
		status: terminal && terminal.status,
		started_at: head.created_at,
		terminal_at: terminal && terminal.at,
		compacted_at: head.compaction_started_at,
		source_count: head.source_count || 0,
		change_count: (state.occurrences || []).length,
		review_count: (reviewHead && reviewHead.count) || 0,
	};
}

function validateCompactionReceipt(receipt, expected) {
	const keys = ["change_count", "compacted_at", "receipt_id", "review_count", "source_count", "started_at", "status", "terminal_at", "version"];
	if (!receipt || canonicalJson(Object.keys(receipt).sort()) !== canonicalJson(keys)) return false;
	if (!/^RCPT-[a-f0-9]{32}$/.test(receipt.receipt_id || "") || receipt.status !== "success" || receipt.version !== VERSION) return false;
	for (const key of ["change_count", "review_count", "source_count"]) if (!Number.isInteger(receipt[key]) || receipt[key] < 0) return false;
	for (const key of ["compacted_at", "started_at", "terminal_at"]) if (!Number.isFinite(receipt[key])) return false;
	return canonicalJson(receipt) === canonicalJson(expected);
}

function cleanupCompactionStaging(cwd) {
	const unitsDir = path.join(harnessRoot(cwd), "units");
	let entries;
	try {
		entries = fs.readdirSync(unitsDir, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw Object.assign(new Error("request-contract unit storage cannot be read"), { code: "unit_storage_unreadable", cause: error });
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const match = entry.name.match(/^([a-f0-9]{32})\.compacted\.(RCPT-[a-f0-9]{32})$/);
		if (!match) continue;
		const [, unitId, receiptId] = match;
		const stagedDir = path.join(unitsDir, entry.name);
		const unit = { id: unitId, paths: unitPaths(cwd, unitId, stagedDir) };
		recoverUnitTransactions(unit);
		const head = requiredJson(unit.paths.head, "unit_head_corrupt");
		const state = readUnitState(unit, head);
		const reviewHead = optionalJson(unit.paths.reviewHead, { count: 0 }, "review_head_corrupt");
		const receipt = requiredJson(path.join(harnessRoot(cwd), "receipts-v2", `${receiptId}.json`), "compaction_receipt_corrupt");
		const expected = compactionReceipt(unit, head, state, reviewHead);
		if (head.lifecycle !== "compacting" || head.compaction_receipt_id !== receiptId || !validateCompactionReceipt(receipt, expected)) throw Object.assign(new Error("compaction staging has no exactly bound durable receipt"), { code: "compaction_staging_orphan" });
		const proof = validateSuccessfulTerminalUnlocked(unit, cwd, { allowHandoff: true });
		if (!proof.ok) throw Object.assign(new Error(proof.errors.join(", ")), { code: "completion_proof_invalid", errors: proof.errors });
		cleanupConsumedQuarantines(cwd, unitId);
		durableRemoveTree(stagedDir);
	}
}

function compactExpiredUnits(cwd, now = Date.now(), opts = {}) {
	return withRepositoryLock(cwd, () => {
		cleanupCompactionStaging(cwd);
		const config = loadConfig(cwd);
		const compacted = [];
		for (const id of listUnits(cwd)) {
		const paths = unitPaths(cwd, id);
		const unit = { id, paths };
		const result = withUnitLock(unit, () => {
			const head = requiredJson(paths.head, "unit_head_corrupt");
			const state = readUnitState(unit, head);
			const terminal = state.terminal;
			if (!terminal || terminal.status !== "success") return null;
				const proof = validateSuccessfulTerminalUnlocked(unit, cwd, { allowHandoff: true });
				if (!proof.ok) throw Object.assign(new Error(proof.errors.join(", ")), { code: "completion_proof_invalid", errors: proof.errors });
			const hours = config.retention.success_hours;
			if (now - terminal.at < hours * 60 * 60 * 1000) return null;
			head.lifecycle = "compacting";
			head.compaction_started_at = head.compaction_started_at || now;
			head.compaction_receipt_id = head.compaction_receipt_id || opaqueId("RCPT-");
			secureJson(paths.head, head);
			cleanupExpiredReviewInvocations(unit, now);
			const reviewHead = optionalJson(paths.reviewHead, { count: 0 }, "review_head_corrupt");
			const receiptId = head.compaction_receipt_id;
			const receipt = compactionReceipt(unit, head, state, reviewHead);
			const out = path.join(harnessRoot(cwd), "receipts-v2", `${receiptId}.json`);
			const existingReceipt = readJson(out);
			if (existingReceipt && !validateCompactionReceipt(existingReceipt, receipt)) throw Object.assign(new Error("compaction receipt conflict"), { code: "compaction_receipt_conflict" });
			if (!existingReceipt) secureJson(out, receipt, { exclusive: true });
			if (opts.afterReceiptWritten) opts.afterReceiptWritten({ receipt: out, receiptId });
			const finalProof = validateSuccessfulTerminalUnlocked(unit, cwd, { allowHandoff: true });
			if (!finalProof.ok) throw Object.assign(new Error(finalProof.errors.join(", ")), { code: "completion_proof_invalid", errors: finalProof.errors });
			const stagedUnit = `${paths.unit}.compacted.${receiptId}`;
			durableRename(paths.unit, stagedUnit);
			if (opts.afterUnitStaged) opts.afterUnitStaged({ stagedUnit, receipt: out, receiptId });
			cleanupConsumedQuarantines(cwd, id);
			durableRemoveTree(stagedUnit);
			return { receipt_id: receiptId };
		}, now);
			if (result) compacted.push(result);
		}
		return compacted;
	}, now);
}

function safeShellWords(command) {
	if (typeof command !== "string" || !command.trim() || /[\r\n;|&<>`$(){}]/.test(command)) return null;
	const words = [];
	let word = "";
	let quote = null;
	let escaped = false;
	let active = false;
	for (const char of command) {
		if (escaped) {
			word += char;
			escaped = false;
			active = true;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			active = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			else word += char;
			active = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			active = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (active) words.push(word);
			word = "";
			active = false;
			continue;
		}
		word += char;
		active = true;
	}
	if (escaped || quote) return null;
	if (active) words.push(word);
	return words;
}

function exactFlagMap(words) {
	const out = new Map();
	for (let index = 0; index < words.length; index += 2) {
		const flag = words[index];
		const value = words[index + 1];
		if (!/^--[a-z-]+$/.test(flag || "") || value == null || value.startsWith("--") || out.has(flag)) return null;
		out.set(flag, value);
	}
	return out;
}

function trustedNodeWord(word, cwd) {
	try {
		const expected = fs.realpathSync(process.execPath);
		if (path.isAbsolute(word)) return fs.realpathSync(word) === expected;
		if (word.includes("/")) return fs.realpathSync(path.resolve(cwd, word)) === expected;
		if (word !== "node") return false;
		const searchPath = process.env.PATH || process.env.Path || "";
		const extensions = process.platform === "win32"
			? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
			: [""];
		for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
			for (const extension of extensions) {
				const candidate = path.join(directory.replace(/^"|"$/g, ""), `${word}${extension.toLowerCase()}`);
				if (!fs.existsSync(candidate)) continue;
				return fs.realpathSync(candidate) === expected;
			}
		}
		return false;
	} catch {
		return false;
	}
}

function exactScriptWord(word, expected, cwd) {
	try {
		return fs.realpathSync(path.resolve(cwd, word)) === fs.realpathSync(expected);
	} catch {
		return false;
	}
}

function governedControlCommand(event, cwd, unit) {
	if (!unit || event.toolName !== "Bash") return false;
	const words = safeShellWords(event.toolInput && event.toolInput.command);
	if (!words || words.length < 3 || !trustedNodeWord(words[0], cwd)) return false;
	const operatorScript = path.join(cwd, "scripts", "request-contract.cjs");
	if (exactScriptWord(words[1], operatorScript, cwd)) {
		const command = words[2];
		const flags = exactFlagMap(words.slice(3));
		if (!flags) return false;
		const only = (...names) => flags.size === names.length && names.every((name) => flags.has(name));
		if (command === "status") return flags.size === 0 || (only("--unit") && flags.get("--unit") === unit.id);
		if (command === "compact") return flags.size === 0;
		if (command === "join-session") {
			const required = ["--unit", "--client", "--session"];
			const optional = "--client-version";
			if (![required.length, required.length + 1].includes(flags.size) || required.some((name) => !flags.has(name))) return false;
			if (flags.size === required.length + 1 && !flags.has(optional)) return false;
			return flags.get("--unit") === unit.id && ["claude", "codex"].includes(flags.get("--client")) && Boolean(flags.get("--session"));
		}
		if (command === "authority-challenge") return only("--unit", "--file") && flags.get("--unit") === unit.id && path.resolve(cwd, flags.get("--file")) === controlInputPath(unit, "authority");
		if (command === "bind") return only("--unit", "--file") && flags.get("--unit") === unit.id && path.resolve(cwd, flags.get("--file")) === controlInputPath(unit, "contract");
		if (command === "resume") return only("--unit", "--file") && flags.get("--unit") === unit.id && path.resolve(cwd, flags.get("--file")) === controlInputPath(unit, "resume");
		if (command === "review-challenge") return only("--unit", "--writer-session") && flags.get("--unit") === unit.id && flags.get("--writer-session") === event.sessionId;
		return false;
	}
	const reviewScript = path.join(cwd, "scripts", "request-contract-review-runner.cjs");
	if (!exactScriptWord(words[1], reviewScript, cwd)) return false;
	const flags = exactFlagMap(words.slice(2));
	const required = ["--cwd", "--unit", "--writer-session", "--reviewer", "--reviewer-attestor", "--runner-attestor"];
	if (!flags || flags.size !== required.length || required.some((name) => !flags.has(name))) return false;
	if (path.resolve(cwd, flags.get("--cwd")) !== cwd || flags.get("--unit") !== unit.id || flags.get("--writer-session") !== event.sessionId) return false;
	const config = loadConfig(cwd);
	try {
		const reviewerDigest = sha256(fs.readFileSync(path.resolve(cwd, flags.get("--reviewer"))));
		const reviewerAttestorDigest = sha256(fs.readFileSync(path.resolve(cwd, flags.get("--reviewer-attestor"))));
		const runnerAttestorDigest = sha256(fs.readFileSync(path.resolve(cwd, flags.get("--runner-attestor"))));
		return config.review_runner.allowed_reviewer_digests.includes(reviewerDigest)
			&& config.reviewer.allowed_attestor_digests.includes(reviewerAttestorDigest)
			&& config.review_runner.allowed_attestor_digests.includes(runnerAttestorDigest);
	} catch {
		return false;
	}
}

function governedApplyPatchControlInput(event, cwd, unit) {
	if (!unit || event.toolName !== "apply_patch") return false;
	const patch = event.toolInput && event.toolInput.command;
	if (typeof patch !== "string" || patch.includes("\0")) return false;
	const lines = patch.replace(/\r\n/g, "\n").split("\n");
	while (lines.at(-1) === "") lines.pop();
	if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return false;
	const sections = [];
	for (let index = 1; index < lines.length - 1; index++) {
		const line = lines[index];
		const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
		if (header) sections.push({ operation: header[1], file: header[2] });
		else if (line.startsWith("*** Move to:") || line === "*** Begin Patch" || line === "*** End Patch") return false;
	}
	if (sections.length !== 1 || !["Add", "Update"].includes(sections[0].operation)) return false;
	const candidate = sections[0].file;
	if (!candidate || path.isAbsolute(candidate)) return false;
	const absolute = path.resolve(cwd, candidate);
	return Object.keys(CONTROL_INPUT_NAMES).some((kind) => absolute === controlInputPath(unit, kind));
}

function governedControlInput(event, cwd, unit) {
	if (governedApplyPatchControlInput(event, cwd, unit)) return true;
	if (!unit || !["Write", "Edit"].includes(event.toolName)) return false;
	const candidate = event.toolInput && (event.toolInput.file_path || event.toolInput.path);
	if (!candidate) return false;
	const absolute = path.resolve(cwd, candidate);
	return Object.keys(CONTROL_INPUT_NAMES).some((kind) => absolute === controlInputPath(unit, kind));
}

function governedControlEvent(event, cwd, unit) {
	return governedControlCommand(event, cwd, unit) || governedControlInput(event, cwd, unit);
}

function configuredShellTools(config = null) {
	const configured = config && config.release && Array.isArray(config.release.shell_tools)
		? config.release.shell_tools
		: [];
	return [...new Set(["Bash", "shell_command", ...configured])];
}

function isShellTool(event, config = null) {
	return configuredShellTools(config).includes(String(event.toolName || ""));
}

function mutationFromEvent(event, cwd = null, unit = null, config = null) {
	if (cwd && governedControlEvent(event, cwd, unit)) return false;
	const tool = String(event.toolName || "");
	if (["Edit", "Write", "NotebookEdit", "apply_patch"].includes(tool)) return true;
	if (isShellTool(event, config)) return true;
	return false;
}

function releaseCommandFromEvent(event, config = null) {
	if (!isShellTool(event, config)) return false;
	const command = String(event.toolInput && event.toolInput.command || "");
	const segments = command.split(/[\r\n;&|]+/).map((part) => part.trim()).filter(Boolean);
	const builtins = [
		/(?:^|[\s"'])(?:(?:[A-Za-z]:\\|\/)[^\s"']*[\\/])?git(?:\.exe)?(?:\s+(?:-C|--git-dir|--work-tree)\s+\S+|\s+--[^\s=]+(?:=\S+)?)*\s+(?:push|merge)\b/i,
		/(?:^|[\s"'])gh(?:\.exe)?\s+(?:pr\s+merge|release\s+create|issue\s+close)\b/i,
		/(?:^|[\s"'])(?:npm|pnpm|yarn)(?:\.cmd|\.exe)?\s+(?:run\s+)?(?:publish|deploy)\b/i,
		/(?:^|[\s"'])docker(?:\.exe)?\s+(?:push|compose\s+up)\b/i,
		/(?:^|[\s"'])az(?:\.cmd|\.exe)?\s+(?:[^\r\n;&|]+\s+)?(?:deploy(?:ment)?|up)\b/i,
		/(?:^|[\s"'])kubectl(?:\.exe)?\s+(?:apply|create|delete|patch|replace|rollout)\b/i,
		/(?:^|[\s"'])helm(?:\.exe)?\s+(?:install|upgrade|uninstall)\b/i,
		/(?:^|[\s"'])terraform(?:\.exe)?\s+(?:apply|destroy|import)\b/i,
		/(?:^|[\s"'])gcloud(?:\.cmd|\.exe)?\s+[^\r\n;&|]*\bdeploy\b/i,
		/(?:^|[\s"'])aws(?:\.cmd|\.exe)?\s+[^\r\n;&|]*(?:deploy|update|create|delete|put-)\b/i,
		/(?:^|[\s"'])vercel(?:\.cmd|\.exe)?\b[^\r\n;&|]*\s--prod\b/i,
		/(?:^|[\s"'])(?:scp|rsync)(?:\.exe)?\s+/i,
	];
	const custom = config && config.release ? config.release.command_patterns.map((pattern) => new RegExp(pattern, "i")) : [];
	return segments.some((segment) => {
		if (/^(?:echo|printf|write-output|select-string|grep|rg)\b/i.test(segment)) return false;
		return [...builtins, ...custom].some((pattern) => pattern.test(segment));
	});
}

function mutationLeaseId(event) {
	const nativeId = String(event.toolUseId || "");
	return nativeId || `session:${event.client || "unknown"}:${event.sessionId || "no-session"}`;
}

function semanticVersion(value) {
	const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
	return match ? match.slice(1).map(Number) : null;
}

function clientVersionSupported(actual, range) {
	const current = semanticVersion(actual);
	const minimum = semanticVersion(range);
	if (!current || !minimum) return false;
	for (let index = 0; index < 3; index++) {
		if (current[index] > minimum[index]) return true;
		if (current[index] < minimum[index]) return false;
	}
	return true;
}

function clientRegistrySupports(cwd, client) {
	const config = loadConfig(cwd);
	const file = client === "claude" ? path.join(cwd, ".claude", "settings.json") : client === "codex" ? path.join(cwd, ".codex", "hooks.json") : null;
	if (!file) return false;
	const registry = readJson(file);
	if (!registry || !registry.hooks || typeof registry.hooks !== "object") return false;
	const adapterPath = client === "claude" ? ".claude/hooks/request-contract.js" : ".codex/hooks/request-contract.cjs";
	const preToolMatcher = [...new Set([...configuredShellTools(config), "Edit", "Write", "NotebookEdit", "apply_patch"])].join("|");
	const seen = [];
	for (const [registeredEvent, entries] of Object.entries(registry.hooks)) {
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
			const registrationText = [hook.command, hook.commandWindows, ...(Array.isArray(hook.args) ? hook.args : [])]
				.filter((value) => typeof value === "string");
			if (!registrationText.some((value) => value.includes(adapterPath))) continue;
			seen.push({ registeredEvent, entry, hook });
		}
	}
	if (seen.length !== REQUIRED_CLIENT_EVENTS.length) return false;
	return REQUIRED_CLIENT_EVENTS.every((eventName) => {
		const matches = seen.filter((candidate) => candidate.registeredEvent === eventName);
		if (matches.length !== 1) return false;
		const { entry, hook } = matches[0];
		if (hook.type !== "command") return false;
		if (client === "claude") {
			const expected = `node \"$CLAUDE_PROJECT_DIR/${adapterPath}\" ${eventName}`;
			if (hook.command !== expected || hook.commandWindows != null || hook.args != null) return false;
		} else {
			const expected = `root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0; registry=\"$root/.codex/hooks.json\"; [ ! -f \"$registry\" ] && exit 0; hook=\"$root/${adapterPath}\"; if [ ! -f \"$hook\" ]; then echo \"Configured Codex hook is missing: $hook\" >&2; exit 1; fi; node \"$hook\" ${eventName}`;
			const expectedWindows = `powershell -NoProfile -Command '$root=git rev-parse --show-toplevel 2>$null; if ($LASTEXITCODE -ne 0 -or -not $root) { exit 0 }; $registry=Join-Path $root.Trim() \".codex/hooks.json\"; if (-not (Test-Path -LiteralPath $registry)) { exit 0 }; $hook=Join-Path $root.Trim() \"${adapterPath}\"; if (-not (Test-Path -LiteralPath $hook)) { Write-Error \"Configured Codex hook is missing: $hook\"; exit 1 }; node $hook ${eventName}'`;
			if (hook.command !== expected || hook.commandWindows !== expectedWindows) return false;
		}
		if (eventName === "PreToolUse") return entry.matcher === preToolMatcher;
		return entry.matcher == null || entry.matcher === "";
	});
}

function assertSupportedClient(cwd, client, version) {
	const config = loadConfig(cwd);
	const range = config.supported_clients[client];
	if (!range || !clientVersionSupported(version, range)) throw Object.assign(new Error(`unsupported ${client} version`), { code: "request_contract_client_version_unsupported" });
	if (!clientRegistrySupports(cwd, client)) throw Object.assign(new Error(`${client} lacks required request-contract lifecycle events`), { code: "request_contract_client_capability_missing" });
	return true;
}

function handleEvent(event, opts = {}) {
	const cwd = event.cwd || process.cwd();
	const client = event.client || "unknown";
	const sessionId = event.sessionId || "no-session";
	const now = opts.now || Date.now();
	const config = loadConfig(cwd);
	if (config.errors.length) return { kind: "block", code: "request_contract_config_invalid", message: "Request-contract configuration is missing or invalid.", errors: config.errors };
	if (!governed(cwd, opts.env || process.env)) return { kind: "allow", code: "request_contract_disabled" };
	let unit = findUnit(cwd, client, sessionId);
	if (unit && unit.error) {
		if (event.eventName === "UserPromptSubmit") {
			const q = appendQuarantine(cwd, client, sessionId, event.prompt || "", now, event.origin);
			return { kind: "block", code: unit.error, message: `Prompt preserved in quarantine (${q.quarantineId}) because multiple runtime units claim this session.` };
		}
		return { kind: "block", code: unit.error, message: "Multiple runtime units claim this session." };
	}

	if (event.eventName === "SessionStart") {
		try {
			assertSupportedClient(cwd, client, event.clientVersion);
			if (unit) {
				const terminal = readUnitState(unit).terminal;
				if (terminal && terminal.status === "success") {
					const current = evaluateCompletion(unit, cwd, client, now, sessionId);
					if (current.kind !== "allow") return current;
					return { kind: "context", code: "request_contract_complete", message: "This request lineage is already complete; start a new session for a new request." };
				}
			}
			return withRepositoryLock(cwd, () => {
				unit = findUnit(cwd, client, sessionId);
				if (unit && unit.error) throw Object.assign(new Error("duplicate runtime binding"), { code: unit.error });
				if (!unit) {
					// A new session always starts a distinct lineage. Joining an existing
					// unit is an explicit operator action through addSessionBinding/CLI.
					unit = createGenesisUnlocked(cwd, client, sessionId, now, { adoptQuarantine: true, clientVersion: event.clientVersion, hostProcessId: event.hostProcessId || process.pid, hostProcessIdentity: event.hostProcessIdentity || processIdentity(event.hostProcessId || process.pid) });
				} else {
					unit = addSessionBinding(unit, client, sessionId, event.clientVersion, event.hostProcessId || process.pid, event.hostProcessIdentity || processIdentity(event.hostProcessId || process.pid));
					adoptQuarantine(unit, cwd, now);
				}
				return { kind: "context", code: "request_contract_genesis", message: `Governed request-contract session active (unit ${unit.id}). Every prompt and change must remain traceable.` };
			}, now);
		} catch (e) {
			return { kind: "block", code: e.code || "request_contract_genesis_failed", message: "Governed session cannot start until quarantined sources are resolved." };
		}
	}

	if (event.eventName === "UserPromptSubmit") {
		if (!unit) {
			const q = appendQuarantine(cwd, client, sessionId, event.prompt || "", now, event.origin);
			return { kind: "block", code: "request_contract_missing_genesis", message: `Prompt preserved in quarantine (${q.quarantineId}); start a governed session and import the complete chain.` };
		}
		try {
			const record = appendSource(unit, event.prompt || "", event.origin || "ambiguous", now);
			return { kind: "context", code: "request_contract_source_captured", message: `Captured ${record.source_id}. Bind and classify every source before completion.` };
		} catch (error) {
			const q = appendQuarantine(cwd, client, sessionId, event.prompt || "", now, event.origin);
			return { kind: "block", code: error.code || "request_contract_source_capture_failed", message: `Prompt preserved in quarantine (${q.quarantineId}) because the active lineage is not writable.` };
		}
	}

	if (!unit) {
		return { kind: "block", code: "request_contract_missing_genesis", message: "Governed session has no genesis/source chain; mutations and lifecycle continuation are denied." };
	}
	if (event.eventName === "PreToolUse") {
		if (releaseCommandFromEvent(event, config)) {
			return { kind: "block", code: "external_effect_gate_pending", message: "Publication is denied until the signed project external-effect adapter gate is implemented and provisioned." };
		}
		const pretoolContract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
		if ((config.preservation.required || pretoolContract && pretoolContract.preservation) && isShellTool(event, config)) {
			return { kind: "block", code: "external_effect_gate_pending", message: "Shell execution is denied for preservation work until the signed project external-effect adapter gate is implemented and provisioned." };
		}
		if (!mutationFromEvent(event, cwd, unit, config)) return { kind: "allow", code: governedControlEvent(event, cwd, unit) ? "request_contract_control_preflight" : "request_contract_pretool_read_only" };
		try {
			withUnitLock(unit, () => {
				assertUnitMutable(unit);
				const head = requiredJson(unit.paths.head, "unit_head_corrupt");
				const binding = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
				const contract = optionalJson(unit.paths.contract, null, "contract_state_corrupt");
				if (!binding || binding.state !== "active" || !contract || binding.contract_id !== contract.id) throw Object.assign(new Error("mutation requires an active request-contract binding"), { code: "request_contract_unbound" });
				if (contractDigest(contract) !== head.contract_digest) throw Object.assign(new Error("bound contract digest differs from the active head"), { code: "request_contract_binding_stale" });
				const scopeHistory = verifyScopeHistory(unit);
				if (!scopeHistory.ok || !scopeHistory.records.length || scopeHistory.records.at(-1).contract_digest !== head.contract_digest) throw Object.assign(new Error("bound scope history is stale"), { code: "request_contract_binding_stale" });
				const sourceChain = verifySourceChain(unit.paths, head);
				if (!sourceChain.ok) throw Object.assign(new Error(sourceChain.errors.join(", ")), { code: "source_log_corrupt" });
				const classified = new Map((contract.sources || []).map((source) => [source.id, source]));
				if (classified.size !== sourceChain.records.length) throw Object.assign(new Error("classified source set differs from the source chain"), { code: "request_contract_source_unclassified" });
				for (const source of sourceChain.records) {
					const declaration = classified.get(source.source_id);
					if (!declaration || !CLASSIFICATIONS.has(declaration.classification)) throw Object.assign(new Error("every source must be classified before mutation"), { code: "request_contract_source_unclassified" });
				}
				if (config.preservation.required || contract.preservation) {
					const seal = planningSeal(unit, config, binding, head, contract);
					if (!seal.ok) throw Object.assign(new Error("implementation mutation requires a current planning×4 seal"), { code: "request_contract_planning_review_required", errors: seal.errors });
				}
				const state = readUnitState(unit, head);
				state.active_mutations = state.active_mutations || {};
				const leaseId = mutationLeaseId(event);
				const existingLease = state.active_mutations[leaseId];
				if (existingLease && (existingLease.client !== client || existingLease.session_id !== sessionId || existingLease.tool_name !== event.toolName)) throw Object.assign(new Error("mutation lease identifier conflicts with an in-flight tool"), { code: "request_contract_mutation_lease_conflict" });
				if (!existingLease) {
					state.active_mutations[leaseId] = { client, session_id: sessionId, tool_name: event.toolName, opened_at: now };
					head.work_revision += 1;
					writeUnitState(unit, state, head);
				}
			}, now);
			return { kind: "allow", code: "request_contract_mutation_preflight" };
		} catch (error) {
			return { kind: "block", code: error.code || "request_contract_mutation_denied", message: "Governed mutation denied before execution because the request lineage is not writable." };
		}
	}

	if (event.eventName === "PostToolUse") {
		if (!mutationFromEvent(event, cwd, unit, config)) return { kind: "allow", code: governedControlEvent(event, cwd, unit) ? "request_contract_control_complete" : "request_contract_posttool_read_only" };
		try {
			return withUnitLock(unit, () => {
				const state = readUnitState(unit);
				state.active_mutations = state.active_mutations || {};
				const leaseId = mutationLeaseId(event);
				const lease = state.active_mutations[leaseId];
				if (!lease || lease.client !== client || lease.session_id !== sessionId || lease.tool_name !== event.toolName) throw Object.assign(new Error("PostToolUse has no matching mutation lease"), { code: "request_contract_mutation_lease_missing" });
				if (state.terminal && state.terminal.status === "success") assertUnitMutable(unit);
				const before = state.occurrences.length;
				const captured = captureWorkspaceOccurrences(unit, cwd, { allowTerminalIncompleteLease: leaseId });
				const nextHead = requiredJson(unit.paths.head, "unit_head_corrupt");
				const nextState = readUnitState(unit, nextHead);
				delete nextState.active_mutations[leaseId];
				writeUnitState(unit, nextState, nextHead);
				const added = captured.occurrences.slice(before);
				return added.length ? { kind: "context", code: "request_contract_change_captured", message: `Captured ${added.length} workspace change occurrence(s); map each to directive, implementation, and evidence.` } : { kind: "allow", code: "request_contract_change_known" };
			}, now);
		} catch (error) {
			return { kind: "block", code: error.code || "request_contract_mutation_lease_failed", message: "Governed mutation completion could not be matched to an active pre-execution lease." };
		}
	}

	if (event.eventName === "PreCompact") return evaluatePreCompact(unit, cwd, client, now, sessionId);
	if (event.eventName === "PostCompact") return evaluatePostCompact(unit, cwd, client, now, sessionId);
	if (event.eventName === "SessionStart") return { kind: "context", code: "request_contract_resume", message: "Reload the bound request contract, complete source history, and current evidence before continuing." };
	if (event.eventName === "Stop") return evaluateCompletion(unit, cwd, client, now, sessionId);
	return { kind: "allow", code: "request_contract_event_ignored" };
}

function canonicalParityProjection(value) {
	function project(v, key = "") {
		if (Array.isArray(v)) return v.map((x) => project(x, key));
		if (v && typeof v === "object") {
			const out = {};
			const cryptographicFields = [];
			for (const k of Object.keys(v).sort()) {
				if (k === "client_versions") out[k] = { "<client>": "<version>" };
				else if (["client", "session_id", "sessionId", "event_id", "ts", "at"].includes(k) || /(_at|_time)$/.test(k)) out[k] = `<${k}>`;
				else if (/(^|_)(hash|digest|head|signature|fingerprint)$/.test(k)) cryptographicFields.push(k);
				else out[k] = project(v[k], k);
			}
			for (const cryptoField of cryptographicFields) {
				if (cryptoField.endsWith("signature")) out[cryptoField] = "<verified-signature>";
				else if (cryptoField.endsWith("fingerprint")) out[cryptoField] = "<verified-fingerprint>";
				else out[cryptoField] = `recomputed:${sha256(canonicalJson({ field: cryptoField, dependencies: out }))}`;
			}
			return out;
		}
		if (["unit_id", "run_id", "receipt_id", "execution_id"].includes(key) || /_session_ids?$/.test(key) || /(^|_)process_(id|ids|identity|identities)$/.test(key) || /^host_process_(ids|identities)$/.test(key)) return `<${key}>`;
		if (key === "private_bundle_path") return "<private-bundle-path>";
		if (typeof v === "string") {
			if (["scopeVersionMappings", "covered_scope_version_mappings"].includes(key)) {
				try {
					return canonicalJson(project(JSON.parse(v)));
				} catch {
					return "<invalid-scope-version-mapping>";
				}
			}
			return v
				.replace(/\b(SRC|CHG|EP|TERM|RCPT|OBL)-[a-f0-9]{32}\b/gi, (_m, prefix) => `<opaque-${prefix.toLowerCase()}>`)
				.replace(/\b[a-f0-9]{64}\b/g, "<opaque-digest>")
				.replace(/\b[a-f0-9]{32}\b/g, "<opaque-id>");
		}
		return v;
	}
	return project(value);
}

module.exports = {
	VERSION,
	DIR_MODE,
	FILE_MODE,
	TRACE_KEYS,
	TRACE_EDGES,
	sha256,
	opaqueId,
	canonicalize,
	canonicalJson,
	secureWrite,
	secureJson,
	durableUnlink,
	stateDigest,
	processIdentity,
	readUnitState,
	writeUnitState,
	appendJsonl,
	readJson,
	readJsonl,
	loadConfig,
	loadAuthorityKey,
	loadReviewerKey,
	loadReviewRunnerKey,
	governed,
	hasStickyGovernanceState,
	harnessRoot,
	unitPaths,
	controlInputPath,
	withDirectoryLock,
	withUnitLock,
	listUnits,
	findUnit,
	unresolvedUnits,
	addSessionBinding,
	referenceManifest,
	workspaceManifest,
	diffManifests,
	listUnconsumedQuarantine,
	appendQuarantine,
	createGenesis,
	adoptQuarantine,
	verifySourceChain,
	appendSource,
	contractDigest,
	scopeProjection,
	directiveDisposedScopeIds,
	validateAuthorityReceipt,
	authorityPresentation,
	issueAuthorityChallenge,
	validateContract,
	validatePreservationDeclaration: preservationPolicy.validateDeclaration,
	validateWorkspacePreservation: preservationPolicy.validateWorkspace,
	preservationSurfaceDiffDigest: preservationPolicy.surfaceDiffDigest,
	preservationSurfaceContentDigest: preservationPolicy.surfaceContentDigest,
	preservationSurfaceInventoryDigest: preservationPolicy.surfaceInventoryDigest,
	preservationVendorTreeDigest: preservationPolicy.vendorTreeDigest,
	signedProbePayload: preservationPolicy.signedProbePayload,
	signedVendorPayload: preservationPolicy.signedVendorPayload,
	signedInventoryPayload: preservationPolicy.signedInventoryPayload,
	bindContract,
	appendScopeVersion,
	verifyScopeHistory,
	contractCoverageProjection,
	contractCoverageIds,
	buildReviewBundle,
	reviewSignaturePayload,
	isolationSignaturePayload,
	issueReviewInvocation,
	observeOccurrence,
	captureWorkspaceOccurrences,
	verifyReviewChain,
	appendReview,
	evaluateReviews,
	releaseCommandFromEvent,
	evaluateCompletion,
	resumeIncomplete,
	compactExpiredUnits,
	governedControlEvent,
	isShellTool,
	mutationFromEvent,
	releaseCommandFromEvent,
	clientRegistrySupports,
	assertSupportedClient,
	handleEvent,
	canonicalParityProjection,
};
