import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { approvalRequestedText, assertSupportedBackendVersion, getBackendAdapter, inspectBackendLine } from "./adapters.mjs";
import { cleanupChildEnvironment, prepareChildEnvironment, resolveExecutionCwd } from "./backend-child-environment.mjs";
import { backendCommand, captureChildOwnership, createOwnedProcessTreeSignaler, killAndWaitForChild, probeBackendVersion } from "./backend-owned-process.mjs";
import { boundedSafeExcerpt, sanitizeFinalResponse } from "./sanitize.mjs";

export { cleanupChildEnvironment, prepareChildEnvironment, resolveExecutionCwd } from "./backend-child-environment.mjs";

function safeCommandOptions(backendId, options) {
	const allowed = backendId === "codex" ? new Set(["sandbox", "approvalPolicy", "model", "costProfile"]) : new Set(["permissionMode", "approvalPolicy"]);
	for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`unsupported ${backendId} command option: ${key}`);
	if (backendId === "codex" && options.sandbox && !new Set(["read-only", "workspace-write"]).has(options.sandbox)) throw new Error("unsafe Codex sandbox option");
	if (backendId === "codex" && options.model !== undefined && (typeof options.model !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(options.model))) throw new Error("unsafe Codex model option");
	if (backendId === "codex" && options.costProfile !== undefined && !new Set(["control", "balanced", "economy"]).has(options.costProfile)) throw new Error("unsafe Codex cost profile option");
	if (backendId === "claude" && options.permissionMode && !new Set(["dontAsk", "plan"]).has(options.permissionMode)) throw new Error("unsafe Claude permission mode");
	if (options.approvalPolicy !== undefined && options.approvalPolicy !== "never") throw new Error("child approval policy must be never");
	return { ...options, approvalPolicy: "never" };
}

function writePrompt(child, prompt) {
	child.stdin.end(prompt, "utf8");
}

export function isBenignBackendStdinError(error) {
	return new Set(["EPIPE", "ERR_STREAM_DESTROYED"]).has(error?.code);
}

function withFailureCode(error, code) {
	if (error && typeof error === "object") error.code = code;
	return error;
}

const MAX_STREAM_LINE_BYTES = 256 * 1024;
const STREAM_DRAIN_TIMEOUT_MS = 500;

function lineReader(stream, onLine, onFailure, onChunk = null, onOversizedLine = onFailure) {
	let buffered = "";
	let discardingOversizedLine = false;
	stream.setEncoding("utf8");
	const completed = new Promise((resolve) => {
		stream.once("end", () => {
			if (!discardingOversizedLine) {
				const line = buffered.trim();
				if (line) {
					try {
						if (Buffer.byteLength(line, "utf8") > MAX_STREAM_LINE_BYTES) onOversizedLine(new Error("backend stream line exceeded the safe limit"));
						else onLine(line);
					} catch { onFailure(new Error("backend stream normalization failed")); }
				}
			}
			resolve();
		});
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
		let remaining = chunk;
		if (discardingOversizedLine) {
			const newline = remaining.indexOf("\n");
			if (newline < 0) return;
			remaining = remaining.slice(newline + 1);
			discardingOversizedLine = false;
		}
		buffered += remaining;
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) {
				if (Buffer.byteLength(buffered, "utf8") > MAX_STREAM_LINE_BYTES) {
					buffered = "";
					discardingOversizedLine = true;
					try { onOversizedLine(new Error("backend stream line exceeded the safe limit")); } catch { onFailure(new Error("backend stream normalization failed")); }
				}
				break;
			}
			const line = buffered.slice(0, newline).trimEnd();
			buffered = buffered.slice(newline + 1);
			if (line) {
				try {
					if (Buffer.byteLength(line, "utf8") > MAX_STREAM_LINE_BYTES) onOversizedLine(new Error("backend stream line exceeded the safe limit"));
					else onLine(line);
				} catch { onFailure(new Error("backend stream normalization failed")); }
			}
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
	versionProbeTimeoutMs = 5_000,
	requireAuthentication = true,
	now = () => new Date().toISOString(),
	onSafeEvent = null,
	preSpawnCheck = null,
}) {
	if (typeof prompt !== "string" || prompt.length === 0) throw new Error("prompt must be a non-empty string");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive safe integer");
	if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) throw new Error("killGraceMs must be a non-negative safe integer");
	if (!Number.isSafeInteger(versionProbeTimeoutMs) || versionProbeTimeoutMs < 50 || versionProbeTimeoutMs > 30_000) throw new Error("versionProbeTimeoutMs must be between 50 and 30000");
	const abortedResult = () => {
		const terminationReason = signal.reason === "recovery" ? "recovery" : "cancelled";
		if (terminationReason === "recovery") store.recordEvent({ jobId, source: "recovery", kind: "recovered", safePayload: { recoveryAction: "safe_retry" } });
		else store.recordEvent({ jobId, source: "helper", kind: "cancelled", safePayload: {} });
		return { attemptId: null, exitCode: null, signal: null, terminationReason, backendOutcome: null, backendVersion: backendVersion ?? null, transientResult: null };
	};
	if (signal?.aborted) return abortedResult();
	const executionCwd = resolveExecutionCwd(cwd);
	const adapter = getBackendAdapter(backendId);
	let supportedVersion;
	try {
		supportedVersion = backendVersion
			? assertSupportedBackendVersion(backendId, backendVersion)
			: await probeBackendVersion(backendId, executable, parentEnv, { signal, timeoutMs: versionProbeTimeoutMs });
	} catch (error) {
		if (signal?.aborted) return abortedResult();
		throw withFailureCode(error, "backend_version_probe_failed");
	}
	const attemptId = randomUUID();
	let childEnvironment;
	try {
		childEnvironment = prepareChildEnvironment({ backendId, attemptId, runtimeRoot, parentEnv, authRoot, workspacePath: executionCwd, prepareAuthentication: requireAuthentication });
	} catch (error) {
		throw withFailureCode(error, "backend_authentication_failed");
	}
	const { childHome, env, authenticationPrepared } = childEnvironment;
	if (requireAuthentication && !authenticationPrepared) {
		cleanupChildEnvironment(childHome);
		throw Object.assign(new Error(`${backendId} authentication is not ready`), { code: "backend_authentication_failed" });
	}
	let child;
	let signalOwnedProcessTree = null;
	try {
		const spec = backendCommand(executable, backendId);
		let invocation;
		try { invocation = adapter.command({ ...safeCommandOptions(backendId, commandOptions), executable: spec.command, cwd: executionCwd }); }
		catch (error) { throw withFailureCode(error, "backend_invocation_invalid"); }
		const windowsScript = process.platform === "win32" && /\.(?:[cm]?js)$/i.test(invocation.command);
		const spawnCommand = windowsScript ? process.execPath : invocation.command;
		const spawnArgs = windowsScript
			? [invocation.command, ...spec.prefixArgs, ...invocation.args]
			: [...spec.prefixArgs, ...invocation.args];
		if (signal?.aborted) {
			cleanupChildEnvironment(childHome);
			return abortedResult();
		}
		if (preSpawnCheck !== null && typeof preSpawnCheck !== "function") throw new Error("preSpawnCheck must be a function");
		preSpawnCheck?.();
		store.reserveAttempt(jobId, { attemptId, backendId, now: now() });
		try { preSpawnCheck?.(); }
		catch (error) {
			try { store.failReservedAttempt(jobId, { attemptId, now: now(), reasonCode: error?.code === "context_changed_restart_required" ? "context_changed_restart_required" : "internal_error" }); } catch {}
			throw error;
		}
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
			throw withFailureCode(error, "backend_spawn_failed");
		}
		const ownership = captureChildOwnership(child);
		if (!ownership) {
			const terminated = await killAndWaitForChild(child);
			if (terminated) {
				try { store.failReservedAttempt(jobId, { attemptId, now: now(), reasonCode: "internal_error" }); } catch {}
			}
			throw new Error("child process ownership identity is unavailable");
		}
		const { bootId: ownedBootId, startIdentity: ownedStartIdentity } = ownership;
		try {
			store.attachAttempt(jobId, { attemptId, childPid: child.pid, childBootId: ownedBootId, childStartIdentity: ownedStartIdentity, backendId, now: now() });
		} catch (error) {
			const terminated = await killAndWaitForChild(child, ownedStartIdentity);
			if (terminated) {
				try { store.failAttempt(jobId, { attemptId, now: now(), reasonCode: "internal_error" }); }
				catch {
					try { store.failReservedAttempt(jobId, { attemptId, now: now(), reasonCode: "internal_error" }); } catch {}
				}
			}
			throw error;
		}
		let lineNumber = 0;
		let backendOutcome = null;
		let transientResult = null;
		let pendingAssistantText = null;
		let progressSequence = 0;
		let processError = false;
		let terminationReason = null;
		let forceTimer = null;
		const signalProcessTree = createOwnedProcessTreeSignaler(child, ownedStartIdentity);
		signalOwnedProcessTree = signalProcessTree;
		const terminate = (reason) => {
			if (terminationReason) return;
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
		const recordProgress = (text) => {
			const safe = boundedSafeExcerpt(text);
			if (!safe) return;
			progressSequence += 1;
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, dedupeKey: `${backendId}:progress:${attemptId}:${progressSequence}`, kind: "progress_reported", safePayload: { excerpt: safe.excerpt }, metrics: { truncated: safe.truncated }, redactionLevel: "local_safe" });
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
			if (inspected.assistantText !== null && inspected.assistantText !== pendingAssistantText) {
				if (pendingAssistantText !== null) recordProgress(pendingAssistantText);
				pendingAssistantText = inspected.assistantText;
			}
			for (const event of inspected.events) {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, ...event });
				try { onSafeEvent?.(event); } catch {}
			}
		};
		let normalizeFailed = false;
		const streamFailure = () => {
			normalizeFailed = true;
			terminate("internal_error");
		};
		// Codex stdout is structured JSON. Do not scan raw tool output or agent text
		// for approval words: ordinary diagnostics can legitimately contain phrases
		// such as "approval request". Explicit structured events are checked by the
		// adapter, while an actual interactive prompt on stderr is still rejected.
		const oversizedStdoutLine = () => {
			lineNumber += 1;
			const bytes = MAX_STREAM_LINE_BYTES + 1;
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, dedupeKey: `${backendId}:stdout-oversized:${lineNumber}`, kind: "output_activity", safePayload: { bytes }, metrics: { bytes } });
		};
		const stdoutCompleted = lineReader(child.stdout, recordLine, streamFailure, null, oversizedStdoutLine);
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
			terminate(reason === "recovery" ? "recovery" : reason === "no_progress" ? "no_progress" : "cancelled");
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		// A backend can close its stdin after consuming the one-shot prompt while it
		// is still flushing the final structured result. Node may surface that normal
		// pipe close as EPIPE/ERR_STREAM_DESTROYED. The exit code and structured
		// completion marker remain authoritative; cancelling here discards a valid
		// final response during an otherwise clean exit.
		child.stdin.on("error", (error) => {
			if (!isBenignBackendStdinError(error)) terminate("internal_error");
		});
		writePrompt(child, prompt);
		const result = await new Promise((resolveExit) => {
			let settled = false;
			const finish = (exitCode, exitSignal) => {
				if (settled) return;
				settled = true;
				resolveExit({ exitCode, signal: exitSignal });
			};
			child.once("error", () => {
				processError = true;
				terminate("internal_error");
			});
			child.once("exit", finish);
			if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode, child.signalCode);
		});
		const streamsCompleted = Promise.all([stdoutCompleted, stderrCompleted]);
		let drainTimer;
		const streamsDrained = await Promise.race([
			streamsCompleted.then(() => true),
			new Promise((resolveDrain) => {
				drainTimer = setTimeout(() => resolveDrain(false), STREAM_DRAIN_TIMEOUT_MS);
				drainTimer.unref?.();
			}),
		]);
		clearTimeout(drainTimer);
		if (!streamsDrained) {
			terminate("internal_error");
			let forcedDrainTimer;
			const drainedAfterTermination = await Promise.race([
				streamsCompleted.then(() => true),
				new Promise((resolveDrain) => {
					forcedDrainTimer = setTimeout(() => resolveDrain(false), killGraceMs + 250);
					forcedDrainTimer.unref?.();
				}),
			]);
			clearTimeout(forcedDrainTimer);
			if (!drainedAfterTermination) {
				signalProcessTree("SIGKILL");
				child.stdout.destroy();
				child.stderr.destroy();
				await streamsCompleted;
			}
		}
		clearTimeout(timeout);
		if (forceTimer) clearTimeout(forceTimer);
		signal?.removeEventListener("abort", abort);
		try {
			if (result.signal) {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "attempt_exited", safePayload: { terminationKind: "signaled", signal: result.signal } });
			} else {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "attempt_exited", safePayload: { terminationKind: "exited", exitCode: result.exitCode ?? 1 }, metrics: { exitCode: result.exitCode ?? 1 } });
			}
			if (!(result.exitCode === 0 && backendOutcome === "success") && pendingAssistantText !== null) recordProgress(pendingAssistantText);
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
			} else if (terminationReason === "internal_error" || normalizeFailed || processError) {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
			} else if (result.exitCode === 0 && backendOutcome === "success") {
				if (pendingAssistantText !== null && pendingAssistantText !== transientResult) recordProgress(pendingAssistantText);
				if (transientResult !== null) {
					try {
						const safeResult = boundedSafeExcerpt(sanitizeFinalResponse(transientResult));
						if (safeResult) store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, dedupeKey: `${backendId}:result:${attemptId}`, kind: "result_reported", safePayload: { excerpt: safeResult.excerpt }, metrics: { truncated: safeResult.truncated }, redactionLevel: "local_safe" });
					} catch {}
				}
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
				else signalOwnedProcessTree?.("SIGKILL");
			} catch (error) {
				if (error?.code !== "ESRCH") throw error;
			}
		}
		if (existsSync(childHome)) cleanupChildEnvironment(childHome);
	}
}
