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
	for (const key of ["run_id", "reviewed_at", "executor", "sandbox", "isolation", "bundle_digest", "source_head", "contract_digest", "workspace_digest", "config_digest", "scope_epoch", "work_revision", "binding_epoch"]) delete projected[key];
	return canonicalize(projected);
}

function sandboxProfile(env = {}) {
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

function runSandbox(options) {
	const bwrap = "/usr/bin/bwrap";
	for (const file of [bwrap, options.bundlePath, options.reviewerPath]) {
		if (!path.isAbsolute(file) || !fs.lstatSync(file).isFile()) throw Object.assign(new Error("sandbox input must be an absolute, non-symlink regular file"), { code: "review_runner_input_invalid" });
	}
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
		profile = sandboxProfile(options.env || {});
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

function consumeRunEvidence(evidence, review) {
	if (!evidence || !LIVE_RUN_EVIDENCE.has(evidence)) return false;
	const reviewerOutput = LIVE_RUN_OUTPUT.get(evidence);
	LIVE_RUN_EVIDENCE.delete(evidence);
	LIVE_RUN_OUTPUT.delete(evidence);
	const isolation = review && review.isolation;
	return Boolean(isolation && reviewerOutput && sha256(JSON.stringify(semanticReviewProjection(reviewerOutput))) === sha256(JSON.stringify(semanticReviewProjection(review))) && evidence.bundle_digest === review.bundle_digest && ["sandbox_engine", "sandbox_profile_digest", "reviewer_executable_digest", "launcher_process_id", "reviewer_process_identity", "started_at", "executed_at", "no_network", "repository_blind", "home_blind", "bundle_digest"].every((field) => isolation[field] === evidence[field]));
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
		result = cp.spawnSync(snapshotPath, [], { input: payload, encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024, timeout: 30_000 });
	} finally {
		fs.rmSync(snapshotDir, { recursive: true, force: true });
	}
	if (result.error || result.status !== 0) throw Object.assign(new Error("attestor failed"), { code: "review_attestor_failed" });
	const signature = String(result.stdout || "").trim();
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw Object.assign(new Error("attestor did not return one base64 signature"), { code: "review_attestor_output_invalid" });
	return { signature, executableDigest: expectedDigest };
}

module.exports = { MAX_OUTPUT, sha256, canonicalize, semanticReviewProjection, sandboxProfile, anonymousSnapshot, runSandbox, consumeRunEvidence, pinnedExecutableDigest, externalSign };
