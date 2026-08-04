"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_OUTPUT = 1024 * 1024;
const LIVE_RUNS = new WeakSet();
const LIVE_RESULTS = new WeakMap();
const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
	return value;
}

function canonicalJson(value) {
	return JSON.stringify(canonicalize(value));
}

function sha256(value) {
	return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

function regularFile(file) {
	try {
		const stat = fs.lstatSync(file);
		return path.isAbsolute(file) && stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function assertDigestAllowed(file, allowed, code) {
	if (!regularFile(file)) throw Object.assign(new Error("trusted executable must be an absolute regular file"), { code: `${code}_invalid` });
	const digest = sha256(fs.readFileSync(file));
	if (!Array.isArray(allowed) || !allowed.includes(digest)) throw Object.assign(new Error("trusted executable is not pinned"), { code: `${code}_not_allowed` });
	return digest;
}

function nativeRuntimeMounts() {
	const mounts = ["/usr", "/lib", "/lib64"].filter((entry) => fs.existsSync(entry));
	for (const candidate of ["/var/home/linuxbrew/.linuxbrew", "/home/linuxbrew/.linuxbrew"]) if (fs.existsSync(candidate)) mounts.push(candidate);
	return [...new Set(mounts)];
}

function linuxSandbox(options) {
	const sandbox = options.sandboxExecutable || "/usr/bin/bwrap";
	const sandboxDigest = assertDigestAllowed(sandbox, options.allowedSandboxDigests, "preservation_sandbox");
	const args = ["--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-pid", "--die-with-parent", "--new-session", "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/scratch", "--tmpfs", "/home", "--dir", "/home/linuxbrew"];
	for (const mount of nativeRuntimeMounts()) args.push("--ro-bind", mount, mount);
	args.push(
		"--dir", "/preservation",
		"--ro-bind", options.subjectRoot, "/subject",
		"--ro-bind", options.adapterPath, "/preservation/adapter.cjs",
		"--setenv", "HOME", "/home", "--setenv", "TMPDIR", "/scratch", "--setenv", "PATH", "/usr/bin:/bin",
	);
	for (const [key, value] of Object.entries(options.env || {}).sort(([a], [b]) => a.localeCompare(b))) args.push("--setenv", key, value);
	args.push("--chdir", options.cwd || "/subject", options.executable, ...options.argv);
	const startedAt = Date.now();
	const result = cp.spawnSync(sandbox, args, {
		encoding: "utf8",
		env: { PATH: "/usr/bin:/bin" },
		input: options.stdin || "",
		maxBuffer: MAX_OUTPUT,
		timeout: options.timeoutMs || 30_000,
		killSignal: "SIGKILL",
	});
	return { result, sandboxDigest, startedAt, finishedAt: Date.now(), profileDigest: sha256(canonicalJson(args.slice(0, args.indexOf("--chdir")))) };
}

function executeSandboxed(options) {
	if (process.platform !== "linux") throw Object.assign(new Error("no sealed preservation runner is provisioned for this platform"), { code: "preservation_platform_review_only" });
	return linuxSandbox(options);
}

function checkedResult(envelope, label) {
	const { result } = envelope;
	if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code === "ETIMEDOUT" ? `${label}_timeout` : `${label}_spawn_failed` });
	if (Buffer.byteLength(result.stdout || "") > MAX_OUTPUT || Buffer.byteLength(result.stderr || "") > MAX_OUTPUT) throw Object.assign(new Error("preservation runner output exceeds limit"), { code: `${label}_output_too_large` });
	return result;
}

function adapterCall(context, action, input) {
	const envelope = executeSandboxed({
		sandboxExecutable: context.sandboxExecutable,
		allowedSandboxDigests: context.allowedSandboxDigests,
		subjectRoot: context.subjectRoot,
		adapterPath: context.adapterSnapshot,
		executable: context.nodeExecutable,
		argv: ["/preservation/adapter.cjs", action],
		stdin: `${canonicalJson(input)}\n`,
		timeoutMs: context.timeoutMs,
	});
	const result = checkedResult(envelope, "preservation_adapter");
	if (result.status !== 0 || result.signal) throw Object.assign(new Error("preservation adapter failed"), { code: "preservation_adapter_failed" });
	let parsed;
	try { parsed = JSON.parse(result.stdout || ""); } catch { throw Object.assign(new Error("preservation adapter output is invalid"), { code: "preservation_adapter_output_invalid" }); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Object.assign(new Error("preservation adapter output is invalid"), { code: "preservation_adapter_output_invalid" });
	return parsed;
}

function validCommand(command) {
	return Boolean(command && typeof command.executable === "string" && path.isAbsolute(command.executable) && Array.isArray(command.argv) && command.argv.every((value) => typeof value === "string") && ["/subject", "/scratch"].some((root) => command.cwd === root || command.cwd.startsWith(`${root}/`)) && command.env && typeof command.env === "object" && !Array.isArray(command.env) && Object.keys(command.env).every((key) => /^[A-Z][A-Z0-9_]{0,63}$/.test(key)) && Object.values(command.env).every((value) => typeof value === "string") && typeof command.stdin === "string" && Number.isInteger(command.timeout_ms) && command.timeout_ms >= 1 && command.timeout_ms <= 120_000);
}

function safeRelativeRoot(value) {
	if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.includes("//") || /^[A-Za-z]:/.test(value) || value.startsWith("//") || path.isAbsolute(value)) return false;
	const segments = value.split("/");
	return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function verifyMaterializedSnapshot(snapshot) {
	const root = fs.realpathSync(snapshot.destination);
	if (root !== path.resolve(snapshot.destination)) return false;
	const observed = {};
	const stack = [root];
	while (stack.length) {
		const directory = stack.pop();
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			const stat = fs.lstatSync(absolute, { bigint: true });
			if (stat.isSymbolicLink()) return false;
			if (stat.isDirectory()) { stack.push(absolute); continue; }
			if (!stat.isFile()) return false;
			const relative = path.relative(root, absolute).split(path.sep).join("/");
			const bytes = fs.readFileSync(absolute);
			const after = fs.lstatSync(absolute, { bigint: true });
			for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) if (stat[field] !== after[field]) return false;
			observed[relative] = { digest: sha256(bytes), size: bytes.length, mode: Number(stat.mode) & 0o111 ? 0o755 : 0o644 };
		}
	}
	const ordered = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
	if (canonicalJson(ordered) !== canonicalJson(snapshot.files)) return false;
	return snapshot.digest === sha256(canonicalJson({ phase: snapshot.phase, ref: snapshot.ref, roots: snapshot.roots, files: ordered }));
}

function discoverRoots(options) {
	const adapterDigest = assertDigestAllowed(options.adapterPath, options.allowedAdapterDigests, "preservation_adapter");
	const nodeExecutable = options.nodeExecutable || process.execPath;
	assertDigestAllowed(nodeExecutable, options.allowedExecutableDigests, "preservation_executable");
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "preservation-discovery-"));
	const emptySubject = path.join(temp, "subject");
	const adapterSnapshot = path.join(temp, "adapter.cjs");
	fs.mkdirSync(emptySubject, { mode: 0o700 });
	fs.writeFileSync(adapterSnapshot, fs.readFileSync(options.adapterPath), { mode: 0o500, flag: "wx" });
	try {
		const context = { adapterSnapshot, nodeExecutable, subjectRoot: emptySubject, sandboxExecutable: options.sandboxExecutable, allowedSandboxDigests: options.allowedSandboxDigests, timeoutMs: options.timeoutMs };
		const result = adapterCall(context, "roots", {});
		if (!result || !ID.test(result.adapter_id || "") || !Array.isArray(result.snapshot_roots) || !result.snapshot_roots.length || !result.snapshot_roots.every(safeRelativeRoot)) throw Object.assign(new Error("adapter roots are invalid"), { code: "preservation_adapter_roots_invalid" });
		if (sha256(fs.readFileSync(adapterSnapshot)) !== adapterDigest || sha256(fs.readFileSync(options.adapterPath)) !== adapterDigest) throw Object.assign(new Error("adapter changed during discovery"), { code: "preservation_adapter_drift" });
		return { adapter_id: result.adapter_id, snapshot_roots: [...new Set(result.snapshot_roots)].sort(), adapter_digest: adapterDigest };
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
}

function run(options) {
	if (!options || !regularFile(options.adapterPath) || !regularFile(options.nodeExecutable || process.execPath)) throw Object.assign(new Error("preservation runner input is invalid"), { code: "preservation_runner_input_invalid" });
	if (!options.snapshot || !DIGEST.test(options.snapshot.digest || "") || !regularFile(path.join(options.snapshot.destination, Object.keys(options.snapshot.files || {})[0] || "missing"))) throw Object.assign(new Error("sealed subject snapshot is invalid"), { code: "preservation_subject_invalid" });
	if (!verifyMaterializedSnapshot(options.snapshot)) throw Object.assign(new Error("sealed subject snapshot does not match its manifest"), { code: "preservation_subject_manifest_mismatch" });
	const adapterDigest = assertDigestAllowed(options.adapterPath, options.allowedAdapterDigests, "preservation_adapter");
	const nodeExecutable = options.nodeExecutable || process.execPath;
	const executableDigest = assertDigestAllowed(nodeExecutable, options.allowedExecutableDigests, "preservation_executable");
	const stage = options.stage;
	if (!new Set(["planning", "integration_completion"]).has(stage)) throw Object.assign(new Error("preservation stage is invalid"), { code: "preservation_stage_invalid" });
	if (!new Set(["baseline", "current"]).has(options.phase)) throw Object.assign(new Error("preservation phase is invalid"), { code: "preservation_phase_invalid" });
	if (!DIGEST.test(options.challenge || "")) throw Object.assign(new Error("preservation challenge is invalid"), { code: "preservation_challenge_invalid" });
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "preservation-run-"));
	fs.chmodSync(temp, 0o700);
	const adapterSnapshot = path.join(temp, "adapter.cjs");
	fs.writeFileSync(adapterSnapshot, fs.readFileSync(options.adapterPath), { mode: 0o500, flag: "wx" });
	const context = { adapterSnapshot, nodeExecutable, subjectRoot: options.snapshot.destination, sandboxExecutable: options.sandboxExecutable, allowedSandboxDigests: options.allowedSandboxDigests, timeoutMs: options.timeoutMs };
	try {
		const inventory = adapterCall(context, "discover", { phase: options.phase, subject_root: "/subject" });
		const validSurface = (item) => item && ID.test(item.id || "") && ID.test(item.marker || "") && ["baseline_capabilities", "current_capabilities"].every((field) => Array.isArray(item[field]) && item[field].every((value) => ID.test(value || "")));
		if (!inventory || !ID.test(inventory.adapter_id || "") || !Array.isArray(inventory.snapshot_roots) || !inventory.snapshot_roots.every(safeRelativeRoot) || canonicalJson([...new Set(inventory.snapshot_roots)].sort()) !== canonicalJson(options.snapshot.roots) || !Array.isArray(inventory.surfaces) || !Array.isArray(inventory.operations) || !inventory.surfaces.every(validSurface) || !inventory.operations.every((item) => item && ID.test(item.id || ""))) throw Object.assign(new Error("adapter inventory is invalid"), { code: "preservation_inventory_invalid" });
		const discoveredSurfaceIds = inventory.surfaces.map((surface) => surface.id).sort();
		if (!Array.isArray(options.expectedSurfaceIds) || canonicalJson([...new Set(options.expectedSurfaceIds)].sort()) !== canonicalJson(discoveredSurfaceIds)) throw Object.assign(new Error("adapter surface set differs from the active contract"), { code: "preservation_surface_set_mismatch" });
		const inventoryDigest = sha256(canonicalJson(inventory));
		if (options.expectedInventoryDigest && inventoryDigest !== options.expectedInventoryDigest) throw Object.assign(new Error("adapter inventory differs from the sealed contract"), { code: "preservation_inventory_mismatch" });
		if (!inventory.surfaces.some((surface) => surface.id === options.surfaceId)) throw Object.assign(new Error("surface was not independently discovered"), { code: "preservation_surface_undiscovered" });
		const surfaceManifest = inventory.surfaces.find((surface) => surface.id === options.surfaceId);
		const command = adapterCall(context, "command", { challenge: options.challenge, phase: options.phase, surface_id: options.surfaceId, subject_digest: options.snapshot.digest, subject_root: "/subject" });
		if (!validCommand(command)) throw Object.assign(new Error("adapter command is invalid"), { code: "preservation_command_invalid" });
		if (command.executable !== nodeExecutable) throw Object.assign(new Error("adapter selected an unpinned executable"), { code: "preservation_command_executable_mismatch" });
		const commandDigest = sha256(canonicalJson({ executable_digest: executableDigest, argv: command.argv, cwd: command.cwd, env: canonicalize(command.env), stdin_digest: sha256(command.stdin), timeout_ms: command.timeout_ms }));
		const execution = executeSandboxed({ sandboxExecutable: options.sandboxExecutable, allowedSandboxDigests: options.allowedSandboxDigests, subjectRoot: options.snapshot.destination, adapterPath: adapterSnapshot, executable: command.executable, argv: command.argv, cwd: command.cwd, env: command.env, stdin: command.stdin, timeoutMs: command.timeout_ms });
		const result = checkedResult(execution, "preservation_command");
		const observation = {
			status: result.status,
			signal: result.signal || null,
			error_code: result.error && result.error.code || null,
			stdout_digest: sha256(result.stdout || ""),
			stderr_digest: sha256(result.stderr || ""),
			stdout: result.stdout || "",
			stderr: result.stderr || "",
		};
		const parsed = adapterCall(context, "parse", { challenge: options.challenge, phase: options.phase, surface_id: options.surfaceId, subject_digest: options.snapshot.digest, observation });
		if (!parsed || typeof parsed.reachable !== "boolean" || !Array.isArray(parsed.capabilities) || !parsed.capabilities.every((value) => typeof value === "string") || typeof parsed.entry_marker !== "string" || !parsed.entry_marker) throw Object.assign(new Error("adapter parse result is invalid"), { code: "preservation_parse_invalid" });
		const allowedCapabilities = [...surfaceManifest[`${options.phase}_capabilities`]].sort();
		if (parsed.entry_marker !== surfaceManifest.marker || parsed.capabilities.some((value) => !allowedCapabilities.includes(value))) throw Object.assign(new Error("adapter parse result is outside its sealed manifest"), { code: "preservation_parse_manifest_mismatch" });
		if (sha256(fs.readFileSync(adapterSnapshot)) !== adapterDigest || sha256(fs.readFileSync(options.adapterPath)) !== adapterDigest) throw Object.assign(new Error("adapter changed during execution"), { code: "preservation_adapter_drift" });
		if (!verifyMaterializedSnapshot(options.snapshot)) throw Object.assign(new Error("sealed subject changed during execution"), { code: "preservation_subject_snapshot_drift" });
		if (options.verifySubjectStable && !options.verifySubjectStable()) throw Object.assign(new Error("workspace changed during execution"), { code: "preservation_subject_drift" });
		const evidence = {
			challenge: options.challenge,
			run_id: `PRUN-${crypto.randomUUID()}`,
			stage,
			phase: options.phase,
			surface_id: options.surfaceId,
			subject_digest: options.snapshot.digest,
			git_digest: options.snapshot.git_digest,
			repository: options.snapshot.repository,
			adapter_id: inventory.adapter_id,
			adapter_digest: adapterDigest,
			inventory_digest: inventoryDigest,
			executable_digest: executableDigest,
			command_digest: commandDigest,
			observation: { ...observation, stdout: undefined, stderr: undefined },
			parsed: { reachable: parsed.reachable, capabilities: [...new Set(parsed.capabilities)].sort(), entry_marker: parsed.entry_marker },
			sandbox: { engine: "bubblewrap", executable_digest: execution.sandboxDigest, profile_digest: execution.profileDigest, no_network: true, subject_read_only: true, scratch_only_writes: true },
			process: { pid: result.pid || null, started_at: execution.startedAt, finished_at: execution.finishedAt },
		};
		evidence.receipt_id = sha256(canonicalJson({ challenge: evidence.challenge, run_id: evidence.run_id }));
		evidence.reachable = evidence.parsed.reachable;
		evidence.state = evidence.parsed.reachable ? "succeeded" : "failed";
		LIVE_RUNS.add(evidence);
		LIVE_RESULTS.set(evidence, canonicalJson(evidence));
		return evidence;
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
}

function receiptPayload(receipt) {
	const payload = JSON.parse(JSON.stringify(receipt));
	delete payload.signature;
	return payload;
}

function issueReceipt(evidence, binding, signer, now = Date.now()) {
	if (!evidence || !LIVE_RUNS.has(evidence) || LIVE_RESULTS.get(evidence) !== canonicalJson(evidence)) throw Object.assign(new Error("receipt requires unmodified live execution evidence"), { code: "preservation_live_evidence_missing" });
	LIVE_RUNS.delete(evidence);
	LIVE_RESULTS.delete(evidence);
	for (const field of ["repository_id", "unit_id", "contract_digest", "scope_epoch", "binding_epoch", "work_revision", "credential_id", "credential_epoch", "policy_digest", "baseline_ref", "runner_digest", "contract_inventory_digest"]) if (binding[field] === undefined || binding[field] === null || binding[field] === "") throw Object.assign(new Error(`receipt binding missing: ${field}`), { code: "preservation_receipt_binding_invalid" });
	if (![binding.repository_id, binding.contract_digest, binding.policy_digest, binding.runner_digest, binding.contract_inventory_digest].every((value) => DIGEST.test(value)) || !COMMIT.test(binding.baseline_ref) || !ID.test(binding.unit_id) || !ID.test(binding.credential_id) || !ID.test(binding.credential_epoch)) throw Object.assign(new Error("receipt binding is invalid"), { code: "preservation_receipt_binding_invalid" });
	const ttl = Number.isInteger(binding.ttl_ms) ? binding.ttl_ms : 300_000;
	if (ttl < 1 || ttl > 90 * 24 * 60 * 60 * 1000 || typeof signer !== "function") throw Object.assign(new Error("receipt signer or expiry is invalid"), { code: "preservation_receipt_signer_invalid" });
	const receipt = { version: 1, ...evidence, ...binding, issued_at: now, expires_at: now + ttl };
	delete receipt.ttl_ms;
	const signature = signer(Buffer.from(canonicalJson(receiptPayload(receipt))));
	if (!signature) throw Object.assign(new Error("preservation signer returned no signature"), { code: "preservation_receipt_signature_missing" });
	return { ...receipt, signature: Buffer.isBuffer(signature) ? signature.toString("base64") : String(signature) };
}

function verifyReceipt(receipt, options) {
	const errors = [];
	if (!receipt || receipt.version !== 1 || !DIGEST.test(receipt.repository_id || "") || !DIGEST.test(receipt.contract_digest || "") || !DIGEST.test(receipt.policy_digest || "") || !DIGEST.test(receipt.runner_digest || "") || !DIGEST.test(receipt.contract_inventory_digest || "") || !COMMIT.test(receipt.baseline_ref || "") || !DIGEST.test(receipt.subject_digest || "") || !DIGEST.test(receipt.git_digest || "") || !DIGEST.test(receipt.inventory_digest || "") || !DIGEST.test(receipt.adapter_digest || "") || !DIGEST.test(receipt.executable_digest || "") || !DIGEST.test(receipt.command_digest || "")) errors.push("preservation_receipt_shape_invalid");
	if (!receipt || receipt.expires_at < options.now || receipt.issued_at > options.now) errors.push("preservation_receipt_expired");
	for (const [field, expected] of Object.entries(options.expected || {})) if (receipt && receipt[field] !== expected) errors.push(`preservation_receipt_${field}_mismatch`);
	if (!options.allowedAdapterDigests.includes(receipt && receipt.adapter_digest)) errors.push("preservation_receipt_adapter_not_allowed");
	if (!options.allowedExecutableDigests.includes(receipt && receipt.executable_digest)) errors.push("preservation_receipt_executable_not_allowed");
	try {
		if (!crypto.verify(null, Buffer.from(canonicalJson(receiptPayload(receipt))), options.publicKey, Buffer.from(receipt.signature || "", "base64"))) errors.push("preservation_receipt_signature_invalid");
	} catch { errors.push("preservation_receipt_signature_invalid"); }
	return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

module.exports = { canonicalJson, discoverRoots, issueReceipt, receiptPayload, run, sha256, verifyMaterializedSnapshot, verifyReceipt };
