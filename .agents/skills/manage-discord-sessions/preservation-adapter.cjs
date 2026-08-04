#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ADAPTER_ID = "discord-sessions-v2";
const ROOTS = [".agents/skills/manage-discord-sessions", "naia-settings/messenger-sessions/config.example.json"];
const SURFACES = [
	{ id: "cli-watch-default", kind: "cli_command", marker: "watch-default", baseline: ["watch-event-stream"], current: ["watch-event-stream"] },
	{ id: "cli-watch-verbose", kind: "cli_command", marker: "watch-verbose", baseline: ["watch-event-stream"], current: ["watch-event-stream", "verbose-profile-label"] },
	{ id: "stable-instance-job-identity", kind: "identity_contract", marker: "instance-job-identity", baseline: ["instance-path-isolation"], current: ["instance-path-isolation"] },
	{ id: "safe-event-ledger", kind: "data_schema", marker: "safe-event-ledger", baseline: ["safe-event-schema"], current: ["safe-event-schema"] },
	{ id: "provider-adapters", kind: "runtime_adapter", marker: "provider-adapters", baseline: ["provider-event-normalization"], current: ["provider-event-normalization"] },
	{ id: "messenger-config-and-execution-revision", kind: "config_schema", marker: "config-execution-revision", baseline: ["messenger-config-load"], current: ["messenger-config-load", "short-profile-label"] },
	{ id: "atomic-discord-ingress", kind: "runtime_path", marker: "atomic-ingress", baseline: ["atomic-ingress-deduplication"], current: ["atomic-ingress-deduplication"] },
	{ id: "durable-job-recovery", kind: "runtime_path", marker: "durable-recovery", baseline: ["durable-review-recovery"], current: ["durable-review-recovery"] },
	{ id: "discord-status-projection", kind: "status_projection", marker: "status-projection", baseline: ["safe-operator-status"], current: ["safe-operator-status", "verbose-operator-status"] },
	{ id: "managed-service-cutover", kind: "deployment_contract", marker: "managed-cutover", baseline: ["managed-cutover-plan"], current: ["managed-cutover-plan"] },
];

const SUBJECT_SKILL = "/subject/.agents/skills/manage-discord-sessions";
function assert(value, message) { if (!value) throw new Error(message); }
function capabilities(surface, phase) { return [...surface[phase]].sort(); }
function moduleUrl(relative) { return pathToFileURL(path.join(SUBJECT_SKILL, "helper", relative)).href; }
async function imports(...relative) { return Promise.all(relative.map((file) => import(moduleUrl(file)))); }

function baseConfig(shortName) {
	return {
		schemaVersion: 1, enabled: true, workspaceId: "preservation-probe",
		persona: { name: "Long preservation probe persona", instructions: "Stay read-only.", ...(shortName ? { shortName } : {}) },
		role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: false } } },
		discord: { credentialRef: "discord-token", botUserId: "111111111111111111", operatorUserIds: [], bindings: [{ kind: "dm", userId: "222222222222222222", allowedUserIds: ["222222222222222222"], respondWhen: "always", canStartConversation: true }] },
		runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, noProgressInterventionSeconds: 120, operatorResponseSeconds: 30, approvalPolicy: "never", permissionProfileEpoch: "probe-1", maxConcurrentJobs: 1 },
		observability: { discordStatusProjection: true }, service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: true },
	};
}

async function fixture(challenge, shortName) {
	const root = path.join("/scratch", `discord-${challenge.slice(0, 16)}`);
	fs.mkdirSync(path.join(root, "naia-settings", "messenger-sessions"), { recursive: true, mode: 0o700 });
	const configPath = path.join(root, "naia-settings", "messenger-sessions", "config.json");
	fs.writeFileSync(configPath, `${JSON.stringify(baseConfig(shortName))}\n`, { mode: 0o600 });
	const [{ messengerInstancePaths }, { SessionStore }] = await imports("instance-paths.mjs", "store.mjs");
	const paths = messengerInstancePaths(root);
	fs.mkdirSync(path.dirname(paths.databasePath), { recursive: true, mode: 0o700 });
	return { root, configPath, paths, store: new SessionStore(paths.databasePath) };
}

function runCli(root, args) {
	return cp.spawnSync(process.execPath, [path.join(SUBJECT_SKILL, "helper", "cli.mjs"), "--adk-root", root, ...args], { encoding: "utf8", env: { HOME: "/scratch", TMPDIR: "/scratch", PATH: "/usr/bin:/bin" }, timeout: 20_000, maxBuffer: 1024 * 1024 });
}

async function probeWatch(input, verbose) {
	const fx = await fixture(input.challenge, verbose && input.phase === "current" ? "온맘" : null);
	fx.store.createJob({ jobId: "123e4567-e89b-12d3-a456-426614174000", backendId: "codex", revision: "probe", activityDetail: "structured", jobType: "issue_work" });
	const attemptId = fx.store.startAttempt("123e4567-e89b-12d3-a456-426614174000", { attemptId: "probe-attempt" });
	fx.store.recordEvent({ jobId: "123e4567-e89b-12d3-a456-426614174000", attemptId, dedupeKey: "probe-phase", kind: "phase_changed", source: "codex", safePayload: { phase: "planning" } });
	fx.store.close();
	const args = ["watch", "--job", "123e4567-e89b-12d3-a456-426614174000", "--once"];
	if (verbose && input.phase === "current") args.push("--verbose");
	else args.push("--jsonl");
	const result = runCli(fx.root, args);
	assert(result.status === 0 && result.stderr === "", "real watch CLI failed");
	if (verbose && input.phase === "current") {
		assert(result.stdout.includes("[온맘]") && result.stdout.includes("phase planning") && !result.stdout.includes("123e4567-e89b-12d3-a456-426614174000"), "verbose profile projection failed");
	} else {
		const records = result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
		assert(records.some((record) => record.event && record.event.kind === "phase_changed"), "watch JSONL did not expose the real event ledger");
	}
}

async function probeIdentity(input) {
	const [{ messengerInstancePaths, normalizeMessengerInstance }, { discordUnitIdentity, renderDiscordUserUnit }] = await imports("instance-paths.mjs", "systemd.mjs");
	const root = `/scratch/identity-${input.challenge.slice(0, 8)}`;
	fs.mkdirSync(root, { mode: 0o700 });
	const base = messengerInstancePaths(root);
	const named = messengerInstancePaths(root, "alpha");
	assert(base.databasePath !== named.databasePath && base.lockPath !== named.lockPath && discordUnitIdentity(root).unitName !== discordUnitIdentity(root, "alpha").unitName, "instance identity collapsed");
	const unit = renderDiscordUserUnit({ adkRoot: root, instance: "alpha", tokenFingerprint: "a".repeat(64), runtimeRevision: "b".repeat(40), nodePath: process.execPath });
	assert(unit.content.includes('--instance" "alpha') && unit.content.includes("naia-discord-token-"), "named managed unit lost identity");
	let rejected = false;
	try { normalizeMessengerInstance("../alpha"); } catch { rejected = true; }
	assert(rejected, "unsafe instance accepted");
}

async function probeSafeLedger(input) {
	const fx = await fixture(input.challenge);
	let invalidJob = false;
	try { fx.store.createJob({ jobId: "unsafe", backendId: "codex", revision: "probe", activityDetail: "structured", jobType: "sk-secretvalue123456789" }); } catch { invalidJob = true; }
	fx.store.createJob({ jobId: "safe", backendId: "codex", revision: "probe", activityDetail: "structured", jobType: "issue_work" });
	let invalidEvent = false;
	try { fx.store.recordEvent({ jobId: "safe", kind: "phase_changed", source: "codex", safePayload: { phase: "planning" }, raw: "secret" }); } catch { invalidEvent = true; }
	fx.store.close();
	assert(invalidJob && invalidEvent, "unsafe ledger input reached storage");
}

async function probeProvider(input) {
	const [{ parseBackendLine, inspectBackendLine }] = await imports("adapters.mjs");
	const secret = "never-persist-preservation-probe-content";
	const codex = parseBackendLine({ backendId: "codex", attemptId: "attempt-1", lineNumber: 1, line: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: secret } }) });
	const claude = parseBackendLine({ backendId: "claude", attemptId: "attempt-2", lineNumber: 1, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: secret }] } }) });
	const reasoning = input.phase === "current" ? inspectBackendLine({ backendId: "codex", attemptId: "attempt-3", lineNumber: 1, line: JSON.stringify({ type: "item.started", item: { id: "reasoning-1", type: "reasoning", text: secret } }) }) : null;
	assert(codex[0].kind === "output_activity" && claude[0].kind === "output_activity" && (!reasoning || reasoning.events[0].safePayload.phase === "planning") && !JSON.stringify({ codex, claude, reasoning }).includes(secret), "provider normalization leaked content");
}

async function probeConfig(input) {
	const fx = await fixture(input.challenge, input.phase === "current" ? "온맘" : null);
	fx.store.close();
	const [{ loadMessengerConfig }, { configurationRevision }] = await imports("discord-config.mjs", "execution-profile.mjs");
	const config = loadMessengerConfig(fx.configPath);
	assert(config.runtime.approvalPolicy === "never", "config contract failed");
	if (input.phase === "current") {
		const { operatorProfile } = await import(moduleUrl("operator-trace.mjs"));
		assert(configurationRevision(config) === configurationRevision({ ...config, persona: { ...config.persona, shortName: "다른표시" } }) && operatorProfile({ instance: "default", config }).label === "온맘", "short profile label or execution revision failed");
	}
}

async function probeIngress(input) {
	const fx = await fixture(input.challenge);
	const request = { sourceMessageId: "666666666666666666", scopeKey: "scope-1", jobId: "job-1", dispatchSequence: 42, backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured" };
	const first = fx.store.acceptIngressAndCreateJob(request);
	const replay = fx.store.acceptIngressAndCreateJob({ ...request, jobId: "job-2" });
	assert(first.duplicate === false && replay.jobId === "job-1" && fx.store.listJobs().length === 1 && fx.store.getJob("job-1").events[0].kind === "job_accepted", "atomic ingress dedupe failed");
	fx.store.close();
}

async function probeRecovery(input) {
	const fx = await fixture(input.challenge);
	fx.store.createJob({ jobId: "codex-job", backendId: "codex", activityDetail: "structured", jobType: "conversation" });
	fx.store.createJob({ jobId: "claude-job", backendId: "claude", activityDetail: "structured", jobType: "conversation" });
	fx.store.startAttempt("claude-job", { attemptId: "claude-attempt" });
	assert(fx.store.recoverInterruptedWork().length === 0 && fx.store.getJob("codex-job").lifecycle === "recovery_review" && fx.store.getJob("claude-job").lifecycle === "recovery_review", "recovery state was not quarantined");
	fx.store.close();
	const [{ SessionStore }] = await imports("store.mjs");
	const reopened = new SessionStore(fx.paths.databasePath);
	assert(reopened.listJobs().length === 2, "recovery identity was not durable");
	reopened.close();
}

async function probeStatus(input) {
	const fx = await fixture(input.challenge, input.phase === "current" ? "온맘" : null);
	fx.store.close();
	const [{ formatOperatorStatus }] = await imports("discord-delivery.mjs");
	assert(formatOperatorStatus({ service: { state: "running", reasonCode: "heartbeat_fresh" } }, []).includes("Foreign collaboration agent supervision: unsupported"), "operator status hid supervision boundary");
	const status = runCli(fx.root, ["status", "--json"]);
	assert(status.status === 0 && JSON.parse(status.stdout).foreignAgentSupervision === "unsupported", "real status CLI projection failed");
	if (input.phase === "current") await probeWatch(input, true);
}

async function probeCutover() {
	const [{ verifyCutoverSourceIdentity }] = await imports("service-cutover-controller.mjs");
	const revision = "a".repeat(40);
	const registrationState = { service: { enabled: false, active: false }, supervisorTimer: { enabled: false, active: false } };
	assert(verifyCutoverSourceIdentity({ sourceRevision: revision, registrationState, serviceUnit: "service-unit", expectedServiceUnit: "service-unit", supervisorServiceUnit: "supervisor-unit", expectedSupervisorServiceUnit: "supervisor-unit", supervisorTimerUnit: "timer-unit", expectedSupervisorTimerUnit: "timer-unit" }) === true, "managed cutover dry-run rejected exact source identity");
	let rejected = false;
	try { verifyCutoverSourceIdentity({ sourceRevision: revision, registrationState, serviceUnit: "wrong", expectedServiceUnit: "service-unit", supervisorServiceUnit: "supervisor-unit", expectedSupervisorServiceUnit: "supervisor-unit", supervisorTimerUnit: "timer-unit", expectedSupervisorTimerUnit: "timer-unit" }); } catch { rejected = true; }
	assert(rejected, "managed cutover accepted mismatched registration");
}

async function probeSurface(input) {
	const surface = SURFACES.find((candidate) => candidate.id === input.surface_id);
	assert(surface && /^[a-f0-9]{64}$/.test(input.challenge || "") && /^[a-f0-9]{64}$/.test(input.subject_digest || "") && ["baseline", "current"].includes(input.phase), "invalid preservation probe");
	if (surface.id === "cli-watch-default") await probeWatch(input, false);
	else if (surface.id === "cli-watch-verbose") await probeWatch(input, true);
	else if (surface.id === "stable-instance-job-identity") await probeIdentity(input);
	else if (surface.id === "safe-event-ledger") await probeSafeLedger(input);
	else if (surface.id === "provider-adapters") await probeProvider(input);
	else if (surface.id === "messenger-config-and-execution-revision") await probeConfig(input);
	else if (surface.id === "atomic-discord-ingress") await probeIngress(input);
	else if (surface.id === "durable-job-recovery") await probeRecovery(input);
	else if (surface.id === "discord-status-projection") await probeStatus(input);
	else if (surface.id === "managed-service-cutover") await probeCutover();
	return { challenge: input.challenge, subject_digest: input.subject_digest, phase: input.phase, surface_id: surface.id, entry_marker: surface.marker, reachable: true, capabilities: capabilities(surface, input.phase) };
}

function command(surfaceId, input) {
	const surface = SURFACES.find((candidate) => candidate.id === surfaceId);
	if (!surface || !/^[a-f0-9]{64}$/.test(input.challenge || "") || !/^[a-f0-9]{64}$/.test(input.subject_digest || "") || !["baseline", "current"].includes(input.phase)) throw new Error("invalid preservation command");
	return { executable: process.execPath, argv: ["/preservation/adapter.cjs", "probe"], cwd: "/subject", env: { TMPDIR: "/scratch" }, stdin: `${JSON.stringify({ challenge: input.challenge, subject_digest: input.subject_digest, phase: input.phase, surface_id: surfaceId })}\n`, timeout_ms: 120_000 };
}

function parse(surfaceId, input) {
	const surface = SURFACES.find((candidate) => candidate.id === surfaceId);
	const observation = input.observation || {};
	if (!surface || observation.status !== 0 || observation.signal || observation.error_code || observation.stderr !== "") return { reachable: false, capabilities: [], entry_marker: surface ? surface.marker : "unknown" };
	let result;
	try { result = JSON.parse(String(observation.stdout || "")); } catch { return { reachable: false, capabilities: [], entry_marker: surface.marker }; }
	const expectedCapabilities = capabilities(surface, input.phase);
	const valid = result.challenge === input.challenge && result.subject_digest === input.subject_digest && result.phase === input.phase && result.surface_id === surfaceId && result.entry_marker === surface.marker && result.reachable === true && JSON.stringify(result.capabilities) === JSON.stringify(expectedCapabilities);
	return { reachable: valid, capabilities: valid ? expectedCapabilities : [], entry_marker: surface.marker };
}

function response(action, input) {
	if (action === "roots") return { adapter_id: ADAPTER_ID, snapshot_roots: ROOTS };
	if (action === "discover") return { adapter_id: ADAPTER_ID, snapshot_roots: ROOTS, surfaces: SURFACES.map(({ id, kind, marker, baseline, current }) => ({ id, kind, marker, baseline_capabilities: baseline, current_capabilities: current })), operations: [] };
	if (action === "command") return command(input.surface_id, input);
	if (action === "parse") return parse(input.surface_id, input);
	throw new Error("unknown preservation adapter action");
}

async function main() {
	let input;
	try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { process.exit(2); }
	try {
		const result = process.argv[2] === "probe" ? await probeSurface(input) : response(process.argv[2], input);
		process.stdout.write(JSON.stringify(result));
	} catch (error) { process.stderr.write(error.message); process.exit(3); }
}

if (require.main === module) main();
module.exports = { ADAPTER_ID, ROOTS, SURFACES, capabilities, command, parse, probeSurface, response };
