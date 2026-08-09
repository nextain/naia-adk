#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const contractCore = require("../hooks/core/session-contract.js");

const GRANT_TTL_MS = 5 * 60 * 1000;
const LEASE_FRESH_MS = 2 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function readStdin() {
	try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

function readJson(filePath) {
	try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function recoveryDir(root) {
	return path.join(root, ".agents", "session-contracts", ".recovery");
}

function safeId(value, label) {
	const result = String(value || "").trim();
	if (!ID_RE.test(result)) throw new Error(`invalid_${label}`);
	return result;
}

function atomicJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, filePath);
}

function appendAudit(root, event) {
	const dir = recoveryDir(root);
	fs.mkdirSync(dir, { recursive: true });
	fs.appendFileSync(path.join(dir, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

function leasePath(root, sessionId) {
	return path.join(recoveryDir(root), "leases", `${safeId(sessionId, "session_id")}.json`);
}

function grantPath(root, sessionId, contractId) {
	return path.join(recoveryDir(root), "grants", `${safeId(sessionId, "session_id")}--${safeId(contractId, "contract_id")}.json`);
}

function findContract(root, contractId) {
	const filePath = path.join(root, ".agents", "session-contracts", `${safeId(contractId, "contract_id")}.json`);
	const contract = readJson(filePath);
	if (!contract || contract.id !== contractId) throw new Error("contract_not_found");
	return { filePath, contract };
}

function eventInput(raw) {
	try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

function promptText(data) {
	return String(data.prompt ?? data.user_prompt ?? data.input ?? data.message ?? "").trim();
}

function processSnapshot(pid) {
	if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
	if (process.platform === "win32") {
		const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue; if($p){@{pid=[int]$p.ProcessId;parent_pid=[int]$p.ParentProcessId;start_token=[string]$p.CreationDate;command_line=[string]$p.CommandLine}|ConvertTo-Json -Compress}`;
		const result = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
		if (result.error || result.status !== 0) return undefined;
		if (!result.stdout.trim()) return null;
		try { return JSON.parse(result.stdout); } catch { return undefined; }
	}
	try {
		const stat = fs.readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
		return {
			pid: Number(pid),
			parent_pid: Number(fields[1]),
			start_token: fields[19],
			command_line: fs.readFileSync(`/proc/${Number(pid)}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
		};
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ESRCH") return null;
		return undefined;
	}
}

function isHostProcess(commandLine) {
	const source = String(commandLine || "");
	if (/session-contract-recovery|run-hook\.cjs|\.claude[\\/]hooks/i.test(source)) return false;
	return /(?:^|[\\/\s])(?:codex|claude|opencode)(?:\.exe)?(?:\s|$)/i.test(source) ||
		/@anthropic-ai[\\/]claude-code[\\/].*cli\.js/i.test(source);
}

function hostProcessIdentity(startPid = process.ppid, snapshot = processSnapshot) {
	let pid = Number(startPid);
	for (let depth = 0; depth < 16 && pid > 1; depth += 1) {
		const current = snapshot(pid);
		if (current === undefined) return null;
		if (!current) return null;
		if (isHostProcess(current.command_line)) {
			return { pid: current.pid, start_token: current.start_token, command_line_hash: crypto.createHash("sha256").update(current.command_line).digest("hex") };
		}
		pid = current.parent_pid;
	}
	return null;
}

function recordLease(root, data, eventName) {
	const sessionId = data.session_id;
	if (!sessionId || !ID_RE.test(String(sessionId))) return;
	const now = new Date().toISOString();
	atomicJson(leasePath(root, sessionId), {
		schema_version: "1.0",
		session_id: sessionId,
		state: "active",
		pid: process.ppid || null,
		host_process: hostProcessIdentity(),
		host: process.env.COMPUTERNAME || process.env.HOSTNAME || null,
		updated_at: now,
		event: eventName,
	});
}

function recordGrant(root, data) {
	const match = promptText(data).match(/^(?:\/harness\s+reclaim|하네스\s+회수\s+승인:)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,199})\s*$/i);
	if (!match || !data.session_id) return false;
	const contractId = match[1];
	const { contract } = findContract(root, contractId);
	if (contract.status !== "active") throw new Error("contract_not_active");
	const now = Date.now();
	atomicJson(grantPath(root, data.session_id, contractId), {
		schema_version: "1.0",
		session_id: data.session_id,
		contract_id: contractId,
		contract_digest: contract.contract_digest,
		issued_at: new Date(now).toISOString(),
		expires_at: new Date(now + GRANT_TTL_MS).toISOString(),
		nonce: crypto.randomBytes(16).toString("hex"),
	});
	appendAudit(root, { event: "reclaim_granted", session_id: data.session_id, contract_id: contractId, contract_digest: contract.contract_digest });
	return true;
}

function handleEvent(eventName, raw = readStdin(), cwd = process.cwd()) {
	const data = eventInput(raw);
	const root = contractCore.findProjectRoot(data.cwd || cwd);
	if (!root) return;
	try {
		recordLease(root, data, eventName);
		if (eventName === "UserPromptSubmit") recordGrant(root, data);
	} catch (error) {
		process.stderr.write(`[HARNESS recovery] ${error.message}\n`);
	}
}

function processCommandLines() {
	if (process.platform === "win32") {
		const script = "Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + '\\t' + [string]$_.CommandLine }";
		const result = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
		if (result.status !== 0) return null;
		return result.stdout.split(/\r?\n/).filter(Boolean);
	}
	try {
		return fs.readdirSync("/proc", { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
			.map((entry) => {
				try { return `${entry.name}\t${fs.readFileSync(`/proc/${entry.name}/cmdline`, "utf8").replaceAll("\0", " ")}`; } catch { return ""; }
			})
			.filter(Boolean);
	} catch { return null; }
}

function sessionProcessLive(sessionId, lines = processCommandLines()) {
	if (!lines) throw new Error("liveness_probe_unavailable");
	return lines.some((line) => line.includes(sessionId) && !line.startsWith(`${process.pid}\t`));
}

function recordedHostProcessLive(lease, snapshot = processSnapshot) {
	if (!lease?.host_process?.pid || !lease.host_process.start_token) return false;
	const current = snapshot(lease.host_process.pid);
	if (current === undefined) throw new Error("liveness_probe_unavailable");
	return Boolean(current && String(current.start_token) === String(lease.host_process.start_token));
}

function leaseFreshAndActive(root, sessionId, now = Date.now()) {
	const lease = readJson(leasePath(root, sessionId));
	if (!lease || lease.state !== "active") return false;
	const updated = Date.parse(lease.updated_at || "");
	return Number.isFinite(updated) && now - updated <= LEASE_FRESH_MS;
}

function acquireLock(root, contractId) {
	const lockPath = path.join(recoveryDir(root), "locks", `${safeId(contractId, "contract_id")}.lock`);
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	try { fs.mkdirSync(lockPath); } catch (error) {
		if (error.code === "EEXIST") throw new Error("reclaim_already_running");
		throw error;
	}
	return () => { try { fs.rmdirSync(lockPath); } catch { /* retain fail-closed */ } };
}

function validGrant(root, sessionId, contractId, digest, now = Date.now()) {
	const filePath = grantPath(root, sessionId, contractId);
	const grant = readJson(filePath);
	if (!grant || grant.session_id !== sessionId || grant.contract_id !== contractId || grant.contract_digest !== digest) throw new Error("explicit_reclaim_approval_required");
	if (!(Date.parse(grant.expires_at || "") >= now)) throw new Error("reclaim_approval_expired");
	return { filePath, grant };
}

function registryPointer(contract, digest) {
	return {
		contract_id: contract.id,
		contract_path: `.agents/session-contracts/${path.basename(contract.__filePath)}`,
		contract_digest: digest,
	};
}

function buildTransaction(root, contractId, newSessionId) {
	const found = findContract(root, contractId);
	const contract = found.contract;
	if (contract.status !== "active") throw new Error("contract_not_active");
	if (contract.contract_digest !== contractCore.contractDigest(contract)) throw new Error("contract_digest_mismatch");
	const oldSessionIds = [...new Set(contract.session_bindings.map((item) => item?.session_id).filter(Boolean))];
	if (oldSessionIds.length === 0 || oldSessionIds.includes(newSessionId)) throw new Error("contract_not_orphaned_for_current_session");
	const resolution = contractCore.resolveSessionContract({ cwd: root, sessionId: newSessionId });
	if (resolution.status === contractCore.STATES.BOUND) throw new Error("current_session_already_bound");
	const registryPath = path.join(root, ".agents", "session-contracts", ".session-map.json");
	const registry = readJson(registryPath);
	const progressPath = path.resolve(root, contract.progress_file);
	const progress = readJson(progressPath);
	if (!registry?.bindings || !progress || progress.contract_id !== contract.id || progress.contract_digest !== contract.contract_digest) throw new Error("contract_state_inconsistent");
	if (registry.bindings[newSessionId]?.contract_id !== undefined && registry.bindings[newSessionId].contract_id !== contract.id) throw new Error("current_session_registry_occupied");
	for (const oldSessionId of oldSessionIds) {
		const pointer = registry.bindings[oldSessionId];
		if (!pointer || pointer.contract_id !== contract.id || pointer.contract_digest !== contract.contract_digest) throw new Error("registry_binding_inconsistent");
		const lease = readJson(leasePath(root, oldSessionId));
		if (leaseFreshAndActive(root, oldSessionId) || recordedHostProcessLive(lease) || sessionProcessLive(oldSessionId)) throw new Error(`owner_session_live:${oldSessionId}`);
	}
	const originalDigest = contract.contract_digest;
	const nextContract = { ...contract };
	delete nextContract.__filePath;
	nextContract.session_bindings = [{ session_id: newSessionId, contract_digest: "" }];
	const nextDigest = contractCore.contractDigest(nextContract);
	nextContract.contract_digest = nextDigest;
	nextContract.session_bindings[0].contract_digest = nextDigest;
	const now = new Date().toISOString();
	const recovery = { at: now, from_session_ids: oldSessionIds, to_session_id: newSessionId, previous_contract_digest: originalDigest, state: "revoked_abandoned" };
	const nextProgress = { ...progress, session_id: newSessionId, contract_digest: nextDigest, recovery_history: [...(progress.recovery_history || []), recovery] };
	const nextRegistry = JSON.parse(JSON.stringify(registry));
	for (const oldSessionId of oldSessionIds) delete nextRegistry.bindings[oldSessionId];
	nextContract.__filePath = found.filePath;
	nextRegistry.bindings[newSessionId] = registryPointer(nextContract, nextDigest);
	delete nextContract.__filePath;
	return { schema_version: "1.0", contract_id: contractId, original_digest: originalDigest, next_digest: nextDigest, old_session_ids: oldSessionIds, new_session_id: newSessionId, contract_path: found.filePath, progress_path: progressPath, registry_path: registryPath, next_contract: nextContract, next_progress: nextProgress, next_registry: nextRegistry };
}

function transactionPath(root, contractId, sessionId) {
	return path.join(recoveryDir(root), "transactions", `${safeId(contractId, "contract_id")}--${safeId(sessionId, "session_id")}.json`);
}

function reclaim(root, contractId, sessionId) {
	const release = acquireLock(root, contractId);
	try {
		const txPath = transactionPath(root, contractId, sessionId);
		let tx = readJson(txPath);
		if (!tx) {
			const current = findContract(root, contractId).contract;
			validGrant(root, sessionId, contractId, current.contract_digest);
			tx = buildTransaction(root, contractId, sessionId);
			atomicJson(txPath, tx);
			appendAudit(root, { event: "reclaim_prepared", contract_id: contractId, session_id: sessionId, from_session_ids: tx.old_session_ids, previous_contract_digest: tx.original_digest, contract_digest: tx.next_digest });
		} else {
			validGrant(root, sessionId, contractId, tx.original_digest);
		}
		atomicJson(tx.contract_path, tx.next_contract);
		atomicJson(tx.progress_path, tx.next_progress);
		atomicJson(tx.registry_path, tx.next_registry);
		const resolved = contractCore.resolveSessionContract({ cwd: root, sessionId });
		if (resolved.status !== contractCore.STATES.BOUND || resolved.contract.contract_digest !== tx.next_digest) throw new Error("reclaim_postcondition_failed");
		appendAudit(root, { event: "reclaim_completed", contract_id: contractId, session_id: sessionId, from_session_ids: tx.old_session_ids, previous_contract_digest: tx.original_digest, contract_digest: tx.next_digest });
		fs.unlinkSync(grantPath(root, sessionId, contractId));
		fs.unlinkSync(txPath);
		return tx;
	} finally {
		release();
	}
}

function parseArgs(argv) {
	const result = {};
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--contract") result.contract = argv[++i];
		else if (argv[i] === "--session") result.session = argv[++i];
	}
	return result;
}

function main(argv = process.argv.slice(2)) {
	if (argv[0] === "event") {
		handleEvent(argv[1] || "Unknown");
		return 0;
	}
	if (argv[0] !== "reclaim") throw new Error("usage: reclaim --contract <id> --session <id>");
	const args = parseArgs(argv.slice(1));
	const root = contractCore.findProjectRoot(process.cwd());
	if (!root) throw new Error("project_root_not_found");
	const tx = reclaim(root, safeId(args.contract, "contract_id"), safeId(args.session, "session_id"));
	process.stderr.write(`[HARNESS] reclaimed ${tx.contract_id}: ${tx.old_session_ids.join(",")} -> ${tx.new_session_id}\n`);
	return 0;
}

if (require.main === module) {
	try { process.exitCode = main(); } catch (error) {
		process.stderr.write(`[HARNESS recovery] ${error.message}\n`);
		process.exitCode = 1;
	}
}

module.exports = { GRANT_TTL_MS, LEASE_FRESH_MS, atomicJson, buildTransaction, handleEvent, hostProcessIdentity, isHostProcess, leaseFreshAndActive, main, processSnapshot, promptText, reclaim, recordedHostProcessLive, recordGrant, recordLease, sessionProcessLive };
