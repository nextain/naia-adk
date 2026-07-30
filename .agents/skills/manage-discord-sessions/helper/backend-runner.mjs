import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, chmodSync, existsSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { spawn } from "node:child_process";
import { assertSupportedBackendVersion, getBackendAdapter, inspectBackendLine } from "./adapters.mjs";
import { readProcessStartIdentity } from "./projector.mjs";

const SAFE_ENV_KEYS = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"]);
const API_KEY_BY_BACKEND = { codex: "CODEX_API_KEY", claude: "ANTHROPIC_API_KEY" };

function safeCommandOptions(backendId, options) {
	const allowed = backendId === "codex" ? new Set(["sandbox"]) : new Set(["permissionMode", "settingSources"]);
	for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`unsupported ${backendId} command option: ${key}`);
	if (backendId === "codex" && options.sandbox && !new Set(["read-only", "workspace-write"]).has(options.sandbox)) throw new Error("unsafe Codex sandbox option");
	if (backendId === "claude" && options.permissionMode && !new Set(["dontAsk", "plan"]).has(options.permissionMode)) throw new Error("unsafe Claude permission mode");
	if (backendId === "claude" && options.settingSources && options.settingSources !== "project") throw new Error("Claude setting sources must remain project-only");
	return { ...options };
}

function assertRealFile(path, label) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} owner mismatch`);
}

function privateDirectory(path) {
	const resolvedPath = resolve(path);
	const root = parse(resolvedPath).root;
	let cursor = root;
	for (const part of resolvedPath.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
		cursor = resolve(cursor, part);
		if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`private path contains a symbolic link: ${cursor}`);
	}
	mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
	const stat = lstatSync(resolvedPath);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`private path must be a real directory: ${resolvedPath}`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`private path owner mismatch: ${resolvedPath}`);
	chmodSync(resolvedPath, 0o700);
}

function copyCredential(source, target, label) {
	if (!existsSync(source)) return false;
	assertRealFile(source, label);
	if ((lstatSync(source).mode & 0o077) !== 0) throw new Error(`${label} permissions must not grant group or other access`);
	privateDirectory(dirname(target));
	const sourceFd = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	let targetFd;
	try {
		targetFd = openSync(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			let offset = 0;
			while (offset < bytesRead) offset += writeSync(targetFd, buffer, offset, bytesRead - offset);
		}
	} finally {
		closeSync(sourceFd);
		if (targetFd !== undefined) closeSync(targetFd);
	}
	chmodSync(target, 0o600);
	return true;
}

function defaultRuntimeRoot(parentEnv) {
	const base = parentEnv.XDG_RUNTIME_DIR && resolve(parentEnv.XDG_RUNTIME_DIR) === parentEnv.XDG_RUNTIME_DIR
		? parentEnv.XDG_RUNTIME_DIR
		: join(tmpdir(), `naia-adk-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
	return join(base, "messenger-sessions");
}

export function prepareChildEnvironment({ backendId, attemptId, runtimeRoot, parentEnv = process.env, authRoot = homedir(), workspacePath = null }) {
	const childHome = resolve(runtimeRoot ?? defaultRuntimeRoot(parentEnv), "children", attemptId);
	privateDirectory(childHome);
	try {
	const env = {};
	for (const key of SAFE_ENV_KEYS) if (parentEnv[key]) env[key] = parentEnv[key];
	if (env.PATH) {
		const workspace = workspacePath ? resolve(workspacePath) : null;
		env.PATH = env.PATH.split(delimiter).filter((entry) => {
			if (!entry || !isAbsolute(entry) || entry.split(/[\\/]+/).includes("node_modules")) return false;
			const resolvedEntry = resolve(entry);
			return !workspace || (resolvedEntry !== workspace && !resolvedEntry.startsWith(`${workspace}/`));
		}).join(delimiter);
	}
	env.HOME = childHome;
	env.NO_COLOR = "1";
	for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "TMPDIR"]) {
		env[key] = join(childHome, key.toLowerCase());
		privateDirectory(env[key]);
	}
	const apiKeyName = API_KEY_BY_BACKEND[backendId];
	if (apiKeyName && parentEnv[apiKeyName]) env[apiKeyName] = parentEnv[apiKeyName];
	let authenticationPrepared = Boolean(apiKeyName && parentEnv[apiKeyName]);
	if (backendId === "codex") {
		const codexHome = join(childHome, ".codex");
		privateDirectory(codexHome);
		env.CODEX_HOME = codexHome;
		authenticationPrepared ||= copyCredential(join(authRoot, ".codex", "auth.json"), join(codexHome, "auth.json"), "Codex authentication");
	} else if (backendId === "claude") {
		privateDirectory(join(childHome, ".claude"));
		authenticationPrepared ||= copyCredential(join(authRoot, ".claude", ".credentials.json"), join(childHome, ".claude", ".credentials.json"), "Claude authentication");
	} else {
		throw new Error(`unsupported backend environment: ${backendId}`);
	}
	return { childHome, env, authenticationPrepared };
	} catch (error) {
		if (existsSync(childHome)) cleanupChildEnvironment(childHome);
		throw error;
	}
}

export function cleanupChildEnvironment(childHome) {
	const stat = lstatSync(childHome);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("refusing to clean an unsafe child environment");
	rmSync(childHome, { recursive: true, force: false });
}

function writePrompt(child, prompt) {
	child.stdin.end(prompt, "utf8");
}

async function probeBackendVersion(backendId, executable, parentEnv) {
	const child = spawn(executable, ["--version"], { env: { PATH: parentEnv.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => { if (output.length < 4_096) output += chunk.slice(0, 4_096 - output.length); });
	}
	const exitCode = await new Promise((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("close", resolveExit);
	});
	if (exitCode !== 0) throw new Error(`${backendId} version probe failed`);
	return assertSupportedBackendVersion(backendId, output);
}

const MAX_STREAM_LINE_BYTES = 256 * 1024;

function lineReader(stream, onLine, onFailure) {
	let buffered = "";
	stream.setEncoding("utf8");
	const completed = new Promise((resolve) => {
		stream.once("end", resolve);
		stream.once("close", resolve);
		stream.once("error", () => {
			onFailure(new Error("backend stream failed"));
			resolve();
		});
	});
	stream.on("data", (chunk) => {
		buffered += chunk;
		if (Buffer.byteLength(buffered, "utf8") > MAX_STREAM_LINE_BYTES) {
			buffered = "";
			onFailure(new Error("backend stream line exceeded the safe limit"));
			stream.destroy();
			return;
		}
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline).trimEnd();
			buffered = buffered.slice(newline + 1);
			if (line) {
				try { onLine(line); } catch { onFailure(new Error("backend stream normalization failed")); }
			}
		}
	});
	stream.on("end", () => {
		const line = buffered.trim();
		if (line) {
			try { onLine(line); } catch { onFailure(new Error("backend stream normalization failed")); }
		}
	});
	return completed;
}

export async function runBackendAttempt({
	store,
	jobId,
	backendId,
	prompt,
	cwd,
	runtimeRoot,
	executable,
	authRoot,
	parentEnv = process.env,
	timeoutMs = 30 * 60 * 1000,
	killGraceMs = 5_000,
	signal,
	commandOptions = {},
	backendVersion,
	requireAuthentication = true,
	now = () => new Date().toISOString(),
}) {
	if (typeof prompt !== "string" || prompt.length === 0) throw new Error("prompt must be a non-empty string");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive safe integer");
	if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) throw new Error("killGraceMs must be a non-negative safe integer");
	const adapter = getBackendAdapter(backendId);
	const supportedVersion = backendVersion
		? assertSupportedBackendVersion(backendId, backendVersion)
		: await probeBackendVersion(backendId, executable ?? backendId, parentEnv);
	const attemptId = randomUUID();
	const { childHome, env, authenticationPrepared } = prepareChildEnvironment({ backendId, attemptId, runtimeRoot, parentEnv, authRoot, workspacePath: cwd });
	if (requireAuthentication && !authenticationPrepared) {
		cleanupChildEnvironment(childHome);
		throw new Error(`${backendId} authentication is not ready`);
	}
	let child;
	try {
	const invocation = adapter.command({ ...safeCommandOptions(backendId, commandOptions), executable, cwd: resolve(cwd) });
	store.reserveAttempt(jobId, { attemptId, backendId, now: now() });
	child = spawn(invocation.command, invocation.args, {
		cwd: resolve(cwd),
		env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	try {
		await new Promise((accept, reject) => {
			child.once("spawn", accept);
			child.once("error", reject);
		});
	} catch (error) {
		try {
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
		} catch {}
		throw error;
	}
	store.attachAttempt(jobId, { attemptId, childPid: child.pid, backendId, now: now() });
	const ownedStartIdentity = readProcessStartIdentity(child.pid);
	let lineNumber = 0;
	let backendOutcome = null;
	let transientResult = null;
	let processError = false;
	let terminationReason = null;
	let forceTimer = null;
	const recordLine = (line) => {
		lineNumber += 1;
		const inspected = inspectBackendLine({ backendId, line, attemptId, lineNumber });
		if (inspected.outcome === "failure") backendOutcome = "failure";
		else if (inspected.outcome === "success" && backendOutcome !== "failure") backendOutcome = "success";
		if (inspected.transientResult !== null) transientResult = inspected.transientResult;
		for (const event of inspected.events) {
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, ...event });
		}
	};
	let normalizeFailed = false;
	const streamFailure = () => {
		normalizeFailed = true;
		terminate("internal_error");
	};
	const stdoutCompleted = lineReader(child.stdout, recordLine, streamFailure);
	const stderrCompleted = lineReader(child.stderr, (line) => {
		lineNumber += 1;
		const bytes = Buffer.byteLength(line, "utf8");
		store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, dedupeKey: `${backendId}:stderr:${lineNumber}`, kind: "output_activity", safePayload: { bytes }, metrics: { bytes } });
	}, streamFailure);
	const signalProcessTree = (signalName) => {
		const currentIdentity = readProcessStartIdentity(child.pid);
		if (ownedStartIdentity && currentIdentity && currentIdentity !== ownedStartIdentity) return;
		try {
			if (process.platform === "win32") {
				if (child.exitCode === null && child.signalCode === null) child.kill(signalName);
			}
			else process.kill(-child.pid, signalName);
		} catch (error) {
			if (error?.code !== "ESRCH") throw error;
		}
	};
	const terminate = (reason) => {
		if (terminationReason || child.exitCode !== null || child.signalCode !== null) return;
		terminationReason = reason;
		store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "cancel_requested", safePayload: {} });
		signalProcessTree("SIGTERM");
		forceTimer = setTimeout(() => signalProcessTree("SIGKILL"), killGraceMs);
		forceTimer.unref?.();
	};
	const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
	timeout.unref?.();
	const abort = () => terminate(signal?.reason === "recovery" ? "recovery" : "cancelled");
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	child.stdin.on("error", () => terminate("internal_error"));
	writePrompt(child, prompt);
	const result = await new Promise((resolveExit, rejectExit) => {
		child.once("error", () => {
			processError = true;
			terminate("internal_error");
		});
		child.once("close", (exitCode, exitSignal) => resolveExit({ exitCode, signal: exitSignal }));
	});
	await Promise.all([stdoutCompleted, stderrCompleted]);
	clearTimeout(timeout);
	if (forceTimer) clearTimeout(forceTimer);
	signal?.removeEventListener("abort", abort);
	try {
		if (result.signal) {
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "attempt_exited", safePayload: { terminationKind: "signaled", signal: result.signal } });
		} else {
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "attempt_exited", safePayload: { terminationKind: "exited", exitCode: result.exitCode ?? 1 }, metrics: { exitCode: result.exitCode ?? 1 } });
		}
		if (terminationReason === "cancelled") {
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "cancelled", safePayload: {} });
		} else if (terminationReason === "recovery") {
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "recovery", kind: "recovered", safePayload: { recoveryAction: "safe_retry" } });
		} else if (terminationReason === "timeout") {
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "timeout" } });
		} else if (terminationReason === "internal_error" || normalizeFailed || processError) {
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
		} else if (result.exitCode === 0 && backendOutcome === "success") {
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "attempt_succeeded", safePayload: {} });
		} else {
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: result.exitCode === 0 ? "internal_error" : "process_exit" } });
		}
		return { attemptId, exitCode: result.exitCode, signal: result.signal, terminationReason, backendOutcome, backendVersion: supportedVersion, transientResult: backendOutcome === "success" ? transientResult : null };
	} finally {
		if (existsSync(childHome)) cleanupChildEnvironment(childHome);
	}
	} finally {
		if (child) {
			try {
				if (process.platform === "win32") {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}
				else if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if (error?.code !== "ESRCH") throw error;
			}
		}
		if (existsSync(childHome)) cleanupChildEnvironment(childHome);
	}
}
