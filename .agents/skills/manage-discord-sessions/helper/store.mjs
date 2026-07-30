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
	["retry_scheduled", new Set(["helper", "recovery"])],
	["delivery_started", new Set(["helper"])],
	["delivery_confirmed", new Set(["helper", "recovery"])],
	["delivery_unknown", new Set(["helper", "recovery"])],
	["recovered", new Set(["recovery"])],
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
		case "attempt_started":
		case "backend_ready":
		case "phase_changed":
		case "output_activity":
		case "tool_started":
		case "tool_finished":
		case "checkpoint_saved":
		case "recovered":
			return "running";
		case "verification_recorded":
			return current;
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
			CREATE INDEX IF NOT EXISTS job_events_job_ordinal ON job_events(job_id, ordinal);
			CREATE INDEX IF NOT EXISTS jobs_updated_at ON jobs(updated_at DESC);
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
		this.db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?)").run(String(DB_SCHEMA_VERSION));
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
		const summary = buildSafeEventSummary("job_accepted", { jobType });
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare(`
				INSERT INTO jobs(job_id, lifecycle, backend_id, revision, backend_capabilities_json, activity_detail,
					safe_summary, accepted_at, updated_at, soft_silence_ms, hard_deadline_at)
				VALUES(?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(jobId, backendId, revision, json(safeCapabilities), activityDetail, summary, now, now, softSilenceMs, hardDeadlineAt);
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

	startAttempt(jobId, { attemptId = randomUUID(), now = new Date().toISOString(), childPid = process.pid } = {}) {
		const childBootId = this.readBootId();
		const childStartIdentity = this.readProcessStartIdentity(childPid);
		safeIdentifier(attemptId, "attemptId");
		canonicalTimestamp(now, "attempt start time");
		if (!Number.isSafeInteger(childPid) || childPid <= 0) throw new Error("childPid must be a positive safe integer");
		if (childBootId !== null) safeIdentifier(childBootId, "childBootId");
		if (childStartIdentity !== null) safeIdentifier(childStartIdentity, "childStartIdentity");
		const job = this.db.prepare("SELECT backend_id FROM jobs WHERE job_id = ?").get(jobId);
		if (!job) throw new Error(`unknown job: ${jobId}`);
		this.recordEvent({ jobId, attemptId, dedupeKey: `attempt_started:${attemptId}`, kind: "attempt_started", occurredAt: now, source: "helper", safePayload: { backend: job.backend_id } });
		this.db.prepare("UPDATE jobs SET child_pid = ?, child_boot_id = ?, child_start_identity = ? WHERE job_id = ?").run(childPid, childBootId, childStartIdentity, jobId);
		return attemptId;
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
		if (attemptId && kind !== "attempt_started" && job.attempt_id && attemptId !== job.attempt_id) throw new Error(`stale attempt event rejected: ${attemptId}`);
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
		const progressKinds = new Set(["attempt_started", "backend_ready", "phase_changed", "output_activity", "tool_started", "tool_finished", "checkpoint_saved", "verification_recorded", "recovered"]);
		const childAlive = kind === "attempt_started" ? 1 : ["attempt_exited", "failed", "completed", "cancelled"].includes(kind) ? 0 : job.child_alive;
		const deliveryState = kind === "delivery_started" ? "sending" : kind === "delivery_confirmed" ? "delivered" : kind === "delivery_unknown" ? "unknown" : job.delivery_state;
		this.db.prepare(`
			UPDATE jobs SET attempt_id = COALESCE(?, attempt_id), lifecycle = ?, updated_at = ?,
				started_at = CASE WHEN ? = 'attempt_started' THEN COALESCE(started_at, ?) ELSE started_at END,
				last_progress_at = CASE WHEN ? THEN ? ELSE last_progress_at END,
				current_activity = CASE WHEN ? THEN ? ELSE current_activity END,
				waiting_reason = CASE WHEN ? = 'approval_required' THEN ? ELSE waiting_reason END,
				child_alive = ?, delivery_state = ?,
				latest_safe_error = CASE WHEN ? = 'failed' THEN ? ELSE latest_safe_error END
			WHERE job_id = ?
		`).run(attemptId, lifecycle, occurredAt, kind, occurredAt, progressKinds.has(kind) ? 1 : 0, occurredAt,
			progressKinds.has(kind) ? 1 : 0, summary, kind, summary, childAlive, deliveryState, kind, summary, jobId);
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
		return {
				schemaVersion: OUTPUT_SCHEMA_VERSION,
			service: serviceHealth,
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
