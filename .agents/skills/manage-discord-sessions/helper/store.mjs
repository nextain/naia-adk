import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	ACTIVITY_DETAILS,
	ALLOWED_TRANSITIONS,
	DEFAULT_SOFT_SILENCE_MS,
	DB_SCHEMA_VERSION,
	EVENT_KINDS,
	LIFECYCLES,
	OUTPUT_SCHEMA_VERSION,
} from "./constants.mjs";
import { observeOwnedProcess, projectActivityHealth, projectCompletionAssessment, projectServiceHealth, readBootId, readProcessStartIdentity } from "./projector.mjs";
import { assertOnlyKeys, buildSafeEventSummary, canonicalTimestamp, safeIdentifier, sanitizeSummary, validateBackendCapabilities, validateSafeMetrics } from "./sanitize.mjs";

const EVENT_INPUT_KEYS = new Set([
	"jobId",
	"dedupeKey",
	"attemptId",
	"kind",
	"occurredAt",
	"source",
	"safePayload",
	"metrics",
	"redactionLevel",
]);

const EVENT_SOURCES = new Map([
	["job_accepted", new Set(["gateway"])],
	["attempt_reserved", new Set(["helper"])],
	["attempt_started", new Set(["helper"])],
	["backend_ready", new Set(["codex", "claude", "fake_backend"])],
	["phase_changed", new Set(["codex", "claude", "fake_backend"])],
	["output_activity", new Set(["codex", "claude", "fake_backend"])],
	["tool_started", new Set(["codex", "claude", "fake_backend"])],
	["tool_finished", new Set(["codex", "claude", "fake_backend"])],
	["approval_required", new Set(["codex", "claude", "fake_backend"])],
	["checkpoint_saved", new Set(["helper", "codex", "claude", "fake_backend"])],
	["verification_recorded", new Set(["host_verifier", "backend_claim", "human_review"])],
	["attempt_exited", new Set(["helper"])],
	["attempt_succeeded", new Set(["helper"])],
	["retry_scheduled", new Set(["helper", "recovery"])],
	["delivery_started", new Set(["helper"])],
	["delivery_confirmed", new Set(["helper", "recovery"])],
	["delivery_unknown", new Set(["helper", "recovery"])],
	["recovered", new Set(["recovery"])],
	["profile_replaced", new Set(["recovery", "helper"])],
	["recovery_review_required", new Set(["recovery"])],
	["watchdog_intervened", new Set(["helper"])],
	["operator_response_sent", new Set(["helper"])],
	["operator_response_missed", new Set(["helper"])],
	["cancel_requested", new Set(["helper"])],
	["cancelled", new Set(["helper"])],
	["completed", new Set(["helper"])],
	["failed", new Set(["helper", "recovery"])],
]);

const EXTERNAL_EVENT_SOURCES = new Set(["codex", "claude", "fake_backend"]);

function json(value) {
	return JSON.stringify(value ?? {});
}

function parseJson(value, fallback) {
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function lstatOrNull(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function preparePrivateDatabasePath(databasePath) {
	const resolvedPath = resolve(databasePath);
	const directory = dirname(resolvedPath);
	const root = parse(directory).root;
	let cursor = root;
	for (const part of directory.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
		cursor = resolve(cursor, part);
		if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`state path contains a symbolic link: ${cursor}`);
	}
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const directoryStat = lstatSync(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("session state directory must be a real directory");
	if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) throw new Error("session state directory owner mismatch");
	chmodSync(directory, 0o700);
	if (!existsSync(resolvedPath)) {
		const fd = openSync(resolvedPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
		closeSync(fd);
	}
	const databaseStat = lstatSync(resolvedPath);
	if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error("session database must be a real file");
	if (typeof process.getuid === "function" && databaseStat.uid !== process.getuid()) throw new Error("session database owner mismatch");
	chmodSync(resolvedPath, 0o600);
	for (const suffix of ["-wal", "-shm"]) {
		const sidecar = `${resolvedPath}${suffix}`;
		const sidecarStat = lstatOrNull(sidecar);
		if (!sidecarStat) continue;
		if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) throw new Error(`SQLite sidecar must be a real file: ${sidecar}`);
		if (typeof process.getuid === "function" && sidecarStat.uid !== process.getuid()) throw new Error(`SQLite sidecar owner mismatch: ${sidecar}`);
		chmodSync(sidecar, 0o600);
	}
	return resolvedPath;
}

function transitionFor(kind, current) {
	switch (kind) {
		case "attempt_reserved":
			return current;
		case "attempt_started":
		case "backend_ready":
		case "phase_changed":
		case "output_activity":
		case "tool_started":
		case "tool_finished":
		case "checkpoint_saved":
			return "running";
		case "recovered":
			return "queued";
		case "profile_replaced":
			return "queued";
		case "recovery_review_required":
			return "recovery_review";
		case "watchdog_intervened":
		case "operator_response_sent":
			return current;
		case "operator_response_missed":
			return ["completed", "failed", "cancelled", "recovery_review"].includes(current) ? current : "recovery_review";
		case "verification_recorded":
			return current;
		case "attempt_succeeded":
			return "result_ready";
		case "approval_required":
			return "waiting_approval";
		case "retry_scheduled":
			return "retry_wait";
		case "delivery_started":
			return "delivering";
		case "delivery_unknown":
			return "recovery_review";
		case "delivery_confirmed":
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "cancel_requested":
			return current;
		case "cancelled":
			return "cancelled";
		default:
			return current;
	}
}

export class SessionStore {
	constructor(databasePath, ownershipReader = {}) {
		this.readBootId = ownershipReader.readBootId ?? readBootId;
		this.readProcessStartIdentity = ownershipReader.readProcessStartIdentity ?? readProcessStartIdentity;
		this.databasePath = preparePrivateDatabasePath(databasePath);
		const previousUmask = process.umask(0o077);
		try {
			this.db = new DatabaseSync(this.databasePath);
			this.#assertSupportedSchema();
			this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
		} catch (error) {
			this.db?.close();
			throw error;
		} finally {
			process.umask(previousUmask);
		}
		this.#hardenSidecars();
		this.#migrate();
	}

	#assertSupportedSchema() {
		const metadataExists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
		if (!metadataExists) return;
		const current = this.db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get();
		if (!current) return;
		const version = Number(current.value);
		if (!Number.isSafeInteger(version) || version < 0) throw new Error("database schema version is invalid");
		if (version > DB_SCHEMA_VERSION) throw new Error("database schema is newer than this helper");
	}

	#hardenSidecars() {
		for (const suffix of ["", "-wal", "-shm"]) {
			const path = `${this.databasePath}${suffix}`;
			const stat = lstatOrNull(path);
			if (!stat) continue;
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe SQLite state file: ${path}`);
			if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`SQLite state owner mismatch: ${path}`);
			chmodSync(path, 0o600);
		}
	}

	#migrate() {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS service_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				generation TEXT NOT NULL,
				status TEXT NOT NULL,
				pid INTEGER,
				started_at TEXT NOT NULL,
				heartbeat_at TEXT NOT NULL,
				boot_id TEXT,
				process_start_identity TEXT
			);
			CREATE TABLE IF NOT EXISTS jobs (
				job_id TEXT PRIMARY KEY,
				attempt_id TEXT,
				lifecycle TEXT NOT NULL,
				backend_id TEXT NOT NULL,
				revision TEXT NOT NULL,
				backend_capabilities_json TEXT NOT NULL,
				activity_detail TEXT NOT NULL,
				safe_summary TEXT NOT NULL,
				accepted_at TEXT NOT NULL,
				started_at TEXT,
				updated_at TEXT NOT NULL,
				last_progress_at TEXT,
				soft_silence_ms INTEGER NOT NULL,
				hard_deadline_at TEXT,
				current_activity TEXT,
				waiting_reason TEXT,
				retry_at TEXT,
				child_alive INTEGER NOT NULL DEFAULT 0,
				child_pid INTEGER,
				child_boot_id TEXT,
				child_start_identity TEXT,
				delivery_state TEXT NOT NULL DEFAULT 'not_started',
				recovery_state TEXT NOT NULL DEFAULT 'none',
				latest_safe_error TEXT
			);
			CREATE TABLE IF NOT EXISTS job_events (
				ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
				event_id TEXT NOT NULL UNIQUE,
				dedupe_key TEXT NOT NULL,
				job_id TEXT NOT NULL REFERENCES jobs(job_id),
				attempt_id TEXT,
				sequence INTEGER NOT NULL,
				kind TEXT NOT NULL,
				occurred_at TEXT NOT NULL,
				source TEXT NOT NULL,
				safe_summary TEXT NOT NULL,
				metrics_json TEXT NOT NULL,
				redaction_level TEXT NOT NULL,
				UNIQUE(job_id, sequence),
				UNIQUE(job_id, dedupe_key)
			);
			CREATE TABLE IF NOT EXISTS required_checks (
				check_id TEXT NOT NULL,
				job_id TEXT NOT NULL REFERENCES jobs(job_id),
				kind TEXT NOT NULL,
				safe_label TEXT NOT NULL,
				required INTEGER NOT NULL,
				revision TEXT NOT NULL,
				allow_reuse INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY(job_id, check_id)
			);
			CREATE TABLE IF NOT EXISTS evidence (
				evidence_id TEXT PRIMARY KEY,
				job_id TEXT NOT NULL REFERENCES jobs(job_id),
				check_id TEXT NOT NULL,
				attempt_id TEXT,
				revision TEXT NOT NULL,
				kind TEXT NOT NULL,
				safe_label TEXT NOT NULL,
				required INTEGER NOT NULL,
				result TEXT NOT NULL,
				producer TEXT NOT NULL,
				verifier TEXT NOT NULL,
				observed_at TEXT NOT NULL,
				metrics_json TEXT NOT NULL,
				FOREIGN KEY(job_id, check_id) REFERENCES required_checks(job_id, check_id)
			);
			CREATE TABLE IF NOT EXISTS gateway_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				session_id TEXT,
				resume_url TEXT,
				sequence INTEGER,
				heartbeat_ack_at TEXT,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS ingress_messages (
				source_message_id TEXT PRIMARY KEY,
				scope_key TEXT NOT NULL,
				status TEXT NOT NULL,
				job_id TEXT,
				reason_code TEXT NOT NULL,
				dispatch_sequence INTEGER,
				received_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS delivery_attempts (
				delivery_key TEXT PRIMARY KEY,
				job_id TEXT NOT NULL REFERENCES jobs(job_id),
				attempt_id TEXT NOT NULL,
				nonce TEXT NOT NULL UNIQUE,
				channel_id TEXT NOT NULL,
				status TEXT NOT NULL,
				message_id TEXT,
				started_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS job_recovery (
				job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
				iv TEXT NOT NULL,
				ciphertext TEXT NOT NULL,
				tag TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS discord_projections (
				scope_key TEXT PRIMARY KEY,
				channel_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS job_events_job_ordinal ON job_events(job_id, ordinal);
			CREATE INDEX IF NOT EXISTS jobs_updated_at ON jobs(updated_at DESC);
			CREATE UNIQUE INDEX IF NOT EXISTS delivery_attempt_job ON delivery_attempts(job_id, attempt_id);
		`);
		const ensureColumn = (table, column, declaration) => {
			const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
			if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
		};
		ensureColumn("service_state", "boot_id", "TEXT");
		ensureColumn("service_state", "process_start_identity", "TEXT");
		ensureColumn("jobs", "child_pid", "INTEGER");
		ensureColumn("jobs", "child_boot_id", "TEXT");
		ensureColumn("jobs", "child_start_identity", "TEXT");
		ensureColumn("jobs", "scope_key", "TEXT");
		this.db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?)").run(String(DB_SCHEMA_VERSION));
	}

	loadGatewayState() {
		const row = this.db.prepare("SELECT * FROM gateway_state WHERE id = 1").get();
		return row ? { sessionId: row.session_id, resumeUrl: row.resume_url, sequence: row.sequence, heartbeatAckAt: row.heartbeat_ack_at, updatedAt: row.updated_at } : {};
	}

	saveGatewayState(patch, now = new Date().toISOString()) {
		canonicalTimestamp(now, "gateway state time");
		const current = this.loadGatewayState();
		const next = { ...current, ...patch };
		if (next.sequence !== null && next.sequence !== undefined && (!Number.isSafeInteger(next.sequence) || next.sequence < 0)) throw new Error("gateway sequence must be a non-negative safe integer");
		if (next.resumeUrl) {
			const url = new URL(next.resumeUrl);
			if (url.protocol !== "wss:" || !/(^|\.)discord\.gg$/.test(url.hostname)) throw new Error("unsafe gateway resume URL");
		}
		this.db.prepare(`INSERT INTO gateway_state(id, session_id, resume_url, sequence, heartbeat_ack_at, updated_at)
			VALUES(1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,
			resume_url=excluded.resume_url, sequence=excluded.sequence, heartbeat_ack_at=excluded.heartbeat_ack_at, updated_at=excluded.updated_at`)
			.run(next.sessionId ?? null, next.resumeUrl ?? null, next.sequence ?? null, next.heartbeatAckAt ?? null, now);
	}

	clearGatewayResume(now = new Date().toISOString()) {
		this.saveGatewayState({ sessionId: null, resumeUrl: null, sequence: null }, now);
	}

	loadDiscordProjection(scopeKey) {
		safeIdentifier(scopeKey, "scopeKey");
		const row = this.db.prepare("SELECT * FROM discord_projections WHERE scope_key = ?").get(scopeKey);
		return row ? { scopeKey: row.scope_key, channelId: row.channel_id, messageId: row.message_id, updatedAt: row.updated_at } : null;
	}

	saveDiscordProjection({ scopeKey, channelId, messageId, now = new Date().toISOString() }) {
		for (const [value, label] of [[scopeKey, "scopeKey"], [channelId, "channelId"], [messageId, "messageId"]]) safeIdentifier(value, label);
		canonicalTimestamp(now, "projection time");
		this.db.prepare(`INSERT INTO discord_projections(scope_key, channel_id, message_id, updated_at) VALUES(?, ?, ?, ?)
			ON CONFLICT(scope_key) DO UPDATE SET channel_id=excluded.channel_id, message_id=excluded.message_id, updated_at=excluded.updated_at`).run(scopeKey, channelId, messageId, now);
	}

	reserveIngress({ sourceMessageId, scopeKey, status, jobId = null, reasonCode, dispatchSequence = null, now = new Date().toISOString() }) {
		safeIdentifier(sourceMessageId, "sourceMessageId");
		safeIdentifier(scopeKey, "scopeKey");
		if (!new Set(["accepted", "rejected", "handled"]).has(status)) throw new Error("unsupported ingress status");
		safeIdentifier(reasonCode, "reasonCode");
		canonicalTimestamp(now, "ingress time");
		if (dispatchSequence !== null && (!Number.isSafeInteger(dispatchSequence) || dispatchSequence < 0)) throw new Error("invalid dispatch sequence");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.db.prepare("SELECT * FROM ingress_messages WHERE source_message_id = ?").get(sourceMessageId);
			if (existing) { this.db.exec("COMMIT"); return { duplicate: true, status: existing.status, jobId: existing.job_id }; }
			this.db.prepare(`INSERT INTO ingress_messages(source_message_id, scope_key, status, job_id, reason_code, dispatch_sequence, received_at, updated_at)
				VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(sourceMessageId, scopeKey, status, jobId, reasonCode, dispatchSequence, now, now);
			this.db.exec("COMMIT");
			return { duplicate: false, status, jobId };
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}

	acceptIngressAndCreateJob({ sourceMessageId, scopeKey, jobId, dispatchSequence = null, backendId, revision = "discord-v1", backendCapabilities = {}, activityDetail, jobType = "conversation", softSilenceMs = DEFAULT_SOFT_SILENCE_MS, recoveryEnvelope = null, now = new Date().toISOString() }) {
		for (const [value, label] of [[sourceMessageId, "sourceMessageId"], [scopeKey, "scopeKey"], [jobId, "jobId"], [backendId, "backendId"], [revision, "revision"]]) safeIdentifier(value, label);
		if (!/^\d{17,20}$/.test(sourceMessageId) || /^0+$/.test(sourceMessageId)) throw new Error("sourceMessageId must be a Discord snowflake");
		if (dispatchSequence !== null && (!Number.isSafeInteger(dispatchSequence) || dispatchSequence < 0)) throw new Error("invalid dispatch sequence");
		canonicalTimestamp(now, "ingress acceptance time");
		if (!Number.isSafeInteger(softSilenceMs) || softSilenceMs < 0) throw new Error("softSilenceMs must be a non-negative safe integer");
		if (!ACTIVITY_DETAILS.has(activityDetail)) throw new Error(`unsupported activity detail: ${activityDetail}`);
		buildSafeEventSummary("attempt_started", { backend: backendId });
		const safeCapabilities = validateBackendCapabilities(backendCapabilities);
		const summary = buildSafeEventSummary("job_accepted", { jobType });
		if (recoveryEnvelope !== null) {
			for (const key of ["iv", "ciphertext", "tag"]) if (typeof recoveryEnvelope[key] !== "string" || !/^[A-Za-z0-9_-]+$/.test(recoveryEnvelope[key])) throw new Error("recovery envelope is invalid");
		}
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.db.prepare("SELECT * FROM ingress_messages WHERE source_message_id = ?").get(sourceMessageId);
			if (existing) {
				this.db.exec("COMMIT");
				return { duplicate: true, status: existing.status, jobId: existing.job_id };
			}
			this.db.prepare(`INSERT INTO ingress_messages(source_message_id, scope_key, status, job_id, reason_code, dispatch_sequence, received_at, updated_at)
				VALUES(?, ?, 'accepted', ?, 'authorized', ?, ?, ?)`).run(sourceMessageId, scopeKey, jobId, dispatchSequence, now, now);
			this.db.prepare(`INSERT INTO jobs(job_id, lifecycle, backend_id, revision, backend_capabilities_json, activity_detail,
				safe_summary, accepted_at, updated_at, soft_silence_ms, scope_key)
				VALUES(?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(jobId, backendId, revision, json(safeCapabilities), activityDetail, summary, now, now, softSilenceMs, scopeKey);
			this.#appendEvent({ jobId, dedupeKey: `job_accepted:${jobId}`, kind: "job_accepted", occurredAt: now, source: "gateway", safeSummary: summary });
			if (recoveryEnvelope) this.db.prepare("INSERT INTO job_recovery(job_id, iv, ciphertext, tag, updated_at) VALUES(?, ?, ?, ?, ?)").run(jobId, recoveryEnvelope.iv, recoveryEnvelope.ciphertext, recoveryEnvelope.tag, now);
			this.db.exec("COMMIT");
			this.#hardenSidecars();
			return { duplicate: false, status: "accepted", jobId };
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}

	reserveDelivery({ deliveryKey, jobId, attemptId, nonce, channelId, now = new Date().toISOString() }) {
		for (const [value, label] of [[deliveryKey, "deliveryKey"], [attemptId, "attemptId"], [nonce, "nonce"], [channelId, "channelId"]]) safeIdentifier(value, label);
		canonicalTimestamp(now, "delivery start time");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.db.prepare("SELECT * FROM delivery_attempts WHERE job_id = ? AND attempt_id = ?").get(jobId, attemptId);
			if (existing) {
				if (existing.channel_id !== channelId) throw new Error("delivery destination mismatch");
				if (existing.status === "started") {
					this.db.prepare("UPDATE delivery_attempts SET status = 'unknown', updated_at = ? WHERE delivery_key = ?").run(now, existing.delivery_key);
					this.#appendEvent({ jobId, attemptId, kind: "delivery_unknown", source: "recovery", occurredAt: now, safeSummary: buildSafeEventSummary("delivery_unknown", {}) });
					existing.status = "unknown";
				}
				this.db.exec("COMMIT");
				return { existing: true, deliveryKey: existing.delivery_key, nonce: existing.nonce, channelId: existing.channel_id, status: existing.status };
			}
			this.db.prepare(`INSERT INTO delivery_attempts(delivery_key, job_id, attempt_id, nonce, channel_id, status, started_at, updated_at)
				VALUES(?, ?, ?, ?, ?, 'started', ?, ?)`)
				.run(deliveryKey, jobId, attemptId, nonce, channelId, now, now);
			this.#appendEvent({ jobId, attemptId, kind: "delivery_started", source: "helper", occurredAt: now, safeSummary: buildSafeEventSummary("delivery_started", {}) });
			this.db.exec("COMMIT");
			return { existing: false, deliveryKey, nonce, channelId, status: "started" };
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}

	startDelivery(input) { return this.reserveDelivery(input); }

	finishDelivery({ deliveryKey, status, messageId = null, reasonCode = "internal_error", now = new Date().toISOString() }) {
		if (!new Set(["confirmed", "unknown", "failed"]).has(status)) throw new Error("unsupported delivery status");
		canonicalTimestamp(now, "delivery finish time");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const delivery = this.db.prepare("SELECT * FROM delivery_attempts WHERE delivery_key = ?").get(deliveryKey);
			if (!delivery) throw new Error("unknown delivery key");
			if (delivery.status !== "started") throw new Error("delivery is already finalized");
			this.db.prepare("UPDATE delivery_attempts SET status = ?, message_id = ?, updated_at = ? WHERE delivery_key = ?").run(status, messageId, now, deliveryKey);
			const kind = status === "confirmed" ? "delivery_confirmed" : status === "unknown" ? "delivery_unknown" : "failed";
			this.#appendEvent({ jobId: delivery.job_id, attemptId: delivery.attempt_id, kind, source: "helper", occurredAt: now,
				safeSummary: buildSafeEventSummary(kind, status === "failed" ? { reasonCode } : {}) });
			this.db.exec("COMMIT");
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}

	recoverInterruptedWork({ now = new Date().toISOString() } = {}) {
		canonicalTimestamp(now, "recovery time");
		const recovered = [];
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const jobs = this.db.prepare("SELECT * FROM jobs WHERE lifecycle NOT IN ('completed', 'failed', 'cancelled', 'recovery_review') ORDER BY accepted_at").all();
			for (const job of jobs) {
				const started = this.db.prepare("SELECT * FROM delivery_attempts WHERE job_id = ? AND status = 'started'").all(job.job_id);
				if (started.length > 0) {
					for (const delivery of started) {
						this.db.prepare("UPDATE delivery_attempts SET status = 'unknown', updated_at = ? WHERE delivery_key = ?").run(now, delivery.delivery_key);
						this.#appendEvent({ jobId: job.job_id, attemptId: delivery.attempt_id, kind: "delivery_unknown", source: "recovery", occurredAt: now, safeSummary: buildSafeEventSummary("delivery_unknown", {}) });
					}
				} else {
					const envelope = this.db.prepare("SELECT iv, ciphertext, tag FROM job_recovery WHERE job_id = ?").get(job.job_id);
					if (envelope) {
						this.#appendEvent({ jobId: job.job_id, attemptId: job.attempt_id, kind: "recovered", source: "recovery", occurredAt: now, safeSummary: buildSafeEventSummary("recovered", { recoveryAction: "safe_retry" }) });
						this.db.prepare("UPDATE jobs SET attempt_id = NULL, child_alive = 0, child_pid = NULL, child_boot_id = NULL, child_start_identity = NULL, recovery_state = 'resuming' WHERE job_id = ?").run(job.job_id);
						recovered.push({ jobId: job.job_id, backendId: job.backend_id, envelope: { iv: envelope.iv, ciphertext: envelope.ciphertext, tag: envelope.tag } });
					} else {
						this.#appendEvent({ jobId: job.job_id, attemptId: job.attempt_id, kind: "recovery_review_required", source: "recovery", occurredAt: now, safeSummary: buildSafeEventSummary("recovery_review_required", {}) });
					}
				}
			}
			this.db.exec("COMMIT");
			return recovered;
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}

	close() {
		this.db.close();
	}

	heartbeatService({ generation = randomUUID(), status = "running", pid = process.pid, now = new Date().toISOString() } = {}) {
		const bootId = this.readBootId();
		const processStartIdentity = this.readProcessStartIdentity(pid);
		safeIdentifier(generation, "generation");
		if (!new Set(["running", "stopped"]).has(status)) throw new Error("service status is not allowed");
		if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error("service pid must be a positive safe integer or null");
		canonicalTimestamp(now, "heartbeat time");
		if (bootId !== null) safeIdentifier(bootId, "bootId");
		if (processStartIdentity !== null) safeIdentifier(processStartIdentity, "processStartIdentity");
		const existing = this.db.prepare("SELECT * FROM service_state WHERE id = 1").get();
		if (existing) {
			const sameOwnerTuple = existing.pid === pid && existing.boot_id === bootId && existing.process_start_identity === processStartIdentity;
			if (existing.generation === generation && !sameOwnerTuple) throw new Error(`service ownership conflict within generation ${generation}`);
			if (existing.generation !== generation && existing.boot_id === bootId) {
				const existingHealth = projectServiceHealth(existing, Date.parse(now));
				if (!new Set(["stopped", "stale"]).has(existingHealth.state)) throw new Error(`service ownership conflict with generation ${existing.generation}`);
			}
		}
		this.db.prepare(`
			INSERT INTO service_state(id, generation, status, pid, started_at, heartbeat_at, boot_id, process_start_identity)
			VALUES(1, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, status = excluded.status,
				pid = excluded.pid, heartbeat_at = excluded.heartbeat_at, boot_id = excluded.boot_id,
				process_start_identity = excluded.process_start_identity
		`).run(generation, status, pid, now, now, bootId, processStartIdentity);
		return generation;
	}

	createJob({
		jobId = randomUUID(),
		backendId,
		revision = "unversioned",
		backendCapabilities = {},
		activityDetail = "unsupported",
		jobType = "unknown",
		scopeKey = null,
		now = new Date().toISOString(),
		softSilenceMs = DEFAULT_SOFT_SILENCE_MS,
		hardDeadlineAt = null,
		requiredChecks = [],
	}) {
		if (!backendId) throw new Error("backendId is required");
		safeIdentifier(jobId, "jobId");
		buildSafeEventSummary("attempt_started", { backend: backendId });
		safeIdentifier(revision, "revision");
		canonicalTimestamp(now, "job acceptance time");
		if (!Number.isSafeInteger(softSilenceMs) || softSilenceMs < 0) throw new Error("softSilenceMs must be a non-negative safe integer");
		if (hardDeadlineAt !== null) canonicalTimestamp(hardDeadlineAt, "hard deadline");
		if (!ACTIVITY_DETAILS.has(activityDetail)) throw new Error(`unsupported activity detail: ${activityDetail}`);
		const safeCapabilities = validateBackendCapabilities(backendCapabilities);
		if (scopeKey !== null) safeIdentifier(scopeKey, "scopeKey");
		const summary = buildSafeEventSummary("job_accepted", { jobType });
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare(`
				INSERT INTO jobs(job_id, lifecycle, backend_id, revision, backend_capabilities_json, activity_detail,
					safe_summary, accepted_at, updated_at, soft_silence_ms, hard_deadline_at, scope_key)
				VALUES(?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(jobId, backendId, revision, json(safeCapabilities), activityDetail, summary, now, now, softSilenceMs, hardDeadlineAt, scopeKey);
			for (const check of requiredChecks) {
				if (!check.checkId || !check.kind) throw new Error("required check needs checkId and kind");
				safeIdentifier(check.checkId, "checkId");
				if (!new Set(["requirement", "build", "test", "review"]).has(check.kind)) throw new Error(`unsupported required check kind: ${check.kind}`);
				const checkLabel = `${check.kind}:${check.checkId}`;
				this.db.prepare(`
					INSERT INTO required_checks(check_id, job_id, kind, safe_label, required, revision, allow_reuse)
					VALUES(?, ?, ?, ?, ?, ?, ?)
				`).run(check.checkId, jobId, check.kind, checkLabel, check.required === false ? 0 : 1, revision, check.allowReuse ? 1 : 0);
			}
			this.#appendEvent({ jobId, dedupeKey: `job_accepted:${jobId}`, kind: "job_accepted", occurredAt: now, source: "gateway", safeSummary: summary });
			this.db.exec("COMMIT");
			this.#hardenSidecars();
			return jobId;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	reserveAttempt(jobId, { attemptId = randomUUID(), now = new Date().toISOString(), backendId = null, replaceCurrent = false } = {}) {
		safeIdentifier(attemptId, "attemptId");
		canonicalTimestamp(now, "attempt reservation time");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const job = this.db.prepare("SELECT backend_id, attempt_id, child_alive FROM jobs WHERE job_id = ?").get(jobId);
			if (!job) throw new Error(`unknown job: ${jobId}`);
			if (backendId !== null && backendId !== job.backend_id) throw new Error(`job backend mismatch: expected ${job.backend_id}`);
			if ((job.attempt_id || job.child_alive) && !replaceCurrent) throw new Error("job already has an active attempt or reservation");
			if (replaceCurrent) this.db.prepare("UPDATE jobs SET child_alive = 0, child_pid = NULL, child_boot_id = NULL, child_start_identity = NULL WHERE job_id = ?").run(jobId);
			this.#appendEvent({ jobId, attemptId, dedupeKey: `attempt_reserved:${attemptId}`, kind: "attempt_reserved", occurredAt: now, source: "helper", safeSummary: buildSafeEventSummary("attempt_reserved", { backend: job.backend_id }) });
			this.db.exec("COMMIT");
			this.#hardenSidecars();
			return attemptId;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	attachAttempt(jobId, { attemptId, now = new Date().toISOString(), childPid = process.pid, backendId = null } = {}) {
		const childBootId = this.readBootId();
		const childStartIdentity = this.readProcessStartIdentity(childPid);
		safeIdentifier(attemptId, "attemptId");
		canonicalTimestamp(now, "attempt start time");
		if (!Number.isSafeInteger(childPid) || childPid <= 0) throw new Error("childPid must be a positive safe integer");
		if (childBootId !== null) safeIdentifier(childBootId, "childBootId");
		if (childStartIdentity !== null) safeIdentifier(childStartIdentity, "childStartIdentity");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const job = this.db.prepare("SELECT backend_id, attempt_id, child_alive FROM jobs WHERE job_id = ?").get(jobId);
			if (!job) throw new Error(`unknown job: ${jobId}`);
			if (backendId !== null && backendId !== job.backend_id) throw new Error(`job backend mismatch: expected ${job.backend_id}`);
			if (job.attempt_id !== attemptId) throw new Error("attempt reservation ownership mismatch");
			if (job.child_alive) throw new Error("job already has an active attempt");
			this.#appendEvent({ jobId, attemptId, dedupeKey: `attempt_started:${attemptId}`, kind: "attempt_started", occurredAt: now, source: "helper", safeSummary: buildSafeEventSummary("attempt_started", { backend: job.backend_id }) });
			this.db.prepare("UPDATE jobs SET child_pid = ?, child_boot_id = ?, child_start_identity = ? WHERE job_id = ?").run(childPid, childBootId, childStartIdentity, jobId);
			this.db.exec("COMMIT");
			this.#hardenSidecars();
			return attemptId;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	startAttempt(jobId, { attemptId = randomUUID(), now = new Date().toISOString(), childPid = process.pid, backendId = null, replaceCurrent = false } = {}) {
		this.reserveAttempt(jobId, { attemptId, now, backendId, replaceCurrent });
		return this.attachAttempt(jobId, { attemptId, now, childPid, backendId });
	}

	recordEvent(input) {
		assertOnlyKeys(input, EVENT_INPUT_KEYS, "event");
		if (!EVENT_KINDS.has(input.kind)) throw new Error(`unsupported event kind: ${input.kind}`);
		if (!EVENT_SOURCES.get(input.kind)?.has(input.source)) throw new Error(`event source ${input.source} cannot produce ${input.kind}`);
		if (EXTERNAL_EVENT_SOURCES.has(input.source) && !input.dedupeKey) throw new Error(`external event ${input.kind} requires a stable dedupeKey`);
		if (EXTERNAL_EVENT_SOURCES.has(input.source) && !input.attemptId) throw new Error(`external event ${input.kind} requires the current attemptId`);
		if (input.dedupeKey) safeIdentifier(input.dedupeKey, "dedupeKey");
		if (input.attemptId !== undefined && input.attemptId !== null) safeIdentifier(input.attemptId, "attemptId");
		if (input.occurredAt !== undefined) canonicalTimestamp(input.occurredAt, "event occurredAt");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const { safePayload, ...eventInput } = input;
			const event = this.#appendEvent({ ...eventInput, safeSummary: buildSafeEventSummary(input.kind, safePayload) });
			this.db.exec("COMMIT");
			this.#hardenSidecars();
			return event;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	#appendEvent({
		jobId,
		dedupeKey = `internal:${randomUUID()}`,
		attemptId = null,
		kind,
		occurredAt = new Date().toISOString(),
		source = "helper",
		safeSummary = "",
		metrics = {},
		redactionLevel = "metadata_only",
	}) {
		canonicalTimestamp(occurredAt, "event occurredAt");
		if (attemptId !== null) safeIdentifier(attemptId, "attemptId");
		const job = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
		if (!job) throw new Error(`unknown job: ${jobId}`);
		if (kind === "output_activity" && attemptId) {
			const bucket = Math.floor(Date.parse(occurredAt) / 1_000);
			if (!Number.isFinite(bucket)) throw new Error("output activity needs a valid occurredAt");
			dedupeKey = `output_activity:${attemptId}:${bucket}`;
		}
		const summary = sanitizeSummary(safeSummary);
		const safeMetrics = validateSafeMetrics(metrics);
		const duplicate = this.db.prepare("SELECT * FROM job_events WHERE job_id = ? AND dedupe_key = ?").get(jobId, dedupeKey);
		if (duplicate) {
			if (duplicate.kind !== kind || duplicate.attempt_id !== attemptId || duplicate.source !== source) {
				throw new Error(`dedupe key conflict: ${dedupeKey}`);
			}
			if (kind !== "output_activity" && (duplicate.occurred_at !== occurredAt || duplicate.safe_summary !== summary || duplicate.metrics_json !== json(safeMetrics) || duplicate.redaction_level !== redactionLevel)) {
				throw new Error(`dedupe key content conflict: ${dedupeKey}`);
			}
			return this.#mapEvent(duplicate);
		}
		if (attemptId && !new Set(["attempt_reserved", "attempt_started"]).has(kind) && job.attempt_id && attemptId !== job.attempt_id) throw new Error(`stale attempt event rejected: ${attemptId}`);
		if (!new Set(["metadata_only", "local_safe"]).has(redactionLevel)) throw new Error(`unsupported redaction level: ${redactionLevel}`);
		if (!new Set(["gateway", "helper", "codex", "claude", "fake_backend", "host_verifier", "backend_claim", "human_review", "recovery"]).has(source)) {
			throw new Error(`unsupported event source: ${source}`);
		}
		const sequence = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM job_events WHERE job_id = ?").get(jobId).next;
		const eventId = randomUUID();
		const lifecycle = transitionFor(kind, job.lifecycle);
		if (!LIFECYCLES.has(lifecycle)) throw new Error(`invalid lifecycle: ${lifecycle}`);
		if (!ALLOWED_TRANSITIONS.get(job.lifecycle)?.has(lifecycle)) {
			throw new Error(`invalid lifecycle transition: ${job.lifecycle} -> ${lifecycle}`);
		}
		const insertResult = this.db.prepare(`
			INSERT INTO job_events(event_id, dedupe_key, job_id, attempt_id, sequence, kind, occurred_at, source,
				safe_summary, metrics_json, redaction_level)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(eventId, dedupeKey, jobId, attemptId, sequence, kind, occurredAt, source, summary, json(safeMetrics), redactionLevel);
		const progressKinds = new Set(["attempt_started", "backend_ready", "phase_changed", "output_activity", "tool_started", "tool_finished", "checkpoint_saved", "verification_recorded"]);
			const childAlive = kind === "attempt_started" ? 1 : ["attempt_exited", "failed", "completed", "cancelled", "recovered", "recovery_review_required", "operator_response_missed", "delivery_unknown"].includes(kind) ? 0 : job.child_alive;
		const deliveryState = kind === "delivery_started" ? "sending" : kind === "delivery_confirmed" ? "delivered" : kind === "delivery_unknown" ? "unknown" : job.delivery_state;
		this.db.prepare(`
			UPDATE jobs SET attempt_id = COALESCE(?, attempt_id), lifecycle = ?, updated_at = ?,
				started_at = CASE WHEN ? = 'attempt_started' THEN COALESCE(started_at, ?) ELSE started_at END,
				last_progress_at = CASE WHEN ? THEN ? ELSE last_progress_at END,
				current_activity = CASE WHEN ? THEN ? ELSE current_activity END,
				waiting_reason = CASE WHEN ? = 'approval_required' THEN ? ELSE waiting_reason END,
				child_alive = ?, delivery_state = ?, recovery_state = CASE WHEN ? = 'recovered' THEN 'resuming' WHEN ? IN ('recovery_review_required', 'delivery_unknown') THEN 'review_required' ELSE recovery_state END,
				latest_safe_error = CASE WHEN ? = 'failed' THEN ? ELSE latest_safe_error END
			WHERE job_id = ?
		`).run(attemptId, lifecycle, occurredAt, kind, occurredAt, progressKinds.has(kind) ? 1 : 0, occurredAt,
			progressKinds.has(kind) ? 1 : 0, summary, kind, summary, childAlive, deliveryState, kind, kind, kind, summary, jobId);
			if (["delivery_confirmed", "completed", "failed", "cancelled", "recovery_review_required", "operator_response_missed", "delivery_unknown"].includes(kind)) this.db.prepare("DELETE FROM job_recovery WHERE job_id = ?").run(jobId);
		return { ordinal: Number(insertResult.lastInsertRowid), eventId, dedupeKey, jobId, attemptId, sequence, kind, occurredAt, source, safeSummary: summary, metrics: safeMetrics, redactionLevel };
	}

	#mapEvent(event) {
		return {
			ordinal: event.ordinal,
			eventId: event.event_id,
			dedupeKey: event.dedupe_key,
			jobId: event.job_id,
			attemptId: event.attempt_id,
			sequence: event.sequence,
			kind: event.kind,
			occurredAt: event.occurred_at,
			source: event.source,
			safeSummary: event.safe_summary,
			metrics: parseJson(event.metrics_json, {}),
			redactionLevel: event.redaction_level,
		};
	}

	recordEvidence({ jobId, checkId, attemptId = null, revision, producer, verifier, result, observedAt = new Date().toISOString(), metrics = {} }) {
		safeIdentifier(jobId, "jobId");
		if (attemptId !== null) safeIdentifier(attemptId, "attemptId");
		safeIdentifier(revision, "revision");
		canonicalTimestamp(observedAt, "evidence observedAt");
		if (!new Set(["passed", "failed", "missing"]).has(result)) throw new Error(`unsupported evidence result: ${result}`);
		if (!new Set(["host_verifier", "backend_claim", "human_review"]).has(producer)) throw new Error(`unsupported evidence producer: ${producer}`);
		const check = this.db.prepare("SELECT * FROM required_checks WHERE job_id = ? AND check_id = ?").get(jobId, checkId);
		if (!check) throw new Error(`unknown required check: ${checkId}`);
		const currentJob = this.db.prepare("SELECT attempt_id FROM jobs WHERE job_id = ?").get(jobId);
		if (!currentJob.attempt_id || attemptId !== currentJob.attempt_id) throw new Error(`stale attempt evidence rejected: ${attemptId}`);
		if (revision !== check.revision && !check.allow_reuse) throw new Error(`evidence revision mismatch for ${checkId}`);
		const label = sanitizeSummary(check.safe_label);
		const safeVerifier = safeIdentifier(verifier, "verifier");
		const safeMetrics = validateSafeMetrics(metrics);
		const evidenceId = randomUUID();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare(`
				INSERT INTO evidence(evidence_id, job_id, check_id, attempt_id, revision, kind, safe_label,
					required, result, producer, verifier, observed_at, metrics_json)
				VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(evidenceId, jobId, checkId, attemptId, revision, check.kind, label, check.required, result, producer, safeVerifier, observedAt, json(safeMetrics));
			this.#appendEvent({ jobId, attemptId, dedupeKey: `verification:${evidenceId}`, kind: "verification_recorded", occurredAt: observedAt, source: producer, safeSummary: buildSafeEventSummary("verification_recorded", { checkId }), metrics: safeMetrics });
			this.db.exec("COMMIT");
			this.#hardenSidecars();
			return evidenceId;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	status({ nowMs = Date.now(), staleAfterMs } = {}) {
		const service = this.db.prepare("SELECT * FROM service_state WHERE id = 1").get();
		const serviceHealth = projectServiceHealth(service, nowMs, staleAfterMs);
		const jobs = this.listJobs({ nowMs, serviceHealth });
		const gateway = this.loadGatewayState();
		return {
				schemaVersion: OUTPUT_SCHEMA_VERSION,
			service: serviceHealth,
			gateway: { resumable: Boolean(gateway.sessionId && Number.isSafeInteger(gateway.sequence)), sequence: gateway.sequence ?? null, lastHeartbeatAckAt: gateway.heartbeatAckAt ?? null },
			jobs: {
				active: jobs.filter((job) => !["completed", "failed", "cancelled", "recovery_review"].includes(job.lifecycle)).length,
				suspectedStalled: jobs.filter((job) => job.activityHealth.value === "suspected_stalled").length,
				needsReview: jobs.filter((job) => job.lifecycle === "recovery_review").length,
			},
		};
	}

	listJobs({ nowMs = Date.now(), serviceHealth } = {}) {
		const health = serviceHealth ?? projectServiceHealth(this.db.prepare("SELECT * FROM service_state WHERE id = 1").get(), nowMs);
		return this.db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC").all().map((job) => this.#projectJob(job, health, nowMs, false));
	}

	listJobsForScope(scopeKey, options = {}) {
		safeIdentifier(scopeKey, "scopeKey");
		const health = options.serviceHealth ?? projectServiceHealth(this.db.prepare("SELECT * FROM service_state WHERE id = 1").get(), options.nowMs ?? Date.now());
		return this.db.prepare("SELECT * FROM jobs WHERE scope_key = ? ORDER BY updated_at DESC").all(scopeKey).map((job) => this.#projectJob(job, health, options.nowMs ?? Date.now(), false));
	}

	getJob(jobId, { nowMs = Date.now(), includeEvents = true } = {}) {
		const job = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
		if (!job) return null;
		const health = projectServiceHealth(this.db.prepare("SELECT * FROM service_state WHERE id = 1").get(), nowMs);
		return this.#projectJob(job, health, nowMs, includeEvents);
	}

	#projectJob(job, serviceHealth, nowMs, includeEvents) {
		const childObservation = job.child_alive
			? observeOwnedProcess({ pid: job.child_pid, bootId: job.child_boot_id, processStartIdentity: job.child_start_identity })
			: { state: "not_expected", processAlive: false, reasonCode: "child_not_expected" };
		const healthJob = { ...job, child_alive: childObservation.state === "owned" ? 1 : 0, child_observation: childObservation };
		const checks = this.db.prepare("SELECT * FROM required_checks WHERE job_id = ? ORDER BY check_id").all(job.job_id);
		const evidence = this.db.prepare("SELECT * FROM evidence WHERE job_id = ? ORDER BY observed_at").all(job.job_id).map((item) => ({
			...item,
			metrics: parseJson(item.metrics_json, {}),
		}));
		const projected = {
			jobId: job.job_id,
			attemptId: job.attempt_id,
			lifecycle: job.lifecycle,
			activityHealth: projectActivityHealth(healthJob, serviceHealth, nowMs),
			backendId: job.backend_id,
			scopeKey: job.scope_key,
			revision: job.revision,
			backendCapabilities: parseJson(job.backend_capabilities_json, {}),
			activityDetail: job.activity_detail,
			safeSummary: job.safe_summary,
			acceptedAt: job.accepted_at,
			startedAt: job.started_at,
			updatedAt: job.updated_at,
			lastProgressAt: job.last_progress_at,
			softSilenceMs: job.soft_silence_ms,
			hardDeadlineAt: job.hard_deadline_at,
			currentActivity: job.current_activity,
			waitingReason: job.waiting_reason,
			childAlive: childObservation.state === "owned",
			childState: childObservation,
			deliveryState: job.delivery_state,
			recoveryState: job.recovery_state,
			latestSafeError: job.latest_safe_error,
			completionAssessment: projectCompletionAssessment(checks, evidence, job.revision, job.attempt_id),
			requiredChecks: checks.map((check) => ({ checkId: check.check_id, kind: check.kind, safeLabel: check.safe_label, required: Boolean(check.required), revision: check.revision, allowReuse: Boolean(check.allow_reuse) })),
			evidence,
		};
		if (includeEvents) projected.events = this.eventsAfter({ jobId: job.job_id });
		return projected;
	}

	eventsAfter({ jobId = null, afterOrdinal = 0 } = {}) {
		const rows = jobId
			? this.db.prepare("SELECT * FROM job_events WHERE job_id = ? AND ordinal > ? ORDER BY ordinal").all(jobId, afterOrdinal)
			: this.db.prepare("SELECT * FROM job_events WHERE ordinal > ? ORDER BY ordinal").all(afterOrdinal);
		return rows.map((event) => this.#mapEvent(event));
	}
}
