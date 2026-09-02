#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const contractCore = require("../hooks/core/session-contract.js");
const recoveryTransaction = require("./session-contract-recovery-transaction.cjs");

const GRANT_TTL_MS = 5 * 60 * 1000;
const LEASE_FRESH_MS = 2 * 60 * 1000;
const PROCESS_PROBE_TIMEOUT_MS = 10 * 1000;
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

const switchSubject = (fromContractId, toContractId) => recoveryTransaction.switchSubject(fromContractId, toContractId, safeId);

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
		const result = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			encoding: "utf8",
			timeout: PROCESS_PROBE_TIMEOUT_MS,
			windowsHide: true,
		});
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

let cachedRecoveryProcessIdentity;
function recoveryProcessIdentity() {
	if (cachedRecoveryProcessIdentity) return cachedRecoveryProcessIdentity;
	const identity = processSnapshot(process.pid);
	if (identity === undefined || !identity?.start_token) throw new Error("liveness_probe_unavailable");
	cachedRecoveryProcessIdentity = identity;
	return identity;
}

function isHostProcess(commandLine) {
	const source = String(commandLine || "");
	if (/session-contract-recovery|run-hook\.cjs|\.claude[\\/]hooks/i.test(source)) return false;
	return /(?:^|[\\/\s"'])(?:codex|claude|opencode)(?:\.exe)?(?:\s|["']|$)/i.test(source) ||
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
	const previous = readJson(leasePath(root, sessionId));
	// Host discovery is deliberately limited to SessionStart. On Windows each
	// process query starts PowerShell/CIM, so repeating the ancestry walk for
	// every lifecycle event can exceed Codex's hook deadline. Later events keep
	// the immutable PID/start-token identity captured at session start.
	const hostProcess = eventName === "SessionStart"
		? hostProcessIdentity()
		: previous?.host_process || null;
	atomicJson(leasePath(root, sessionId), {
		schema_version: "1.0",
		session_id: sessionId,
		state: "active",
		pid: process.ppid || null,
		host_process: hostProcess,
		host: process.env.COMPUTERNAME || process.env.HOSTNAME || null,
		updated_at: now,
		event: eventName,
	});
}


/**
 * Approval as a record, not as a prompt string.
 *
 * recordGrant() below only fires when a user types the slash command, which
 * exists in one runtime. Every other caller — a Codex session, an unattended
 * gateway, a reviewer, a supervising agent — had no way to approve anything, so
 * the documented recovery procedure was unusable exactly where recovery was
 * needed. An approval is a file describing who approved what and why; where it
 * came from does not change its effect.
 *
 * Authorities and scopes: .agents/context/approval-authorities.yaml
 */
function approvalsDir(root) {
	return path.join(recoveryDir(root), "approvals");
}

function approvalRecordPath(root, scope, subjectId) {
	return path.join(approvalsDir(root), `${safeId(scope, "scope")}--${safeId(subjectId, "subject_id")}.json`);
}

function knownAuthority(root, kind, id) {
	const text = (() => {
		try { return fs.readFileSync(path.join(root, ".agents", "context", "approval-authorities.yaml"), "utf8"); }
		catch { return ""; }
	})();
	if (!text) return false;
	// The list is small and flat; matching the declared kind/id pair is enough
	// without pulling in a YAML parser for a hook that must never fail to load.
	const blocks = text.split(/\n\s*-\s+kind:\s*/).slice(1);
	return blocks.some((block) => {
		const declaredKind = block.split("\n", 1)[0].trim();
		const idMatch = block.match(/\n\s*id:\s*(\S+)/);
		return declaredKind === kind && idMatch && idMatch[1] === id;
	});
}

function recordApproval(root, { kind, id, scope, subject, reason, ttlMs = GRANT_TTL_MS }) {
	if (!knownAuthority(root, kind, id)) throw new Error("unknown_approval_authority");
	if (typeof reason !== "string" || reason.trim().length < 8) throw new Error("approval_reason_required");
	const now = Date.now();
	const record = {
		schema_version: "1.0",
		authority_kind: kind,
		authority_id: id,
		scope,
		subject,
		reason: reason.trim(),
		issued_at: new Date(now).toISOString(),
		expires_at: new Date(now + ttlMs).toISOString(),
		nonce: crypto.randomBytes(16).toString("hex"),
	};
	fs.mkdirSync(approvalsDir(root), { recursive: true });
	atomicJson(approvalRecordPath(root, scope, subject), record);
	appendAudit(root, { event: "approval_recorded", authority_kind: kind, authority_id: id, scope, subject });
	return record;
}

/** An unexpired approval for this scope and subject, or null. */
function readApproval(root, scope, subject) {
	const record = readJson(approvalRecordPath(root, scope, subject));
	if (!record || record.scope !== scope || record.subject !== subject) return null;
	if (!(Date.parse(record.expires_at || "") >= Date.now())) return null;
	if (!knownAuthority(root, record.authority_kind, record.authority_id)) return null;
	return record;
}

function consumeApproval(root, scope, subject) {
	try { fs.unlinkSync(approvalRecordPath(root, scope, subject)); } catch {}
	appendAudit(root, { event: "approval_consumed", scope, subject });
}

function recordGrant(root, data) {
	const prompt = promptText(data);
	const reclaimMatch = prompt.match(/^\/harness\s+reclaim\s+([A-Za-z0-9][A-Za-z0-9._-]{0,199})\s*$/i);
	const switchMatch = prompt.match(/^\/harness\s+switch\s+([A-Za-z0-9][A-Za-z0-9._-]{0,199})\s+([A-Za-z0-9][A-Za-z0-9._-]{0,199})\s*$/i);
	if ((!reclaimMatch && !switchMatch) || !data.session_id) return false;
	if (switchMatch) {
		const fromContractId = switchMatch[1];
		const toContractId = switchMatch[2];
		if (fromContractId === toContractId) throw new Error("switch_contracts_must_differ");
		const fromContract = findContract(root, fromContractId).contract;
		const toContract = findContract(root, toContractId).contract;
		if (fromContract.status !== "active" || toContract.status !== "active") throw new Error("contract_not_active");
		const now = Date.now();
		const subject = switchSubject(fromContractId, toContractId);
		atomicJson(grantPath(root, data.session_id, subject), {
			schema_version: "1.0",
			operation: "switch",
			session_id: data.session_id,
			from_contract_id: fromContractId,
			from_contract_digest: fromContract.contract_digest,
			to_contract_id: toContractId,
			to_contract_digest: toContract.contract_digest,
			issued_at: new Date(now).toISOString(),
			expires_at: new Date(now + GRANT_TTL_MS).toISOString(),
			nonce: crypto.randomBytes(16).toString("hex"),
		});
		appendAudit(root, { event: "switch_granted", session_id: data.session_id, from_contract_id: fromContractId, from_contract_digest: fromContract.contract_digest, to_contract_id: toContractId, to_contract_digest: toContract.contract_digest });
		return true;
	}
	const contractId = reclaimMatch[1];
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
		const result = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			encoding: "utf8",
			timeout: PROCESS_PROBE_TIMEOUT_MS,
			windowsHide: true,
		});
		if (result.error || result.status !== 0) return null;
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

// Liveness by the lease's recorded host_process (captured at SessionStart): a
// single targeted PID query, not a full Win32_Process enumeration. The gate used
// to settle a foreign contract's liveness by scanning every process command line
// for the session id (sessionProcessLive). On a busy Windows box that scan
// exceeds the probe deadline, returns null, throws, and the gate fails closed —
// so a long-dead orphan stays "held" and locks its paths to every live session
// (the exact "reclaim every day" trap). The recorded PID+start_token lets us ask
// about one process instead. Returns true (recorded host alive), false (recorded
// host provably gone or reused), or null (lease has no recorded host — caller
// falls back to the command-line scan). Throws only when the targeted probe
// itself is unavailable, preserving fail-closed for genuine uncertainty.
function sessionRecordedHostLive(root, sessionId, snapshot = processSnapshot) {
	const lease = readJson(leasePath(root, sessionId));
	if (!lease || lease.state !== "active") return null;
	if (!lease.host_process || !lease.host_process.pid || !lease.host_process.start_token) return null;
	return recordedHostProcessLive(lease, snapshot);
}

function acquireLock(root, contractId) {
	const safeContractId = safeId(contractId, "contract_id");
	const locksDir = path.join(recoveryDir(root), "locks");
	const lockPath = path.join(locksDir, `${safeContractId}.lock`);
	const nonce = crypto.randomBytes(16).toString("hex");
	const preparedPath = path.join(locksDir, `${safeContractId}.lock.${process.pid}.${nonce}.tmp`);
	fs.mkdirSync(locksDir, { recursive: true });
	fs.mkdirSync(preparedPath);
	let identity;
	try { identity = recoveryProcessIdentity(); } catch (error) {
		try { fs.rmSync(preparedPath, { recursive: true, force: true }); } catch {}
		throw error;
	}
	const owner = { schema_version: "1.0", contract_id: safeContractId, pid: process.pid, start_token: String(identity.start_token), nonce, acquired_at: new Date().toISOString() };
	atomicJson(path.join(preparedPath, "owner.json"), owner);
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				fs.renameSync(preparedPath, lockPath);
				return () => {
					const currentOwner = readJson(path.join(lockPath, "owner.json"));
					if (currentOwner?.nonce !== nonce) return;
					try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* retain fail-closed */ }
				};
			} catch (error) {
				if (!fs.existsSync(lockPath)) throw error;
				const prior = readJson(path.join(lockPath, "owner.json"));
				if (!prior || !Number.isInteger(Number(prior.pid)) || !prior.start_token) throw new Error("recovery_lock_owner_invalid");
				const current = processSnapshot(Number(prior.pid));
				if (current === undefined) throw new Error("liveness_probe_unavailable");
				if (current && String(current.start_token) === String(prior.start_token)) throw new Error("reclaim_already_running");
				fs.rmSync(lockPath, { recursive: true, force: true });
			}
		}
		throw new Error("recovery_lock_race");
	} finally {
		try { fs.rmSync(preparedPath, { recursive: true, force: true }); } catch {}
	}
}

/**
 * Every boundary the same approval could reasonably have landed in.
 *
 * The human types `/harness reclaim <id>` once, in one session. Which project
 * root that keystroke is filed under is an implementation detail: the prompt
 * hook files it under the root the host reports as the working directory, while
 * a reclaim run inside a nested worktree resolves its own boundary. The two are
 * different directories, so the approval and the command that needs it never
 * met — and writing the missing copy was itself refused by the outer contract.
 * A session could then be approved and blocked at the same time, forever.
 *
 * The approval is about a session and a contract, not about a directory. So
 * look for it at this root and at every ADK root above it. Nothing is loosened:
 * the grant still has to name this exact session, this exact contract, and the
 * digest being replaced, and it still expires.
 */
function grantSearchRoots(root) {
	const roots = [path.resolve(root)];
	let current = path.dirname(path.resolve(root));
	while (true) {
		if (fs.existsSync(path.join(current, ".agents", "context", "agents-rules.json"))) {
			roots.push(current);
			break;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return roots;
}

function validGrant(root, sessionId, contractId, digest, now = Date.now(), allowExpired = false) {
	let filePath = null;
	let grant = null;
	for (const candidate of grantSearchRoots(root)) {
		const candidatePath = grantPath(candidate, sessionId, contractId);
		const candidateGrant = readJson(candidatePath);
		if (candidateGrant) { filePath = candidatePath; grant = candidateGrant; break; }
	}
	if (!grant || grant.session_id !== sessionId || grant.contract_id !== contractId || grant.contract_digest !== digest) throw new Error("explicit_reclaim_approval_required");
	if (!allowExpired && !(Date.parse(grant.expires_at || "") >= now)) throw new Error("reclaim_approval_expired");
	return { filePath, grant };
}

function validSwitchGrant(root, sessionId, fromContractId, fromDigest, toContractId, toDigest, now = Date.now(), allowExpired = false) {
	const subject = switchSubject(fromContractId, toContractId);
	let filePath = null;
	let grant = null;
	for (const candidate of grantSearchRoots(root)) {
		const candidatePath = grantPath(candidate, sessionId, subject);
		const candidateGrant = readJson(candidatePath);
		if (candidateGrant) { filePath = candidatePath; grant = candidateGrant; break; }
	}
	if (!grant || grant.operation !== "switch" || grant.session_id !== sessionId ||
		grant.from_contract_id !== fromContractId || grant.from_contract_digest !== fromDigest ||
		grant.to_contract_id !== toContractId || grant.to_contract_digest !== toDigest) {
		throw new Error("explicit_switch_approval_required");
	}
	if (!allowExpired && !(Date.parse(grant.expires_at || "") >= now)) throw new Error("switch_approval_expired");
	return { filePath, grant };
}

function buildTransaction(root, contractId, newSessionId, dependencies = {}) {
	const found = findContract(root, contractId);
	const contract = found.contract;
	if (contract.status !== "active") throw new Error("contract_not_active");
	if (contract.contract_digest !== contractCore.contractDigest(contract)) throw new Error("contract_digest_mismatch");
	const oldSessionIds = [...new Set(contract.session_bindings.map((item) => item?.session_id).filter(Boolean))];
	if (oldSessionIds.length === 0 || oldSessionIds.includes(newSessionId)) throw new Error("contract_not_orphaned_for_current_session");
	const resolution = contractCore.resolveSessionContract({ cwd: root, sessionId: newSessionId });
	if (resolution.status === contractCore.STATES.BOUND) {
		// A session that already holds a contract normally must not take another.
		// But when the point is to rescue a stuck contract on someone else's
		// behalf, that rule leaves nobody able to help: the sessions healthy
		// enough to act are exactly the ones already bound. An approval for
		// stuck_session_recovery — from a person, a reviewer, or a supervising
		// agent — makes third-party rescue possible without opening it by default.
		const rescue = readApproval(root, "stuck_session_recovery", contractId);
		if (!rescue) throw new Error("current_session_already_bound");
		appendAudit(root, {
			event: "third_party_recovery_authorized", contract_id: contractId,
			authority_kind: rescue.authority_kind, authority_id: rescue.authority_id,
			rescuing_session: newSessionId, holding_contract: resolution.contract?.id ?? null,
		});
	}
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
		if (leaseFreshAndActive(root, oldSessionId) || recordedHostProcessLive(lease) || sessionProcessLive(oldSessionId, dependencies.processLines)) throw new Error(`owner_session_live:${oldSessionId}`);
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
	const finalPointer = recoveryTransaction.registryPointer(nextContract, nextDigest);
	nextRegistry.bindings[newSessionId] = finalPointer;
	delete nextContract.__filePath;
	const affectedSessionIds = [...new Set([...oldSessionIds, newSessionId])];
	const registryPreconditions = Object.fromEntries(affectedSessionIds.map((sessionId) => [sessionId, registry.bindings[sessionId] ?? null]));
	const registryPostconditions = Object.fromEntries(affectedSessionIds.map((sessionId) => [sessionId, sessionId === newSessionId ? finalPointer : null]));
	return recoveryTransaction.sealTransaction({ schema_version: "1.0", contract_id: contractId, original_digest: originalDigest, next_digest: nextDigest, old_session_ids: oldSessionIds, new_session_id: newSessionId, contract_path: found.filePath, progress_path: progressPath, registry_path: registryPath, registry_preconditions: registryPreconditions, registry_postconditions: registryPostconditions, next_contract: nextContract, next_progress: nextProgress, next_registry: nextRegistry });
}

function transactionPath(root, contractId, sessionId) {
	return path.join(recoveryDir(root), "transactions", `${safeId(contractId, "contract_id")}--${safeId(sessionId, "session_id")}.json`);
}

function switchTransactionPath(root, fromContractId, toContractId, sessionId) {
	return path.join(recoveryDir(root), "transactions", `${switchSubject(fromContractId, toContractId)}--${safeId(sessionId, "session_id")}.json`);
}

function assertContractState(root, found, registry) {
	const { contract } = found;
	if (contract.status !== "active") throw new Error("contract_not_active");
	if (contract.contract_digest !== contractCore.contractDigest(contract)) throw new Error("contract_digest_mismatch");
	const progressPath = path.resolve(root, contract.progress_file);
	const progress = readJson(progressPath);
	if (!progress || progress.contract_id !== contract.id || progress.contract_digest !== contract.contract_digest) throw new Error("contract_state_inconsistent");
	const sessionIds = [...new Set(contract.session_bindings.map((item) => item?.session_id).filter(Boolean))];
	for (const sessionId of sessionIds) {
		const pointer = registry.bindings[sessionId];
		if (!pointer || pointer.contract_id !== contract.id || pointer.contract_digest !== contract.contract_digest) throw new Error("registry_binding_inconsistent");
	}
	return { progress, progressPath, sessionIds };
}

function assertOwnersStopped(root, sessionIds, processLines) {
	for (const sessionId of sessionIds) {
		const lease = readJson(leasePath(root, sessionId));
		if (leaseFreshAndActive(root, sessionId) || recordedHostProcessLive(lease) || sessionProcessLive(sessionId, processLines)) throw new Error(`owner_session_live:${sessionId}`);
	}
}

function buildSwitchTransaction(root, fromContractId, toContractId, sessionId, dependencies = {}) {
	if (fromContractId === toContractId) throw new Error("switch_contracts_must_differ");
	const fromFound = findContract(root, fromContractId);
	const toFound = findContract(root, toContractId);
	const registryPath = path.join(root, ".agents", "session-contracts", ".session-map.json");
	const registry = readJson(registryPath);
	if (!registry?.bindings) throw new Error("contract_state_inconsistent");
	const fromState = assertContractState(root, fromFound, registry);
	const toState = assertContractState(root, toFound, registry);
	if (fromState.sessionIds.length !== 1 || fromState.sessionIds[0] !== sessionId) throw new Error("source_contract_not_exclusively_owned");
	if (registry.bindings[sessionId]?.contract_id !== fromContractId) throw new Error("current_session_registry_source_mismatch");
	if (toState.sessionIds.length === 0 || toState.sessionIds.includes(sessionId)) throw new Error("target_contract_not_orphaned");
	assertOwnersStopped(root, toState.sessionIds, dependencies.processLines);

	const now = new Date().toISOString();
	const fromOriginalDigest = fromFound.contract.contract_digest;
	const toOriginalDigest = toFound.contract.contract_digest;
	const closed = recoveryTransaction.withDigest({ ...fromFound.contract, status: "closed" }, [sessionId]);
	const rebound = recoveryTransaction.withDigest(toFound.contract, [sessionId]);
	const fromRecovery = { at: now, from_session_id: sessionId, to_contract_id: toContractId, previous_contract_digest: fromOriginalDigest, state: "switched_away" };
	const toRecovery = { at: now, from_contract_id: fromContractId, from_session_ids: toState.sessionIds, to_session_id: sessionId, previous_contract_digest: toOriginalDigest, state: "revoked_abandoned" };
	const nextFromProgress = { ...fromState.progress, contract_digest: closed.digest, status: "closed", current_phase: "close", recovery_history: [...(fromState.progress.recovery_history || []), fromRecovery] };
	const nextToProgress = { ...toState.progress, session_id: sessionId, contract_digest: rebound.digest, recovery_history: [...(toState.progress.recovery_history || []), toRecovery] };
	const nextRegistry = JSON.parse(JSON.stringify(registry));
	delete nextRegistry.bindings[sessionId];
	for (const oldSessionId of toState.sessionIds) delete nextRegistry.bindings[oldSessionId];
	toFound.contract.__filePath = toFound.filePath;
	const finalPointer = recoveryTransaction.registryPointer(toFound.contract, rebound.digest);
	nextRegistry.bindings[sessionId] = finalPointer;
	delete toFound.contract.__filePath;
	const affectedSessionIds = [...new Set([sessionId, ...toState.sessionIds])];
	const registryPreconditions = Object.fromEntries(affectedSessionIds.map((affectedSessionId) => [affectedSessionId, registry.bindings[affectedSessionId] ?? null]));
	const registryPostconditions = Object.fromEntries(affectedSessionIds.map((affectedSessionId) => [affectedSessionId, affectedSessionId === sessionId ? finalPointer : null]));
	return recoveryTransaction.sealTransaction({
		schema_version: "1.0", operation: "switch", session_id: sessionId,
		from_contract_id: fromContractId, from_original_digest: fromOriginalDigest, from_next_digest: closed.digest,
		to_contract_id: toContractId, to_original_digest: toOriginalDigest, to_next_digest: rebound.digest,
		old_target_session_ids: toState.sessionIds,
		from_contract_path: fromFound.filePath, from_progress_path: fromState.progressPath,
		to_contract_path: toFound.filePath, to_progress_path: toState.progressPath,
		registry_path: registryPath, registry_preconditions: registryPreconditions, registry_postconditions: registryPostconditions,
		next_from_contract: closed.contract, next_from_progress: nextFromProgress,
		next_to_contract: rebound.contract, next_to_progress: nextToProgress, next_registry: nextRegistry,
	});
}

function switchContract(root, fromContractId, toContractId, sessionId, dependencies = {}) {
	const release = recoveryTransaction.acquireLocks(acquireLock, root, [fromContractId, toContractId]);
	try {
		const txPath = switchTransactionPath(root, fromContractId, toContractId, sessionId);
		let tx = readJson(txPath);
		let usedGrantPath;
		if (!tx) {
			const from = findContract(root, fromContractId).contract;
			const to = findContract(root, toContractId).contract;
			usedGrantPath = validSwitchGrant(root, sessionId, fromContractId, from.contract_digest, toContractId, to.contract_digest).filePath;
			tx = buildSwitchTransaction(root, fromContractId, toContractId, sessionId, dependencies);
			atomicJson(txPath, tx);
			appendAudit(root, { event: "switch_prepared", session_id: sessionId, from_contract_id: fromContractId, from_contract_digest: tx.from_original_digest, to_contract_id: toContractId, to_contract_digest: tx.to_original_digest, old_target_session_ids: tx.old_target_session_ids });
		} else {
			recoveryTransaction.assertTransactionIntegrity(tx);
			// The journal was sealed only after a live grant passed validation. A
			// crash may leave a partially applied switch after that grant expires;
			// requiring a fresh grant would be impossible once the source is closed.
			// Exact grant identity and journal integrity remain mandatory on resume.
			usedGrantPath = validSwitchGrant(root, sessionId, fromContractId, tx.from_original_digest, toContractId, tx.to_original_digest, Date.now(), true).filePath;
		}
		recoveryTransaction.assertTransactionIntegrity(tx);
		let transition = recoveryTransaction.registryTransition(tx);
		const filesApplied = recoveryTransaction.filesMatch([
			[tx.from_contract_path, tx.next_from_contract], [tx.from_progress_path, tx.next_from_progress],
			[tx.to_contract_path, tx.next_to_contract], [tx.to_progress_path, tx.next_to_progress],
		]);
		if (transition.alreadyApplied && !filesApplied) throw new Error("recovery_partial_poststate_inconsistent");
		if (!transition.alreadyApplied) {
			assertOwnersStopped(root, tx.old_target_session_ids, dependencies.processLines);
			atomicJson(tx.from_contract_path, tx.next_from_contract);
			atomicJson(tx.from_progress_path, tx.next_from_progress);
			atomicJson(tx.to_contract_path, tx.next_to_contract);
			atomicJson(tx.to_progress_path, tx.next_to_progress);
			transition = recoveryTransaction.registryTransition(tx);
			atomicJson(tx.registry_path, transition.next);
		}
		const resolved = contractCore.resolveSessionContract({ cwd: root, sessionId });
		if (resolved.status !== contractCore.STATES.BOUND || resolved.contract.id !== toContractId || resolved.contract.contract_digest !== tx.to_next_digest) throw new Error("switch_postcondition_failed");
		appendAudit(root, { event: "switch_completed", session_id: sessionId, from_contract_id: fromContractId, from_contract_digest: tx.from_next_digest, to_contract_id: toContractId, to_contract_digest: tx.to_next_digest, old_target_session_ids: tx.old_target_session_ids });
		try { fs.unlinkSync(usedGrantPath || grantPath(root, sessionId, switchSubject(fromContractId, toContractId))); } catch { /* already gone */ }
		fs.unlinkSync(txPath);
		return tx;
	} finally {
		release();
	}
}

function reclaim(root, contractId, sessionId, dependencies = {}) {
	const release = acquireLock(root, contractId);
	try {
		const txPath = transactionPath(root, contractId, sessionId);
		let tx = readJson(txPath);
		let usedGrantPath = null;
		if (!tx) {
			const current = findContract(root, contractId).contract;
			usedGrantPath = validGrant(root, sessionId, contractId, current.contract_digest).filePath;
			tx = buildTransaction(root, contractId, sessionId, dependencies);
			atomicJson(txPath, tx);
			appendAudit(root, { event: "reclaim_prepared", contract_id: contractId, session_id: sessionId, from_session_ids: tx.old_session_ids, previous_contract_digest: tx.original_digest, contract_digest: tx.next_digest });
		} else {
			recoveryTransaction.assertTransactionIntegrity(tx);
			usedGrantPath = validGrant(root, sessionId, contractId, tx.original_digest, Date.now(), true).filePath;
		}
		recoveryTransaction.assertTransactionIntegrity(tx);
		let transition = recoveryTransaction.registryTransition(tx);
		const filesApplied = recoveryTransaction.filesMatch([[tx.contract_path, tx.next_contract], [tx.progress_path, tx.next_progress]]);
		if (transition.alreadyApplied && !filesApplied) throw new Error("recovery_partial_poststate_inconsistent");
		if (!transition.alreadyApplied) {
			assertOwnersStopped(root, tx.old_session_ids, dependencies.processLines);
			atomicJson(tx.contract_path, tx.next_contract);
			atomicJson(tx.progress_path, tx.next_progress);
			transition = recoveryTransaction.registryTransition(tx);
			atomicJson(tx.registry_path, transition.next);
		}
		const resolved = contractCore.resolveSessionContract({ cwd: root, sessionId });
		if (resolved.status !== contractCore.STATES.BOUND || resolved.contract.contract_digest !== tx.next_digest) throw new Error("reclaim_postcondition_failed");
		appendAudit(root, { event: "reclaim_completed", contract_id: contractId, session_id: sessionId, from_session_ids: tx.old_session_ids, previous_contract_digest: tx.original_digest, contract_digest: tx.next_digest });
		try { fs.unlinkSync(usedGrantPath || grantPath(root, sessionId, contractId)); } catch { /* already gone */ }
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
		else if (argv[i] === "--authority") result.authority = argv[++i];
		else if (argv[i] === "--scope") result.scope = argv[++i];
		else if (argv[i] === "--reason") result.reason = argv[++i];
		else if (argv[i] === "--from") result.from = argv[++i];
		else if (argv[i] === "--to") result.to = argv[++i];
	}
	return result;
}

function main(argv = process.argv.slice(2)) {
	if (argv[0] === "event") {
		handleEvent(argv[1] || "Unknown");
		return 0;
	}
	if (argv[0] === "approve") {
		// Works from any runtime: a terminal, a Codex session, a reviewer, a
		// supervising agent. The approval is the record, not the way it was typed.
		const args = parseArgs(argv.slice(1));
		const root = contractCore.findProjectRoot(process.cwd());
		if (!root) throw new Error("project_root_not_found");
		const [kind, id] = String(args.authority || "").split(":");
		const record = recordApproval(root, {
			kind, id,
			scope: safeId(args.scope || "contract_repair", "scope"),
			subject: safeId(args.contract, "contract_id"),
			reason: args.reason,
		});
		process.stderr.write(`[HARNESS] approved ${record.scope} for ${record.subject} by ${record.authority_kind}:${record.authority_id} until ${record.expires_at}\n`);
		return 0;
	}
	if (argv[0] === "switch") {
		const args = parseArgs(argv.slice(1));
		const root = contractCore.findProjectRoot(process.cwd());
		if (!root) throw new Error("project_root_not_found");
		const tx = switchContract(root, safeId(args.from, "from_contract_id"), safeId(args.to, "to_contract_id"), safeId(args.session, "session_id"));
		process.stderr.write(`[HARNESS] switched ${tx.session_id}: ${tx.from_contract_id} -> ${tx.to_contract_id}\n`);
		return 0;
	}
	if (argv[0] !== "reclaim") throw new Error("usage: reclaim --contract <id> --session <id> | switch --from <id> --to <id> --session <id> | approve --contract <id> --authority <kind:id> --scope <scope> --reason <text>");
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

module.exports = { GRANT_TTL_MS, grantSearchRoots, validGrant, validSwitchGrant, recordApproval, readApproval, consumeApproval, knownAuthority, approvalRecordPath, LEASE_FRESH_MS, PROCESS_PROBE_TIMEOUT_MS, atomicJson, buildTransaction, buildSwitchTransaction, handleEvent, hostProcessIdentity, isHostProcess, leaseFreshAndActive, sessionRecordedHostLive, main, processSnapshot, promptText, reclaim, recordedHostProcessLive, recordGrant, recordLease, sessionProcessLive, switchContract, switchSubject };
