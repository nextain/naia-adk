import { spawn, spawnSync } from "node:child_process";
import { assertSupportedBackendVersion } from "./adapters.mjs";
import { readBootId, readProcessStartIdentity } from "./projector.mjs";
import { trustedWindowsSystemExecutable } from "./platform-security.mjs";

function processIsAlive(pid) {
	try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function processGroupIsAlive(pid) {
	try { process.kill(-pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function waitForChildExit(child, timeoutMs = 2_000, group = false) {
	const alive = () => group ? processGroupIsAlive(child.pid) : processIsAlive(child.pid);
	if (!group && (child.exitCode !== null || child.signalCode !== null || alive() === false)) return Promise.resolve(true);
	if (group && alive() === false) return Promise.resolve(true);
	return new Promise((resolveExit) => {
		let settled = false;
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(poll);
			resolveExit(exited);
		};
		const check = () => { if (alive() === false) finish(true); };
		child.once("exit", group ? check : () => finish(true));
		child.once("close", group ? check : () => finish(true));
		const poll = group ? setInterval(check, 10) : null;
		poll?.unref?.();
		const timer = setTimeout(() => finish(alive() === false), timeoutMs);
		timer.unref?.();
	});
}

export async function killAndWaitForChild(child, ownedStartIdentity = null) {
	try {
		if (process.platform === "win32") {
			if (processIsAlive(child.pid) === false) return true;
			const killed = spawnSync(trustedWindowsSystemExecutable("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
			if (killed.status !== 0 && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		} else {
			if (ownedStartIdentity === null) {
				if (child.exitCode !== null || child.signalCode !== null) return processGroupIsAlive(child.pid) === false;
				child.kill("SIGKILL");
				return waitForChildExit(child, 2_000, false);
			}
			const currentIdentity = readProcessStartIdentity(child.pid);
			if (currentIdentity !== ownedStartIdentity) {
				if (currentIdentity === null && child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
					return waitForChildExit(child, 2_000, false);
				}
				return processGroupIsAlive(child.pid) === false;
			}
			process.kill(-child.pid, "SIGKILL");
		}
	} catch {}
	return waitForChildExit(child, 2_000, process.platform !== "win32");
}

export function backendCommand(executable, fallback) {
	if (executable === undefined || executable === null) return { command: fallback, prefixArgs: [] };
	if (typeof executable === "string" && executable.length > 0) return { command: executable, prefixArgs: [] };
	if (typeof executable === "object" && typeof executable.command === "string" && executable.command.length > 0
		&& Array.isArray(executable.prefixArgs) && executable.prefixArgs.every((item) => typeof item === "string" && item.length > 0)) {
		return { command: executable.command, prefixArgs: [...executable.prefixArgs] };
	}
	throw new Error("backend executable contract is invalid");
}

export async function probeBackendVersion(backendId, executable, parentEnv, { signal, timeoutMs = 5_000 } = {}) {
	const spec = backendCommand(executable, backendId);
	const child = spawn(spec.command, [...spec.prefixArgs, "--version"], { env: { PATH: parentEnv.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
	const ownedStartIdentity = process.platform === "win32" ? null : readProcessStartIdentity(child.pid);
	let output = "";
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => { if (output.length < 4_096) output += chunk.slice(0, 4_096 - output.length); });
	}
	let cancel;
	const cancellation = new Promise((resolveCancellation) => { cancel = resolveCancellation; });
	let cancelling = false;
	let cancellationReason = null;
	const stop = (reason) => {
		if (cancelling) return;
		cancelling = true;
		cancellationReason = reason;
		void (async () => {
			await killAndWaitForChild(child, ownedStartIdentity);
			cancel({ reason });
		})();
	};
	const timer = setTimeout(() => stop("timeout"), timeoutMs);
	timer.unref?.();
	const abort = () => stop("aborted");
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	let result;
	try {
		result = await Promise.race([
			new Promise((resolveExit, rejectExit) => {
				child.once("error", rejectExit);
				child.once("close", (exitCode) => resolveExit({ exitCode, reason: cancellationReason }));
			}),
			cancellation,
		]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
	if (result.reason === "timeout") throw new Error(`${backendId} version probe timed out`);
	if (result.reason === "aborted") throw new Error(`${backendId} version probe aborted`);
	if (result.exitCode !== 0) throw new Error(`${backendId} version probe failed`);
	return assertSupportedBackendVersion(backendId, output);
}

export function captureChildOwnership(child) {
	const bootId = readBootId();
	const startIdentity = readProcessStartIdentity(child.pid);
	return bootId && startIdentity ? { bootId, startIdentity } : null;
}

export function createOwnedProcessTreeSignaler(child, ownedStartIdentity) {
	return (signalName) => {
		try {
			if (process.platform === "win32") {
				if (child.exitCode === null && child.signalCode === null) {
					const taskkill = trustedWindowsSystemExecutable("taskkill.exe");
					const args = ["/PID", String(child.pid), "/T"];
					if (signalName === "SIGKILL") args.push("/F");
					const killed = spawnSync(taskkill, args, { encoding: "utf8", windowsHide: true });
					if (killed.status !== 0 && child.exitCode === null && child.signalCode === null) child.kill(signalName);
				}
			} else {
				const currentIdentity = readProcessStartIdentity(child.pid);
				if (currentIdentity !== ownedStartIdentity) return;
				process.kill(-child.pid, signalName);
			}
		} catch (error) {
			if (error?.code !== "ESRCH") throw error;
		}
	};
}
