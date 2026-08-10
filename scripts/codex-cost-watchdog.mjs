#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const contracts = require("../.agents/hooks/core/session-contract.js");
const usage = require("./codex-lineage-usage.cjs");

export const DEFAULT_MAX_TOOL_MS = 900_000;
export const DEFAULT_WATCH_INTERVAL_MS = 5_000;
export const WATCHDOG_HEARTBEAT_MAX_AGE_MS = DEFAULT_WATCH_INTERVAL_MS * 3;

export function watchdogProjectRoot({ cwd = process.cwd(), env = process.env } = {}) {
	return contracts.resolveHookProjectRoot(cwd, env) || cwd;
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

export function policyIdentity(policy) {
	return crypto.createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

export function lastOutstandingToolStart(file) {
	const calls = new Map();
	const anonymous = [];
	const scan = usage.scanJsonLines(file, (row) => {
		const type = row?.type === "response_item" ? row.payload?.type : null;
		const timestamp = Date.parse(row?.timestamp);
		if (!type || !Number.isFinite(timestamp)) return;
		const callId = row.payload?.call_id || row.payload?.id || row.payload?.item?.call_id || row.payload?.item?.id || null;
		if (type.endsWith("_call") && !type.endsWith("_call_output")) {
			if (callId) calls.set(callId, timestamp);
			else anonymous.push(timestamp);
		}
		if (type.endsWith("_call_output")) {
			if (callId) calls.delete(callId);
			else if (anonymous.length === 1) anonymous.shift();
		}
	});
	if (scan.malformedLines || scan.malformedTrailingRow) throw new Error("malformed rollout evidence");
	const outstanding = [...calls.values(), ...anonymous];
	return outstanding.length ? Math.min(...outstanding) : null;
}

function readEnvironment(root, pid) {
	try {
		const value = fs.readFileSync(path.join(root, String(pid), "environ"));
		const entry = value.toString().split("\0").find((item) => item.startsWith("CODEX_THREAD_ID="));
		return entry ? entry.slice("CODEX_THREAD_ID=".length) : null;
	} catch { return null; }
}

function processStat(root, pid) {
	try {
		const stat = fs.readFileSync(path.join(root, String(pid), "stat"), "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const parent = Number(fields[1]);
		const startTime = fields[19];
		if (!Number.isSafeInteger(parent) || parent < 0 || !/^\d+$/.test(startTime || "")) return { parentPid: null, startTime: null, ambiguous: true };
		return { parentPid: parent > 1 ? parent : null, startTime, ambiguous: false };
	} catch { return { parentPid: null, startTime: null, ambiguous: true }; }
}

function commandName(root, pid) {
	try { return fs.readFileSync(path.join(root, String(pid), "comm"), "utf8").trim(); } catch { return ""; }
}

function directRolloutIds(root, pid) {
	const ids = new Set();
	let malformed = false;
	let entries;
	try { entries = fs.readdirSync(path.join(root, String(pid), "fd")); } catch { return { ids, malformed: true }; }
	for (const entry of entries) {
		let target;
		try { target = fs.readlinkSync(path.join(root, String(pid), "fd", entry)); } catch { continue; }
		if (!target.endsWith(".jsonl")) continue;
		try {
			const session = usage.readSession(path.resolve(target));
			if (session?.sessionId) ids.add(session.sessionId);
			else malformed = true;
		} catch { malformed = true; }
	}
	return { ids, malformed };
}

function rolloutIds(root, pid) {
	const ids = new Set();
	let malformed = false;
	let current = pid;
	const seen = new Set();
	while (current && !seen.has(current)) {
		seen.add(current);
		const direct = directRolloutIds(root, current);
		for (const id of direct.ids) ids.add(id);
		malformed ||= direct.malformed;
		const stat = processStat(root, current);
		if (stat.ambiguous) { malformed = true; break; }
		current = stat.parentPid;
	}
	if (current && seen.has(current)) malformed = true;
	return { ids, malformed };
}

export function sessionIdentity({ explicitId = process.env.CODEX_THREAD_ID, procRoot = "/proc", pid = process.pid } = {}) {
	const result = rolloutIds(procRoot, pid);
	const explicit = typeof explicitId === "string" && explicitId.length > 0;
	const claimedId = explicit ? explicitId : result.ids.size === 1 ? [...result.ids][0] : null;
	if (result.malformed || result.ids.size > 1 || (explicit && [...result.ids].some((id) => id !== explicitId))) {
		return { id: null, claimedId, ambiguous: true, source: "failed-closed" };
	}
	if (explicit) return { id: explicitId, claimedId, ambiguous: false, source: "explicit" };
	return { id: claimedId, claimedId, ambiguous: result.ids.size !== 1, source: "linux-ancestors" };
}

export function activeCodexThreads({ procRoot = "/proc" } = {}) {
	let entries;
	try { entries = fs.readdirSync(procRoot, { withFileTypes: true }); } catch { throw new Error("Codex process discovery is unavailable"); }
	const processes = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const pid = Number(entry.name);
		processes.push({ pid, command: commandName(procRoot, pid), stat: processStat(procRoot, pid) });
	}
	const byPid = new Map(processes.map((item) => [item.pid, item]));
	const hasCodexAncestor = (process) => {
		let parent = process.stat.parentPid;
		const seen = new Set();
		while (parent && !seen.has(parent)) {
			seen.add(parent);
			const candidate = byPid.get(parent);
			if (!candidate) return false;
			if (candidate.command === "codex") return true;
			parent = candidate.stat.parentPid;
		}
		return false;
	};
	const threads = [];
	const ambiguities = [];
	for (const process of processes) {
		const { pid, command, stat } = process;
		if (command !== "codex" && !hasCodexAncestor(process)) continue;
		const explicitId = readEnvironment(procRoot, pid);
		const direct = command === "codex" ? null : directRolloutIds(procRoot, pid);
		const directHost = Boolean(explicitId) && !direct?.malformed && direct?.ids.size === 1 && direct.ids.has(explicitId);
		if (command !== "codex" && !directHost) {
			if (explicitId && (direct?.malformed || direct?.ids.size > 0)) ambiguities.push({ rootPid: pid, claimedSessionId: explicitId });
			continue;
		}
		const identity = sessionIdentity({ procRoot, pid, explicitId });
		if (!identity.ambiguous && identity.id && !stat.ambiguous) threads.push({ sessionId: identity.id, rootPid: pid, processStartTime: stat.startTime });
		else ambiguities.push({ rootPid: pid, claimedSessionId: identity.claimedId || null });
	}
	Object.defineProperty(threads, "ambiguities", { value: ambiguities, enumerable: false });
	return threads;
}

export function loadConfiguredLineages({ projectRoot = process.cwd(), codexHome, contractResolver = (value) => contracts.resolveSessionContract(value) } = {}) {
	let registryText;
	try { registryText = fs.readFileSync(path.join(projectRoot, ".agents", "session-contracts", ".session-map.json"), "utf8"); }
	catch (error) {
		// The registry is host-local and gitignored (see .agents/session-contracts/README.md), so a fresh
		// checkout with no bound session yet has none. That is "no configured lineages", not a failure.
		if (error?.code === "ENOENT") return [];
		throw new Error("Configured lineage registry is unreadable");
	}
	let registry;
	try { registry = JSON.parse(registryText); }
	catch { throw new Error("Configured lineage registry is missing or malformed"); }
	if (!registry || typeof registry !== "object" || Array.isArray(registry) || !registry.bindings || typeof registry.bindings !== "object" || Array.isArray(registry.bindings)) {
		throw new Error("Configured lineage registry is invalid");
	}
	const groups = new Map();
	for (const sessionId of Object.keys(registry.bindings || {})) {
		const resolved = contractResolver({ cwd: projectRoot, sessionId });
		if (resolved?.status !== contracts.STATES.BOUND) {
			throw new Error(`Configured lineage contract is not bound for ${sessionId}`);
		}
		if (!Object.hasOwn(resolved.contract || {}, "subagent_policy")) continue;
		const policy = resolved.contract.subagent_policy;
		if (contracts.validateSubagentPolicy(policy)) throw new Error(`Configured lineage subagent_policy is invalid for ${sessionId}`);
		const identity = policyIdentity(policy);
		const key = `${resolved.contract.id}:${identity}`;
		const group = groups.get(key) || { policy, policyIdentity: identity, sessionIds: [] };
		group.sessionIds.push(sessionId);
		groups.set(key, group);
	}
	const result = new Map();
	for (const group of groups.values()) {
		const collected = usage.collectSessions({ codexHome, since: Date.parse(group.policy.budget_started_at), includeSessionIds: group.sessionIds });
		if (collected.ambiguous) throw new Error("Configured lineage evidence is ambiguous");
		for (const sessionId of group.sessionIds) {
			const lineage = usage.findLineage(collected, sessionId, group.policy);
			if (!lineage || lineage.ambiguous) throw new Error(`Configured lineage is missing or ambiguous for ${sessionId}`);
			result.set(`${lineage.rootId}:${group.policyIdentity}`, { ...lineage, policy: group.policy });
		}
	}
	return [...result.values()];
}

export function selectInterruptions({ threads, lineages, now = Date.now(), maxToolMs = DEFAULT_MAX_TOOL_MS }) {
	if (!Number.isSafeInteger(maxToolMs) || maxToolMs < 60_000) throw new Error("maxToolMs");
	return threads.flatMap((thread) => {
		const lineage = lineages.find((item) => item.rootId !== thread.sessionId && item.members.includes(thread.sessionId));
		if (!lineage || usage.evaluateLineage(lineage, { policy: lineage.policy }).ok) return [];
		const rollout = lineage.sessionRollouts?.[thread.sessionId];
		if (!rollout) return [];
		let outstandingSince = null;
		try {
			outstandingSince = lastOutstandingToolStart(rollout);
		} catch {
			// The lineage is already over budget. Corrupt or concurrently-written
			// rollout evidence must not disable the interrupt path.
		}
		return [{
			...thread,
			rootId: lineage.rootId,
			outstandingMs: outstandingSince === null ? null : now - outstandingSince,
			toolOverdue: outstandingSince !== null && now - outstandingSince >= maxToolMs,
		}];
	});
}

export function processMatchesCandidate(procRoot, candidate) {
	const current = processStat(procRoot, candidate.rootPid);
	if (current.ambiguous || current.startTime !== candidate.processStartTime) return false;
	const command = commandName(procRoot, candidate.rootPid);
	const explicitId = readEnvironment(procRoot, candidate.rootPid);
	if (command !== "codex") {
		const direct = directRolloutIds(procRoot, candidate.rootPid);
		if (!explicitId || direct.malformed || direct.ids.size !== 1 || !direct.ids.has(explicitId)) return false;
	}
	const identity = sessionIdentity({ procRoot, pid: candidate.rootPid, explicitId });
	return !identity.ambiguous && identity.id === candidate.sessionId;
}

export function runOnce({ enforce = false, procRoot = "/proc", projectRoot = process.cwd(), codexHome, configuredLineages = null, now = Date.now(), maxToolMs = DEFAULT_MAX_TOOL_MS, signal = (pid) => process.kill(pid, "SIGINT"), processValidator = processMatchesCandidate } = {}) {
	const threads = activeCodexThreads({ procRoot });
	const lineages = configuredLineages || loadConfiguredLineages({ projectRoot, codexHome });
	const governedSessionIds = new Set(lineages.flatMap((lineage) => lineage.members || []));
	const governedAmbiguities = threads.ambiguities.filter((item) => item.claimedSessionId && governedSessionIds.has(item.claimedSessionId));
	if (enforce && governedAmbiguities.length > 0) throw new Error("Governed Codex process identity is ambiguous; enforcement denied");
	const candidates = selectInterruptions({ threads, lineages, now, maxToolMs });
	const interrupted = [];
	if (enforce) for (const candidate of candidates) {
		if (!processValidator(procRoot, candidate)) continue;
		try {
			signal(candidate.rootPid);
			interrupted.push(candidate);
		} catch (error) {
			if (error?.code !== "ESRCH") throw error;
		}
	}
	return { observedAt: new Date(now).toISOString(), enforce, activeThreads: threads.length, ambiguousThreads: threads.ambiguities, configuredLineages: lineages.length, candidates, interrupted };
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeReceipt(file, value) {
	if (!file) return;
	const directory = path.dirname(file);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
	writeDurableState(file, value);
}

export async function watchLoop({
	run = runOnce,
	runOptions = {},
	intervalMs = DEFAULT_WATCH_INTERVAL_MS,
	iterations = Number.POSITIVE_INFINITY,
	receiptFile = null,
	heartbeat = null,
} = {}) {
	if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) throw new Error("intervalMs");
	if (!(iterations === Number.POSITIVE_INFINITY || Number.isSafeInteger(iterations) && iterations > 0)) throw new Error("iterations");
	let completed = 0;
	let latest = null;
	while (completed < iterations) {
		try {
			latest = run(runOptions);
			writeReceipt(receiptFile, { ...heartbeat, ok: true, ...latest });
		} catch (error) {
			latest = { ...heartbeat, observedAt: new Date().toISOString(), ok: false, error: error?.message || String(error) };
			writeReceipt(receiptFile, latest);
			throw error;
		}
		completed += 1;
		if (completed < iterations) await sleep(intervalMs);
	}
	return latest;
}

function watcherStateFile(projectRoot, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
	const identity = crypto.createHash("sha256").update(fs.realpathSync(projectRoot)).digest("hex").slice(0, 24);
	return path.join(codexHome, "adk-cost-watchdogs", `${identity}.json`);
}

function writeDurableState(file, value) {
	const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	let descriptor;
	let renamed = false;
	try {
		descriptor = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, file);
		renamed = true;
		const directoryDescriptor = fs.openSync(path.dirname(file), "r");
		try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		if (!renamed) {
			try { fs.unlinkSync(temporary); } catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
	}
}

function processIsThisWatcher(pid, scriptFile) {
	if (!Number.isSafeInteger(pid) || pid < 2 || process.platform !== "linux") return false;
	try {
		const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		return commandLine.includes(fs.realpathSync(scriptFile)) && commandLine.includes("--watch");
	} catch {
		return false;
	}
}

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function heartbeatIsFresh(receipt, state, now = Date.now()) {
	if (!receipt || receipt.ok !== true || receipt.pid !== state?.pid) return false;
	if (receipt.projectRoot !== state.projectRoot || receipt.scriptFile !== state.scriptFile) return false;
	const observedAt = Date.parse(receipt.observedAt);
	return Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= WATCHDOG_HEARTBEAT_MAX_AGE_MS
		&& (!state.policyIdentity || receipt.policyIdentity === state.policyIdentity);
}

export function ensureWatchdog({
	projectRoot = process.cwd(),
	codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
	scriptFile = fileURLToPath(import.meta.url),
	spawnProcess = spawn,
	platform = process.platform,
	heartbeatWaitMs = 2_000,
	processValidator = processIsThisWatcher,
	processKiller = process.kill,
	processStopWaitMs = 1_000,
} = {}) {
	if (platform !== "linux") throw new Error("Codex descendant cost watchdog requires Linux process identity enforcement");
	const stateFile = watcherStateFile(projectRoot, codexHome);
	const lockFile = `${stateFile}.lock`;
	fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
	fs.chmodSync(path.dirname(stateFile), 0o700);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		let descriptor;
		let spawnedPid = null;
		try {
			descriptor = fs.openSync(lockFile, "wx", 0o600);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			let age = 0;
			try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { continue; }
			if (age <= 10_000) return { started: false, reason: "startup_in_progress", stateFile };
			try { fs.unlinkSync(lockFile); } catch (unlinkError) {
				if (unlinkError?.code !== "ENOENT") throw unlinkError;
			}
			continue;
		}
		try {
			let state = null;
			state = readJson(stateFile);
			const watcherAlive = processValidator(state?.pid, scriptFile);
			if (watcherAlive && heartbeatIsFresh(readJson(`${stateFile}.receipt`), state)) {
				return { started: false, pid: state.pid, stateFile };
			}
			if (watcherAlive) {
				try {
					processKiller(state.pid, "SIGTERM");
				} catch (error) {
					if (error?.code !== "ESRCH") throw error;
				}
				const stopDeadline = Date.now() + processStopWaitMs;
				while (Date.now() < stopDeadline && processValidator(state.pid, scriptFile)) {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
				}
				if (processValidator(state.pid, scriptFile)) throw new Error("stalled watchdog did not terminate");
			}
			try { fs.unlinkSync(stateFile); } catch (unlinkError) {
				if (unlinkError?.code !== "ENOENT") throw unlinkError;
			}
			const child = spawnProcess(process.execPath, [
				fs.realpathSync(scriptFile),
				"--enforce",
				"--watch",
				"--project-root",
				fs.realpathSync(projectRoot),
				"--state-file",
				stateFile,
			], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, ADK_PROJECT_ROOT: fs.realpathSync(projectRoot) },
			});
			if (!Number.isSafeInteger(child?.pid) || child.pid < 2 || typeof child.unref !== "function") {
				throw new Error("watchdog spawn did not return a valid detached process");
			}
			spawnedPid = child.pid;
			const durableState = { pid: child.pid, projectRoot: fs.realpathSync(projectRoot), scriptFile: fs.realpathSync(scriptFile) };
			writeDurableState(stateFile, durableState);
			child.unref();
			const deadline = Date.now() + heartbeatWaitMs;
			while (Date.now() < deadline) {
				if (heartbeatIsFresh(readJson(`${stateFile}.receipt`), durableState)) return { started: true, pid: child.pid, stateFile };
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
			}
			throw new Error("watchdog did not publish a fresh heartbeat");
		} catch (error) {
			let state = null;
			try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
			if (spawnedPid && state?.pid === spawnedPid) {
				try { fs.unlinkSync(stateFile); } catch (unlinkError) {
					if (unlinkError?.code !== "ENOENT") throw unlinkError;
				}
			}
			throw error;
		} finally {
			fs.closeSync(descriptor);
			try { fs.unlinkSync(lockFile); } catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
	}
	throw new Error("watchdog state acquisition failed");
}

function argumentValue(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const projectRoot = argumentValue("--project-root") || watchdogProjectRoot();
	const enforce = process.argv.includes("--enforce");
	const stateFile = argumentValue("--state-file");
	if (process.argv.includes("--watch")) {
		const receiptFile = stateFile ? `${stateFile}.receipt` : null;
		try {
			if (stateFile) {
				let ownsState = false;
				for (let attempt = 0; attempt < 40; attempt += 1) {
					let state = null;
					try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
					if (state?.pid === process.pid) { ownsState = true; break; }
					if (state?.pid && state.pid !== process.pid) break;
					await sleep(25);
				}
				if (!ownsState) throw new Error("watchdog did not acquire its durable state identity");
			}
			await watchLoop({
				runOptions: { enforce, projectRoot },
				receiptFile,
				heartbeat: stateFile ? {
					pid: process.pid,
					projectRoot: fs.realpathSync(projectRoot),
					scriptFile: fs.realpathSync(fileURLToPath(import.meta.url)),
				} : null,
			});
		} finally {
			if (stateFile) {
				let state = null;
				try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
				if (state?.pid === process.pid) {
					try { fs.unlinkSync(stateFile); } catch {}
				}
			}
		}
	} else {
		const result = runOnce({ enforce, projectRoot });
		const watcher = process.argv.includes("--ensure-watch") ? ensureWatchdog({ projectRoot }) : null;
		process.stdout.write(`${JSON.stringify({ ...result, ...(watcher ? { watcher } : {}) })}\n`);
	}
}
