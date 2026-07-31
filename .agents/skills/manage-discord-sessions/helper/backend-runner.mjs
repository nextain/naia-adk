import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, chmodSync, existsSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { approvalRequestedText, assertSupportedBackendVersion, getBackendAdapter, inspectBackendLine } from "./adapters.mjs";
import { readBootId, readProcessStartIdentity } from "./projector.mjs";
import { assertOwnerOnly, protectOwnerOnly, trustedWindowsSystemExecutable } from "./platform-security.mjs";

const SAFE_ENV_KEYS = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TEMP", "TMP"]);
const API_KEY_BY_BACKEND = { codex: "CODEX_API_KEY", claude: "ANTHROPIC_API_KEY" };

function processIsAlive(pid) {
	try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export function terminateUnidentifiedChild(child, { platform = process.platform, runTaskkill = (pid) => spawnSync(trustedWindowsSystemExecutable("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true }), isAlive = processIsAlive } = {}) {
	try {
		if (isAlive(child.pid) === false) return true;
		if (platform === "win32") {
			const killed = runTaskkill(child.pid);
			return killed.status === 0 && isAlive(child.pid) === false;
		}
		return child.kill("SIGKILL") === true && isAlive(child.pid) === false;
	} catch { return false; }
}

function safeCommandOptions(backendId, options) {
	const allowed = backendId === "codex" ? new Set(["sandbox", "approvalPolicy"]) : new Set(["permissionMode", "settingSources", "approvalPolicy"]);
	for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`unsupported ${backendId} command option: ${key}`);
	if (backendId === "codex" && options.sandbox && !new Set(["read-only", "workspace-write"]).has(options.sandbox)) throw new Error("unsafe Codex sandbox option");
	if (backendId === "claude" && options.permissionMode && !new Set(["dontAsk", "plan"]).has(options.permissionMode)) throw new Error("unsafe Claude permission mode");
	if (backendId === "claude" && options.settingSources && options.settingSources !== "project") throw new Error("Claude setting sources must remain project-only");
	if (options.approvalPolicy !== undefined && options.approvalPolicy !== "never") throw new Error("child approval policy must be never");
	return { ...options, approvalPolicy: "never" };
}

export function resolveExecutionCwd(cwd) {
	if (typeof cwd !== "string" || cwd.length === 0) throw new Error("execution cwd is required");
	if (!isAbsolute(cwd)) throw new Error("execution cwd must be absolute");
	const resolvedCwd = resolve(cwd);
	const stat = lstatSync(resolvedCwd);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("execution cwd must be a real directory");
	return resolvedCwd;
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
	protectOwnerOnly(resolvedPath, "directory", "private directory");
}

function copyCredential(source, target, label) {
	if (!existsSync(source)) return false;
	assertRealFile(source, label);
	assertOwnerOnly(source, "file", label);
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
	protectOwnerOnly(target, "file", label);
	return true;
}

function defaultRuntimeRoot(parentEnv) {
	const base = parentEnv.XDG_RUNTIME_DIR && resolve(parentEnv.XDG_RUNTIME_DIR) === parentEnv.XDG_RUNTIME_DIR
		? parentEnv.XDG_RUNTIME_DIR
		: join(tmpdir(), `naia-adk-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
	return join(base, "messenger-sessions");
}

export function prepareChildEnvironment({ backendId, attemptId, runtimeRoot, parentEnv = process.env, authRoot = homedir(), workspacePath = null, prepareAuthentication = true }) {
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
			if (!workspace) return true;
			const child = relative(workspace, resolvedEntry);
			return child !== "" && (child.startsWith("..") || isAbsolute(child));
		}).join(delimiter);
	}
	env.HOME = childHome;
	env.NO_COLOR = "1";
	for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "TMPDIR"]) {
		env[key] = join(childHome, key.toLowerCase());
		privateDirectory(env[key]);
	}
	const apiKeyName = API_KEY_BY_BACKEND[backendId];
	if (prepareAuthentication && apiKeyName && parentEnv[apiKeyName]) env[apiKeyName] = parentEnv[apiKeyName];
	let authenticationPrepared = Boolean(prepareAuthentication && apiKeyName && parentEnv[apiKeyName]);
	if (backendId === "codex") {
		const codexHome = join(childHome, ".codex");
		privateDirectory(codexHome);
		env.CODEX_HOME = codexHome;
		if (prepareAuthentication) authenticationPrepared ||= copyCredential(join(authRoot, ".codex", "auth.json"), join(codexHome, "auth.json"), "Codex authentication");
	} else if (backendId === "claude") {
		privateDirectory(join(childHome, ".claude"));
		if (prepareAuthentication) authenticationPrepared ||= copyCredential(join(authRoot, ".claude", ".credentials.json"), join(childHome, ".claude", ".credentials.json"), "Claude authentication");
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

function backendCommand(executable, fallback) {
	if (executable === undefined || executable === null) return { command: fallback, prefixArgs: [] };
	if (typeof executable === "string" && executable.length > 0) return { command: executable, prefixArgs: [] };
	if (typeof executable === "object" && typeof executable.command === "string" && executable.command.length > 0
		&& Array.isArray(executable.prefixArgs) && executable.prefixArgs.every((item) => typeof item === "string" && item.length > 0)) {
		return { command: executable.command, prefixArgs: [...executable.prefixArgs] };
	}
	throw new Error("backend executable contract is invalid");
}

async function probeBackendVersion(backendId, executable, parentEnv) {
	const spec = backendCommand(executable, backendId);
	const child = spawn(spec.command, [...spec.prefixArgs, "--version"], { env: { PATH: parentEnv.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
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

function lineReader(stream, onLine, onFailure, onChunk = null) {
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
		try {
			if (onChunk?.(chunk)) {
				buffered = "";
				stream.destroy();
				return;
			}
		} catch {
			onFailure(new Error("backend stream inspection failed"));
			stream.destroy();
			return;
		}
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
	const abortedResult = () => {
		const terminationReason = signal.reason === "recovery" ? "recovery" : "cancelled";
		if (terminationReason === "recovery") store.recordEvent({ jobId, source: "recovery", kind: "recovered", safePayload: { recoveryAction: "safe_retry" } });
		else store.recordEvent({ jobId, source: "helper", kind: "cancelled", safePayload: {} });
		return { attemptId: null, exitCode: null, signal: null, terminationReason, backendOutcome: null, backendVersion: backendVersion ?? null, transientResult: null };
	};
	if (signal?.aborted) return abortedResult();
	const executionCwd = resolveExecutionCwd(cwd);
	const adapter = getBackendAdapter(backendId);
	const supportedVersion = backendVersion
		? assertSupportedBackendVersion(backendId, backendVersion)
		: await probeBackendVersion(backendId, executable, parentEnv);
	const attemptId = randomUUID();
	const { childHome, env, authenticationPrepared } = prepareChildEnvironment({ backendId, attemptId, runtimeRoot, parentEnv, authRoot, workspacePath: executionCwd, prepareAuthentication: requireAuthentication });
	if (requireAuthentication && !authenticationPrepared) {
		cleanupChildEnvironment(childHome);
		throw new Error(`${backendId} authentication is not ready`);
	}
	let child;
	try {
		const spec = backendCommand(executable, backendId);
		const invocation = adapter.command({ ...safeCommandOptions(backendId, commandOptions), executable: spec.command, cwd: executionCwd });
		const windowsScript = process.platform === "win32" && /\.(?:[cm]?js)$/i.test(invocation.command);
		const spawnCommand = windowsScript ? process.execPath : invocation.command;
		const spawnArgs = windowsScript
			? [invocation.command, ...spec.prefixArgs, ...invocation.args]
			: [...spec.prefixArgs, ...invocation.args];
	if (signal?.aborted) {
		cleanupChildEnvironment(childHome);
		return abortedResult();
	}
	store.reserveAttempt(jobId, { attemptId, backendId, now: now() });
	child = spawn(spawnCommand, spawnArgs, {
			cwd: executionCwd,
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
			store.failReservedAttempt(jobId, { attemptId, now: now(), reasonCode: "internal_error" });
		} catch {}
		throw error;
	}
	const ownedBootId = readBootId();
	const ownedStartIdentity = readProcessStartIdentity(child.pid);
	if (!ownedBootId || !ownedStartIdentity) {
		const terminated = terminateUnidentifiedChild(child);
		if (terminated) {
			try { store.failReservedAttempt(jobId, { attemptId, now: now(), reasonCode: "internal_error" }); } catch {}
		}
		throw new Error("child process ownership identity is unavailable");
	}
	try {
		store.attachAttempt(jobId, { attemptId, childPid: child.pid, childBootId: ownedBootId, childStartIdentity: ownedStartIdentity, backendId, now: now() });
	} catch (error) {
		let terminated = processIsAlive(child.pid) === false;
		try {
			if (!terminated && process.platform === "win32" && child.exitCode === null && child.signalCode === null) {
				const killed = spawnSync(trustedWindowsSystemExecutable("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
				terminated = killed.status === 0 && readProcessStartIdentity(child.pid) !== ownedStartIdentity;
			} else if (!terminated) {
				terminated = child.kill("SIGKILL") === true && processIsAlive(child.pid) === false;
			}
		} catch {}
		if (terminated) {
			try { store.failAttempt(jobId, { attemptId, now: now(), reasonCode: "internal_error" }); } catch {}
		}
		throw error;
	}
	let lineNumber = 0;
	let backendOutcome = null;
	let transientResult = null;
	let processError = false;
	let terminationReason = null;
	let forceTimer = null;
	const signalProcessTree = (signalName) => {
		const currentIdentity = readProcessStartIdentity(child.pid);
		if (!currentIdentity || currentIdentity !== ownedStartIdentity) {
			try { child.kill(signalName); } catch {}
			return;
		}
		try {
			if (process.platform === "win32") {
				if (child.exitCode === null && child.signalCode === null) {
					const taskkill = trustedWindowsSystemExecutable("taskkill.exe");
					const args = ["/PID", String(child.pid), "/T"];
					if (signalName === "SIGKILL") args.push("/F");
					const killed = spawnSync(taskkill, args, { encoding: "utf8", windowsHide: true });
					if (killed.status !== 0 && child.exitCode === null && child.signalCode === null) child.kill(signalName);
				}
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
	const approvalChunkDetector = () => {
		let tail = "";
		return (chunk) => {
			tail = `${tail}${chunk}`.slice(-256);
			if (!approvalRequestedText(tail)) return false;
			terminate("approval_ui");
			return true;
		};
	};
	const recordLine = (line) => {
		lineNumber += 1;
		const inspected = inspectBackendLine({ backendId, line, attemptId, lineNumber });
		if (inspected.approvalRequested) {
			terminate("approval_ui");
			return;
		}
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
	const stdoutCompleted = lineReader(child.stdout, recordLine, streamFailure, approvalChunkDetector());
	const stderrCompleted = lineReader(child.stderr, (line) => {
		lineNumber += 1;
		if (inspectBackendLine({ backendId, line, attemptId, lineNumber }).approvalRequested) {
			terminate("approval_ui");
			return;
		}
		const bytes = Buffer.byteLength(line, "utf8");
		store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, dedupeKey: `${backendId}:stderr:${lineNumber}`, kind: "output_activity", safePayload: { bytes }, metrics: { bytes } });
	}, streamFailure, approvalChunkDetector());
	const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
	timeout.unref?.();
	const abort = () => {
		const reason = signal?.reason;
		terminate(reason === "recovery" ? "recovery" : reason === "no_progress" ? "no_progress" : reason === "operator_response_timeout" ? "operator_response_timeout" : "cancelled");
	};
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
			} else if (terminationReason === "no_progress") {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "no_progress_timeout" } });
			} else if (terminationReason === "approval_ui") {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "approval_ui_detected" } });
			} else if (terminationReason === "operator_response_timeout") {
				if (store.getJob(jobId, { includeEvents: false })?.lifecycle !== "recovery_review") {
					store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
				}
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
