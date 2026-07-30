/** Trusted local review launcher. The reviewer sees one bundle and an empty scratch only. */

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_OUTPUT = 1024 * 1024;
const O_TMPFILE = 0o20000000 | fs.constants.O_DIRECTORY;
const LIVE_RUN_EVIDENCE = new WeakSet();
const LIVE_RUN_OUTPUT = new WeakMap();

function sha256(value) {
	return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
	return value;
}

function semanticReviewProjection(value) {
	const projected = JSON.parse(JSON.stringify(value || {}));
	for (const key of ["run_id", "reviewed_at", "executor", "sandbox", "isolation", "bundle_digest", "full_bundle_digest", "evidence_view_digest", "planning_digest", "planning_seal_digest", "source_head", "contract_digest", "workspace_digest", "config_digest", "scope_epoch", "work_revision", "binding_epoch"]) delete projected[key];
	return canonicalize(projected);
}

function bubblewrapProfile(env = {}) {
	const mounts = ["/usr", "/lib", "/lib64"].filter((candidate) => fs.existsSync(candidate));
	const args = ["--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-pid", "--die-with-parent", "--new-session", "--clearenv", "--info-fd", "3"];
	for (const mount of mounts) args.push("--ro-bind", mount, mount);
	args.push(
		"--proc", "/proc",
		"--dev", "/dev",
		"--tmpfs", "/scratch",
		"--tmpfs", "/home",
		"--dir", "/home/reviewer",
		"--tmpfs", "/review",
		"--perms", "0500",
		"--ro-bind-data", "4", "/review/reviewer",
		"--perms", "0400",
		"--ro-bind-data", "5", "/review/input.json",
		"--remount-ro", "/home",
		"--remount-ro", "/review",
		"--setenv", "HOME", "/home/reviewer",
		"--setenv", "PATH", "/usr/bin:/bin",
		"--setenv", "TMPDIR", "/scratch",
		"--setenv", "REQUEST_CONTRACT_BUNDLE", "/review/input.json",
	);
	for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) args.push("--setenv", key, String(value));
	const identityWrapper = 'rest="$(cat /proc/self/stat)"; rest="${rest##*) }"; set -- $rest; shift 19; printf "%s:%s\\n" "$(cat /proc/sys/kernel/random/boot_id)" "$1" >&6; exec /review/reviewer';
	args.push("--chdir", "/scratch", "/usr/bin/sh", "-c", identityWrapper);
	const publicProfile = [...args];
	return { args, digest: sha256(JSON.stringify(publicProfile)), publicProfile };
}

function anonymousSnapshot(bytes, mode) {
	let writer = null;
	let reader = null;
	try {
		writer = fs.openSync(os.tmpdir(), fs.constants.O_RDWR | O_TMPFILE, 0o600);
		fs.writeFileSync(writer, bytes);
		fs.fsyncSync(writer);
		fs.fchmodSync(writer, mode);
		reader = fs.openSync(`/proc/self/fd/${writer}`, fs.constants.O_RDONLY);
		return reader;
	} catch (error) {
		if (reader != null) try { fs.closeSync(reader); } catch {}
		throw Object.assign(new Error("anonymous review snapshot could not be sealed"), { code: "review_runner_snapshot_unavailable", cause: error });
	} finally {
		if (writer != null) try { fs.closeSync(writer); } catch {}
	}
}

function runBubblewrapSandbox(options) {
	const bwrap = "/usr/bin/bwrap";
	for (const file of [bwrap, options.bundlePath, options.reviewerPath]) {
		if (!path.isAbsolute(file) || !fs.lstatSync(file).isFile()) throw Object.assign(new Error("sandbox input must be an absolute, non-symlink regular file"), { code: "review_runner_input_invalid" });
	}
	const sandboxExecutableDigest = sha256(fs.readFileSync(bwrap));
	if (!Array.isArray(options.allowedSandboxDigests) || !options.allowedSandboxDigests.includes(sandboxExecutableDigest)) throw Object.assign(new Error("sandbox executable is not pinned by configuration"), { code: "sandbox_executable_not_allowed" });
	const reviewerBytes = fs.readFileSync(options.reviewerPath);
	const reviewerDigest = sha256(reviewerBytes);
	if (!Array.isArray(options.allowedReviewerDigests) || !options.allowedReviewerDigests.includes(reviewerDigest)) throw Object.assign(new Error("reviewer executable is not pinned by configuration"), { code: "reviewer_executable_not_allowed" });
	const bundleBytes = fs.readFileSync(options.bundlePath);
	const bundleDigest = sha256(bundleBytes);
	if (!/^[a-f0-9]{64}$/.test(options.expectedBundleDigest || "") || bundleDigest !== options.expectedBundleDigest) throw Object.assign(new Error("review bundle does not match the issued invocation"), { code: "review_bundle_digest_mismatch" });
	let reviewerFd = null;
	let bundleFd = null;
	let profile;
	let startedAt;
	let result;
	try {
		reviewerFd = anonymousSnapshot(reviewerBytes, 0o500);
		bundleFd = anonymousSnapshot(bundleBytes, 0o400);
		if (options.afterSnapshotSealed) options.afterSnapshotSealed();
		profile = bubblewrapProfile(options.env || {});
		startedAt = Date.now();
		result = cp.spawnSync(bwrap, profile.args, {
			encoding: "utf8",
			env: { PATH: "/usr/bin:/bin" },
			stdio: ["ignore", "pipe", "pipe", "pipe", reviewerFd, bundleFd, "pipe"],
			maxBuffer: MAX_OUTPUT,
			timeout: options.timeoutMs || 120_000,
			killSignal: "SIGKILL",
		});
	} finally {
		if (reviewerFd != null) try { fs.closeSync(reviewerFd); } catch {}
		if (bundleFd != null) try { fs.closeSync(bundleFd); } catch {}
	}
	if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code === "ETIMEDOUT" ? "review_runner_timeout" : "review_runner_spawn_failed" });
	if (result.status !== 0) throw Object.assign(new Error("isolated reviewer exited unsuccessfully"), { code: "review_runner_reviewer_failed" });
	if (Buffer.byteLength(result.stdout || "") > MAX_OUTPUT) throw Object.assign(new Error("reviewer output exceeds limit"), { code: "review_runner_output_too_large" });
	let output;
	try { output = JSON.parse(result.stdout || ""); } catch { throw Object.assign(new Error("reviewer output is not one JSON object"), { code: "review_runner_output_invalid" }); }
	if (!output || typeof output !== "object" || Array.isArray(output)) throw Object.assign(new Error("reviewer output is not one JSON object"), { code: "review_runner_output_invalid" });
	let sandboxInfo;
	try { sandboxInfo = JSON.parse(String(result.output && result.output[3] || "")); } catch { throw Object.assign(new Error("bubblewrap did not report its child process"), { code: "review_runner_process_evidence_missing" }); }
	if (!Number.isInteger(sandboxInfo["child-pid"]) || sandboxInfo["child-pid"] <= 0) throw Object.assign(new Error("bubblewrap child pid is invalid"), { code: "review_runner_process_evidence_missing" });
	const reviewerProcessIdentity = String(result.output && result.output[6] || "").trim();
	if (!/^[a-f0-9-]{36}:\d+$/.test(reviewerProcessIdentity)) throw Object.assign(new Error("reviewer process identity is invalid"), { code: "review_runner_process_evidence_missing" });
	const evidence = {
			sandbox_engine: "bubblewrap",
			sandbox_profile_digest: profile.digest,
			sandbox_executable_digest: sandboxExecutableDigest,
			reviewer_executable_digest: reviewerDigest,
			launcher_process_id: sandboxInfo["child-pid"],
			reviewer_process_identity: reviewerProcessIdentity,
			started_at: startedAt,
			executed_at: Date.now(),
			no_network: true,
			repository_blind: true,
			home_blind: true,
			bundle_digest: bundleDigest,
	};
	LIVE_RUN_EVIDENCE.add(evidence);
	LIVE_RUN_OUTPUT.set(evidence, output);
	return { output, evidence };
}

const WINDOWS_REVIEW_HOST = String.raw`"use strict";
const cp=require("child_process"),crypto=require("crypto"),path=require("path");
const reviewer=process.argv[2],scratch=process.argv[3];
const env={};
for(const key of Object.keys(process.env).sort()) if(key.startsWith("REQUEST_CONTRACT_")) env[key]=process.env[key];
env.REQUEST_CONTRACT_BUNDLE=process.argv[4];
const startedAt=Date.now();
const permissions=["--permission","--allow-fs-read="+reviewer,"--allow-fs-read="+process.argv[4],"--allow-fs-write="+scratch];
const child=cp.spawnSync(process.execPath,[...permissions,reviewer],{cwd:scratch,env,encoding:"utf8",stdio:["ignore","pipe","pipe"],maxBuffer:1024*1024,timeout:Number(process.env.REQUEST_CONTRACT_REVIEW_TIMEOUT||120000)});
if(child.error||child.status!==0){process.stderr.write("reviewer_failed");process.exit(20)}
let review;try{review=JSON.parse(child.stdout||"")}catch{process.stderr.write("reviewer_output_invalid");process.exit(21)}
const identity="win32:"+child.pid+":"+startedAt+":"+crypto.randomBytes(16).toString("hex");
process.stdout.write(JSON.stringify({meta:{process_id:child.pid,process_identity:identity,started_at:startedAt},review}));
`;

function regularFile(file) {
	if (!path.isAbsolute(file)) return false;
	try {
		const stat = fs.lstatSync(file);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function resolveCodexExecutable(options = {}) {
	const candidates = [
		options.sandboxExecutable,
		process.env.REQUEST_CONTRACT_WINDOWS_SANDBOX_EXECUTABLE,
		process.env.CODEX_MANAGED_PACKAGE_ROOT && path.join(process.env.CODEX_MANAGED_PACKAGE_ROOT, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
		process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
	].filter(Boolean);
	const executable = candidates.find(regularFile);
	if (!executable) throw Object.assign(new Error("a native Windows sandbox executable is required"), { code: "review_runner_sandbox_unavailable" });
	return executable;
}

function windowsSandboxProfile(stage, executableDigest) {
	const quotedStage = JSON.stringify(path.resolve(stage));
	const policy = `permissions.contract-review={workspace_roots={${quotedStage}=true},filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read","scratch"="write"}},network={enabled=false}}`;
	const args = ["sandbox", "-c", "windows.sandbox=\"elevated\"", "-c", policy, "-P", "contract-review", "-C", stage, "--"];
	return { args, policy, digest: sha256(JSON.stringify({ engine: "codex-windows-elevated", executable_digest: executableDigest, policy })) };
}

function isWithin(parent, child) {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const WINDOWS_CURRENT_SID = { value: null };

function assertNoReparseComponents(target) {
	const resolved = path.resolve(target);
	const root = path.parse(resolved).root;
	let current = root;
	for (const component of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		if (!fs.existsSync(current)) continue;
		const stat = fs.lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error("review staging path must not traverse a reparse point"), { code: "review_runner_stage_reparse_point" });
	}
	return resolved;
}

function windowsCurrentSid() {
	if (WINDOWS_CURRENT_SID.value) return WINDOWS_CURRENT_SID.value;
	const script = "[Console]::Out.Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)";
	const sid = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
	}).trim();
	if (!/^S-\d+(?:-\d+)+$/.test(sid)) throw Object.assign(new Error("current Windows identity could not be resolved"), { code: "review_runner_stage_acl_failed" });
	WINDOWS_CURRENT_SID.value = sid;
	return sid;
}

function hardenWindowsDirectory(directory) {
	const resolved = assertNoReparseComponents(directory);
	const result = cp.spawnSync("icacls.exe", [
		resolved,
		"/inheritance:r",
		"/grant:r",
		"*" + windowsCurrentSid() + ":(OI)(CI)F",
		"*S-1-5-18:(OI)(CI)F",
	], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
	if (result.error || result.status !== 0) throw Object.assign(new Error("review staging ACL could not be restricted"), { code: "review_runner_stage_acl_failed", cause: result.error });
	return resolved;
}

function repositoryRoot(start) {
	let current = path.resolve(start);
	for (;;) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(start);
		current = parent;
	}
}

function resolveWindowsStageRoot(options = {}) {
	const repository = repositoryRoot(process.cwd());
	const home = path.resolve(os.homedir());
	const driveTemp = path.join(path.parse(repository).root, "tmp", "naia-request-contract-review");
	const publicTemp = process.env.PUBLIC && path.join(process.env.PUBLIC, ".naia-adk", "request-contract-review");
	const candidates = [options.stageRoot, process.env.REQUEST_CONTRACT_WINDOWS_STAGE_ROOT, driveTemp, publicTemp].filter(Boolean);
	for (const candidate of candidates) {
		const resolved = path.resolve(candidate);
		if (isWithin(repository, resolved) || isWithin(home, resolved)) continue;
		try {
			assertNoReparseComponents(path.dirname(resolved));
			fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
			return hardenWindowsDirectory(assertNoReparseComponents(resolved));
		} catch {}
	}
	throw Object.assign(new Error("a review staging root outside the repository and user home is required"), { code: "review_runner_stage_unavailable" });
}

function runWindowsSandbox(options) {
	for (const file of [options.bundlePath, options.reviewerPath]) if (!regularFile(file)) throw Object.assign(new Error("sandbox input must be an absolute, non-symlink regular file"), { code: "review_runner_input_invalid" });
	if (path.extname(options.reviewerPath).toLowerCase() !== ".cjs") throw Object.assign(new Error("Windows reviewers must be portable CommonJS executables"), { code: "review_runner_reviewer_platform_unsupported" });
	const reviewerBytes = fs.readFileSync(options.reviewerPath);
	const reviewerDigest = sha256(reviewerBytes);
	if (!Array.isArray(options.allowedReviewerDigests) || !options.allowedReviewerDigests.includes(reviewerDigest)) throw Object.assign(new Error("reviewer executable is not pinned by configuration"), { code: "reviewer_executable_not_allowed" });
	const bundleBytes = fs.readFileSync(options.bundlePath);
	const bundleDigest = sha256(bundleBytes);
	if (!/^[a-f0-9]{64}$/.test(options.expectedBundleDigest || "") || bundleDigest !== options.expectedBundleDigest) throw Object.assign(new Error("review bundle does not match the issued invocation"), { code: "review_bundle_digest_mismatch" });
	const sandboxExecutable = resolveCodexExecutable(options);
	const sandboxExecutableDigest = sha256(fs.readFileSync(sandboxExecutable));
	if (!Array.isArray(options.allowedSandboxDigests) || !options.allowedSandboxDigests.includes(sandboxExecutableDigest)) throw Object.assign(new Error("sandbox executable is not pinned by configuration"), { code: "sandbox_executable_not_allowed" });
	const stage = fs.mkdtempSync(path.join(resolveWindowsStageRoot(options), "run-"));
	const reviewerSnapshot = path.join(stage, "reviewer.cjs");
	const bundleSnapshot = path.join(stage, "input.json");
	const hostSnapshot = path.join(stage, "review-host.cjs");
	const scratch = path.join(stage, "scratch");
	let result;
	let profile;
	let startedAt;
	try {
		hardenWindowsDirectory(stage);
		fs.mkdirSync(scratch, { mode: 0o700 });
		fs.writeFileSync(reviewerSnapshot, reviewerBytes, { mode: 0o400, flag: "wx" });
		fs.writeFileSync(bundleSnapshot, bundleBytes, { mode: 0o400, flag: "wx" });
		fs.writeFileSync(hostSnapshot, WINDOWS_REVIEW_HOST, { mode: 0o400, flag: "wx" });
		if (options.afterSnapshotSealed) options.afterSnapshotSealed();
		profile = windowsSandboxProfile(stage, sandboxExecutableDigest);
		const env = {
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			ComSpec: process.env.ComSpec,
			PATHEXT: process.env.PATHEXT,
			APPDATA: process.env.APPDATA,
			LOCALAPPDATA: process.env.LOCALAPPDATA,
			USERPROFILE: process.env.USERPROFILE,
			REQUEST_CONTRACT_HOME_PROBE: path.join(os.homedir(), ".codex", "config.toml"),
			REQUEST_CONTRACT_REPOSITORY_PROBE: path.join(process.cwd(), "package.json"),
			REQUEST_CONTRACT_HOME_WRITE_PROBE: path.join(os.homedir(), `.request-contract-probe-${crypto.randomUUID()}`),
			REQUEST_CONTRACT_REVIEW_WRITE_PROBE: path.join(stage, `review-probe-${crypto.randomUUID()}`),
			REQUEST_CONTRACT_SCRATCH_PROBE: path.join(scratch, `scratch-probe-${crypto.randomUUID()}`),
			...Object.fromEntries(Object.entries(options.env || {}).filter(([key]) => key.startsWith("REQUEST_CONTRACT_")).map(([key, value]) => [key, String(value)])),
		};
		startedAt = Date.now();
		result = cp.spawnSync(sandboxExecutable, [...profile.args, process.execPath, hostSnapshot, reviewerSnapshot, scratch, bundleSnapshot], {
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_OUTPUT,
			timeout: options.timeoutMs || 120_000,
		});
		if (sha256(fs.readFileSync(reviewerSnapshot)) !== reviewerDigest || sha256(fs.readFileSync(bundleSnapshot)) !== bundleDigest || sha256(fs.readFileSync(hostSnapshot)) !== sha256(WINDOWS_REVIEW_HOST)) throw Object.assign(new Error("sealed review snapshot changed during execution"), { code: "review_runner_snapshot_identity_drift" });
	} catch (error) {
		if (!result) throw Object.assign(new Error("private review snapshot could not be sealed"), { code: "review_runner_snapshot_unavailable", cause: error });
		throw error;
	} finally {
		try {
			fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		} catch (error) {
			throw Object.assign(new Error("private review snapshot could not be removed"), { code: "review_runner_snapshot_cleanup_failed", cause: error });
		}
	}
	if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code === "ETIMEDOUT" ? "review_runner_timeout" : "review_runner_spawn_failed" });
	if (result.status !== 0) throw Object.assign(new Error("isolated reviewer exited unsuccessfully"), { code: "review_runner_reviewer_failed" });
	if (Buffer.byteLength(result.stdout || "") > MAX_OUTPUT) throw Object.assign(new Error("reviewer output exceeds limit"), { code: "review_runner_output_too_large" });
	let envelope;
	try { envelope = JSON.parse(result.stdout || ""); } catch { throw Object.assign(new Error("reviewer output is not one JSON object"), { code: "review_runner_output_invalid" }); }
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !envelope.meta || !envelope.review || !Number.isInteger(envelope.meta.process_id) || envelope.meta.process_id <= 0 || typeof envelope.meta.process_identity !== "string") throw Object.assign(new Error("native sandbox did not report reviewer process evidence"), { code: "review_runner_process_evidence_missing" });
	const evidence = {
		sandbox_engine: "codex-windows-elevated",
		sandbox_profile_digest: profile.digest,
		sandbox_executable_digest: sandboxExecutableDigest,
		reviewer_executable_digest: reviewerDigest,
		launcher_process_id: envelope.meta.process_id,
		reviewer_process_identity: envelope.meta.process_identity,
		started_at: envelope.meta.started_at || startedAt,
		executed_at: Date.now(),
		no_network: true,
		repository_blind: true,
		home_blind: true,
		bundle_digest: bundleDigest,
	};
	LIVE_RUN_EVIDENCE.add(evidence);
	LIVE_RUN_OUTPUT.set(evidence, envelope.review);
	return { output: envelope.review, evidence };
}

function runSandbox(options) {
	if (process.platform === "win32") return runWindowsSandbox(options);
	return runBubblewrapSandbox(options);
}

function consumeRunEvidence(evidence, review) {
	if (!evidence || !LIVE_RUN_EVIDENCE.has(evidence)) return false;
	const reviewerOutput = LIVE_RUN_OUTPUT.get(evidence);
	LIVE_RUN_EVIDENCE.delete(evidence);
	LIVE_RUN_OUTPUT.delete(evidence);
	const isolation = review && review.isolation;
	return Boolean(isolation && reviewerOutput && sha256(JSON.stringify(semanticReviewProjection(reviewerOutput))) === sha256(JSON.stringify(semanticReviewProjection(review))) && evidence.bundle_digest === review.bundle_digest && ["sandbox_engine", "sandbox_profile_digest", "sandbox_executable_digest", "reviewer_executable_digest", "launcher_process_id", "reviewer_process_identity", "started_at", "executed_at", "no_network", "repository_blind", "home_blind", "bundle_digest"].every((field) => isolation[field] === evidence[field]));
}

function pinnedExecutableDigest(executable, allowedDigests) {
	if (!path.isAbsolute(executable)) throw Object.assign(new Error("attestor must be an absolute regular file"), { code: "review_attestor_invalid" });
	let stat;
	try { stat = fs.lstatSync(executable); } catch { throw Object.assign(new Error("attestor must be an absolute regular file"), { code: "review_attestor_invalid" }); }
	if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error("attestor must be a non-symlink regular file"), { code: "review_attestor_invalid" });
	const digest = sha256(fs.readFileSync(executable));
	if (!Array.isArray(allowedDigests) || !allowedDigests.includes(digest)) throw Object.assign(new Error("attestor executable is not pinned by configuration"), { code: "review_attestor_not_allowed" });
	return digest;
}

function externalSign(executable, payload, allowedDigests) {
	const expectedDigest = pinnedExecutableDigest(executable, allowedDigests);
	const bytes = fs.readFileSync(executable);
	if (sha256(bytes) !== expectedDigest) throw Object.assign(new Error("attestor executable changed during launch"), { code: "review_attestor_identity_drift" });
	const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "request-contract-attestor-"));
	fs.chmodSync(snapshotDir, 0o700);
	const snapshotPath = path.join(snapshotDir, "attestor");
	fs.writeFileSync(snapshotPath, bytes, { mode: 0o500, flag: "wx" });
	let result;
	try {
		const executable = process.platform === "win32" ? process.execPath : snapshotPath;
		const args = process.platform === "win32" ? [snapshotPath] : [];
		result = cp.spawnSync(executable, args, { input: payload, encoding: "utf8", env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024, timeout: 30_000 });
	} finally {
		fs.rmSync(snapshotDir, { recursive: true, force: true });
	}
	if (result.error || result.status !== 0) throw Object.assign(new Error("attestor failed"), { code: "review_attestor_failed" });
	const signature = String(result.stdout || "").trim();
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw Object.assign(new Error("attestor did not return one base64 signature"), { code: "review_attestor_output_invalid" });
	return { signature, executableDigest: expectedDigest };
}

module.exports = { MAX_OUTPUT, sha256, canonicalize, semanticReviewProjection, bubblewrapProfile, windowsSandboxProfile, anonymousSnapshot, runSandbox, runBubblewrapSandbox, runWindowsSandbox, resolveCodexExecutable, resolveWindowsStageRoot, assertNoReparseComponents, hardenWindowsDirectory, consumeRunEvidence, pinnedExecutableDigest, externalSign };
