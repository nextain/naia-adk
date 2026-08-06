import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../helper/store.mjs";
import { inspectCutoverRuntimeTree } from "../helper/service-manager.mjs";
import { messengerInstancePaths } from "../helper/instance-paths.mjs";
import { loadMessengerConfig } from "../helper/discord-config.mjs";
import { assertOwnerOnly, protectOwnerOnly } from "../helper/platform-security.mjs";
import { spawnSync } from "node:child_process";
import { currentExecutionProfile, discordBindingIdentity, durableExecutionBinding, effectiveAllowedActions, participantAuthorityRevision } from "../helper/execution-profile.mjs";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { createCutoverRollbackBundle, evaluateCutoverCanary, restoreCutoverRollbackBundle, verifyCutoverController, verifyCutoverRollbackBundle } from "../helper/cutover-bundle.mjs";
import { fileURLToPath } from "node:url";
import { BOT, CHANNEL, TOKEN_FINGERPRINT, USER, binding, cleanupDiscordFixtureRoots, fixture, roots } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

test("DSG-021 creates and restores a verified code, config, unit, and database-compatible rollback bundle", () => {
	const { root, store } = fixture();
	store.close();
	const paths = messengerInstancePaths(root);
	const sourceSkill = fileURLToPath(new URL("../", import.meta.url));
	const targetSkill = join(root, ".agents/skills/manage-discord-sessions");
	mkdirSync(join(root, ".agents/skills"), { recursive: true });
	cpSync(sourceSkill, targetSkill, { recursive: true });
	writeFileSync(join(targetSkill, "runtime-version.txt"), "prior-runtime\n", "utf8");
	for (const args of [
		["init", "-q"],
		["add", ".agents/skills/manage-discord-sessions"],
		["-c", "user.name=Naia Test", "-c", "user.email=naia@example.invalid", "commit", "-qm", "rollback source"],
	]) {
		const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	const sourceRevision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	const sourceRuntimeTreeId = inspectCutoverRuntimeTree(root, sourceRevision);
	// The rollback bundle must materialize the committed source, never mutable live bytes.
	writeFileSync(join(targetSkill, "runtime-version.txt"), "dirty-live-runtime\n", "utf8");
	const candidateRoot = mkdtempSync(join(tmpdir(), "naia-cutover-canary-candidate-"));
	roots.push(candidateRoot);
	const candidateSkill = join(candidateRoot, ".agents/skills/manage-discord-sessions");
	mkdirSync(candidateSkill, { recursive: true });
	writeFileSync(join(candidateSkill, "runtime-version.txt"), "candidate-runtime\n", "utf8");
	for (const args of [
		["init", "-q"],
		["add", ".agents/skills/manage-discord-sessions"],
		["-c", "user.name=Naia Test", "-c", "user.email=naia@example.invalid", "commit", "-qm", "candidate"],
	]) {
		const result = spawnSync("git", ["-C", candidateRoot, ...args], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	const candidateRevision = spawnSync("git", ["-C", candidateRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	const candidateRuntimeTreeId = inspectCutoverRuntimeTree(candidateRoot, candidateRevision);
	mkdirSync(join(root, "naia-settings/messenger-sessions"), { recursive: true, mode: 0o700 });
	const rollbackConfig = {
		schemaVersion: 1, enabled: true, workspaceId: "rollback-test",
		persona: { name: "Rollback reader", instructions: "Stay read-only." },
		role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: { credentialRef: "discord-token", botUserId: BOT, operatorUserIds: [USER], bindings: [{ ...binding(), historyVisibility: "none", operatorActions: false }] },
		runtime: { softSilenceSeconds: 120, noProgressInterventionSeconds: 120, approvalPolicy: "never", permissionProfileEpoch: "rollback-v1", maxConcurrentJobs: 1 },
		service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: false },
	};
	writeFileSync(paths.configPath, `${JSON.stringify(rollbackConfig)}\n`, { mode: 0o600 });
	protectOwnerOnly(paths.configPath, "file", "test messenger config");
	const sourceConfigText = readFileSync(paths.configPath, "utf8");
	const cutoverAt = new Date("2026-08-03T00:00:00.000Z");
	const registrationState = { service: { enabled: true, active: true }, supervisorTimer: { enabled: true, active: false } };
	const verifySourceSnapshot = () => {
		assertOwnerOnly(paths.configPath, "file", "test messenger config");
		if (readFileSync(paths.configPath, "utf8") !== sourceConfigText) throw new Error("source config changed during prepare");
		return true;
	};
	const bundleInput = { adkRoot: root, backendExecutables: {}, tokenFingerprint: TOKEN_FINGERPRINT, sourceConfigText, verifySourceSnapshot, sourceRevision, sourceRuntimeTreeId, candidateRevision, candidateRuntimeTreeId, registrationState, now: cutoverAt };
	assert.throws(() => createCutoverRollbackBundle({ ...bundleInput, registrationState: { ...registrationState, extra: true } }), /registration state is invalid/);
	if (process.platform !== "win32") {
		chmodSync(paths.configPath, 0o644);
		assert.throws(() => createCutoverRollbackBundle(bundleInput), /owner-only/);
		protectOwnerOnly(paths.configPath, "file", "test messenger config");
	}
	assert.throws(() => createCutoverRollbackBundle({ ...bundleInput, sourceRuntimeTreeId: "b".repeat(40) }), /tree ID does not match/);
	assert.throws(() => createCutoverRollbackBundle({
		...bundleInput,
		verifySourceSnapshot: () => {
			writeFileSync(paths.configPath, `${JSON.stringify({ ...rollbackConfig, backend: { selected: "claude", profiles: rollbackConfig.backend.profiles } })}\n`, { mode: 0o600 });
			throw new Error("source config changed during prepare");
		},
	}), /source config changed during prepare/);
	assert.equal(existsSync(paths.activeRollbackPath), false);
	writeFileSync(paths.configPath, sourceConfigText, { mode: 0o600 });
	protectOwnerOnly(paths.configPath, "file", "test messenger config");
	const bundle = createCutoverRollbackBundle(bundleInput);
	assert.equal(bundle.manifest.configSchemaVersion, 1);
	assert.equal(bundle.manifest.database.policy, "preserve");
	assert.equal(bundle.manifest.sourceRevision, sourceRevision);
	assert.equal(bundle.manifest.sourceRuntimeTreeId, sourceRuntimeTreeId);
	assert.equal(bundle.manifest.candidateRevision, candidateRevision);
	assert.equal(bundle.manifest.candidateRuntimeTreeId, candidateRuntimeTreeId);
	assert.deepEqual(bundle.manifest.registrationState, registrationState);
	assert.equal(bundle.manifest.canaryStopCriteria.includes("approval_ui_detected"), true);
	assert.match(
		readFileSync(bundle.units.service, "utf8").replaceAll("\\\\", "/"),
		/rollback-bundles.*runtime\/manage-discord-sessions\/helper\/service\.mjs/,
	);
	assert.equal(readFileSync(join(bundle.runtimePath, "runtime-version.txt"), "utf8"), "prior-runtime\n");
	assert.equal(verifyCutoverRollbackBundle(bundle.bundleDirectory).manifest.bundleId, bundle.manifest.bundleId);
	assert.equal(verifyCutoverController(bundle, candidateRoot).manifest.bundleId, bundle.manifest.bundleId);
	const legacyServicePath = join(targetSkill, "helper/service.mjs");
	const managedServiceSource = readFileSync(legacyServicePath, "utf8");
	assert.match(managedServiceSource, /--managed-preflight/);
	writeFileSync(join(targetSkill, "runtime-version.txt"), "prior-runtime\n", "utf8");
	writeFileSync(legacyServicePath, managedServiceSource.replaceAll("--managed-preflight", "--legacy-preflight-unavailable"), "utf8");
	for (const args of [
		["add", ".agents/skills/manage-discord-sessions/helper/service.mjs"],
		["-c", "user.name=Naia Test", "-c", "user.email=naia@example.invalid", "commit", "-qm", "legacy rollback source"],
	]) {
		const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	const legacySourceRevision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	const legacySourceRuntimeTreeId = inspectCutoverRuntimeTree(root, legacySourceRevision);
	const legacyBundle = createCutoverRollbackBundle({
		...bundleInput,
		now: new Date("2026-08-03T00:00:30.000Z"),
		sourceRevision: legacySourceRevision,
		sourceRuntimeTreeId: legacySourceRuntimeTreeId,
		sourceRegistration: {
			kind: "legacy_mutable",
			unitSha256: { service: "a".repeat(64), supervisorService: "b".repeat(64), supervisorTimer: "c".repeat(64) },
		},
	});
	const legacyServiceUnit = readFileSync(legacyBundle.units.service, "utf8");
	const legacySupervisorUnit = readFileSync(legacyBundle.units.supervisorService, "utf8");
	assert.match(legacyServiceUnit.replaceAll("\\\\", "/"), /rollback-bundles.*runtime\/manage-discord-sessions\/helper\/service\.mjs/);
	assert.match(legacySupervisorUnit.replaceAll("\\\\", "/"), /rollback-bundles.*runtime\/manage-discord-sessions\/helper\/supervisor\.mjs/);
	assert.doesNotMatch(legacyServiceUnit, /--managed-preflight|NAIA_DISCORD_RUNTIME_ARTIFACT|NAIA_DISCORD_LAUNCH_MODE/);
	assert.match(legacyServiceUnit, /naia-discord-token-/);
	assert.equal(legacyBundle.manifest.units.mode, "legacy_compat");
	assert.equal(verifyCutoverRollbackBundle(legacyBundle.bundleDirectory).manifest.sourceRegistration.kind, "legacy_mutable");
	const legacyRestoreCalls = [];
	restoreCutoverRollbackBundle({
		adkRoot: root,
		stopService: () => legacyRestoreCalls.push("stop"),
		installUnits: ({ content }) => {
			legacyRestoreCalls.push("install");
			assert.equal(content.service, legacyServiceUnit);
			assert.equal(content.supervisorService, legacySupervisorUnit);
		},
		startService: (_names, restoredRegistrationState) => {
			legacyRestoreCalls.push("start");
			assert.deepEqual(restoredRegistrationState, registrationState);
		},
	});
	assert.deepEqual(legacyRestoreCalls, ["stop", "install", "start"]);
	writeFileSync(paths.activeRollbackPath, `${JSON.stringify({ schemaVersion: 1, bundleId: bundle.manifest.bundleId })}\n`, { mode: 0o600 });
	if (process.platform !== "win32") {
		chmodSync(paths.activeRollbackPath, 0o644);
		assert.throws(() => restoreCutoverRollbackBundle({ adkRoot: root, stopService: () => assert.fail("stop must not run"), installUnits: () => assert.fail("install must not run"), startService: () => assert.fail("start must not run") }), /owner-only/);
		protectOwnerOnly(paths.activeRollbackPath, "file", "test rollback pointer");
		chmodSync(bundle.runtimePath, 0o755);
		assert.throws(() => verifyCutoverRollbackBundle(bundle.bundleDirectory), /owner-only/);
		protectOwnerOnly(bundle.runtimePath, "directory", "test rollback runtime");
		chmodSync(join(bundle.bundleDirectory, "manifest.json"), 0o644);
		assert.throws(() => verifyCutoverRollbackBundle(bundle.bundleDirectory), /owner-only/);
		protectOwnerOnly(join(bundle.bundleDirectory, "manifest.json"), "file", "test rollback manifest");
	}
	const manifestPath = join(bundle.bundleDirectory, "manifest.json");
	const originalManifest = readFileSync(manifestPath);
	const unsafeManifest = JSON.parse(originalManifest.toString("utf8"));
	unsafeManifest.units.serviceName = "../../escape.service";
	writeFileSync(manifestPath, `${JSON.stringify(unsafeManifest, null, 2)}\n`, { mode: 0o600 });
	assert.throws(() => verifyCutoverRollbackBundle(bundle.bundleDirectory), /manifest is invalid/);
	writeFileSync(manifestPath, originalManifest, { mode: 0o600 });
	const schemaMismatchManifest = JSON.parse(originalManifest.toString("utf8"));
	schemaMismatchManifest.configSchemaVersion = 2;
	writeFileSync(manifestPath, `${JSON.stringify(schemaMismatchManifest, null, 2)}\n`, { mode: 0o600 });
	assert.throws(() => verifyCutoverRollbackBundle(bundle.bundleDirectory), /config schema version mismatch/);
	writeFileSync(manifestPath, originalManifest, { mode: 0o600 });
	writeFileSync(paths.configPath, `${JSON.stringify({ schemaVersion: 2 })}\n`, { mode: 0o600 });
	assert.throws(() => restoreCutoverRollbackBundle({ adkRoot: root, stopService: () => { throw new Error("stop failed"); }, installUnits: () => assert.fail("install must not run"), startService: () => assert.fail("start must not run") }), /stop failed/);
	assert.equal(JSON.parse(readFileSync(paths.configPath, "utf8")).schemaVersion, 2);
	assert.throws(() => restoreCutoverRollbackBundle({ adkRoot: root, stopService: () => {}, installUnits: () => { throw new Error("install failed"); }, startService: () => assert.fail("start must not run") }), /install failed/);
	assert.equal(JSON.parse(readFileSync(paths.configPath, "utf8")).schemaVersion, 1);
	writeFileSync(paths.configPath, `${JSON.stringify({ schemaVersion: 2 })}\n`, { mode: 0o600 });
	assert.throws(() => restoreCutoverRollbackBundle({ adkRoot: root, stopService: () => {}, installUnits: () => {}, startService: () => { throw new Error("start failed"); } }), /start failed/);
	writeFileSync(paths.configPath, `${JSON.stringify({ schemaVersion: 2 })}\n`, { mode: 0o600 });
	const calls = [];
	const restored = restoreCutoverRollbackBundle({
		adkRoot: root,
		stopService: () => calls.push("stop"),
		installUnits: ({ content }) => { calls.push("install"); assert.match(content.service, /rollback-bundles/); },
		startService: (_names, restoredRegistrationState) => { calls.push("start"); assert.deepEqual(restoredRegistrationState, registrationState); },
	});
	assert.deepEqual(calls, ["stop", "install", "start"]);
	assert.equal(JSON.parse(readFileSync(paths.configPath, "utf8")).schemaVersion, 1);
	assert.equal(restored.sourceRevision, sourceRevision);
	assert.equal(restored.sourceRuntimeTreeId, sourceRuntimeTreeId);
	// Model the actual deployment: both the candidate checkout and target HEAD/tree
	// must now resolve to the candidate identity bound by the rollback manifest.
	for (const args of [
		["fetch", "-q", candidateRoot, candidateRevision],
		["checkout", "-q", "--detach", "-f", candidateRevision],
	]) {
		const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	writeFileSync(join(root, "AGENTS.md"), "# Canary agent\nUse only the bounded test context.\n", "utf8");
	mkdirSync(join(root, ".agents/context"), { recursive: true });
	writeFileSync(join(root, ".agents/context/canary.yaml"), "authority: read-only\n", "utf8");
	const canaryConfigRaw = {
		schemaVersion: 2, enabled: true, workspaceId: "canary-test",
		workspace: { path: ".", agentId: "canary-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/canary.yaml"] },
		persona: { name: "Canary reader", instructions: "Stay read-only." },
		role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: { credentialRef: "discord-token", botUserId: BOT, operatorUserIds: [USER], participantProfiles: { [USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply"] } }, bindings: [{ ...binding(), historyVisibility: "none", operatorActions: false }] },
		runtime: { softSilenceSeconds: 120, noProgressInterventionSeconds: 120, approvalPolicy: "never", permissionProfileEpoch: "canary-v1", maxConcurrentJobs: 1 },
		service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: false },
	};
	writeFileSync(paths.configPath, `${JSON.stringify(canaryConfigRaw)}\n`, { mode: 0o600 });
	const canaryConfig = loadMessengerConfig(paths.configPath);
	const canarySnapshot = buildAgentContextSnapshot({ workspace: root, agentId: canaryConfig.workspace.agentId, entrypoint: canaryConfig.workspace.entrypoint, contextFiles: canaryConfig.workspace.contextFiles });
	const canaryBinding = canaryConfig.discord.bindings[0];
	const canaryParticipantProfile = canaryConfig.discord.participantProfiles[USER];
	const canaryEffectiveActions = effectiveAllowedActions(canaryConfig, { binding: canaryBinding, participantProfile: canaryParticipantProfile, isOperator: false });
	const canaryAuthorityRevision = participantAuthorityRevision({ workspaceIdentity: `${canarySnapshot.agentId}\0${canarySnapshot.workspaceRoot}`, bindingIdentity: discordBindingIdentity(canaryBinding), participantUserId: USER, participantProfile: canaryParticipantProfile, effectiveActions: canaryEffectiveActions, permissionProfileEpoch: canaryConfig.runtime.permissionProfileEpoch });
	const canaryExecutionProfile = currentExecutionProfile(canaryConfig, "codex", { binding: canaryBinding, participantProfile: canaryParticipantProfile, isOperator: false, authorityRevision: canaryAuthorityRevision, contextHash: canarySnapshot.contextHash });
	const canaryExecutionBinding = durableExecutionBinding({ config: canaryConfig, instance: paths.instance, agentContextSnapshot: canarySnapshot, participantUserId: USER, binding: canaryBinding, executionProfile: canaryExecutionProfile });
	const canaryServiceGeneration = `${candidateRevision}.cafebabe`;
	const healthySupervisor = (observedAt = "2026-08-03T00:00:10.000Z", serviceGeneration = canaryServiceGeneration) => ({
		schemaVersion: 1,
		state: "healthy",
		observedAt,
		foreignAgentSupervision: "unsupported",
		gatewayEvidence: "heartbeat_ack",
		serviceGeneration,
		serviceRuntimeRevision: candidateRevision,
		unhealthy: [],
		attention: [],
		startupFailureReasonCode: null,
	});
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify(healthySupervisor())}\n`, { mode: 0o600 });
	const canaryStore = new SessionStore(paths.databasePath);
	canaryStore.heartbeatService({ generation: canaryServiceGeneration, pid: process.pid, now: "2026-08-03T00:00:00.500Z" });
	canaryStore.createJob({ jobId: "rollback-canary-job", backendId: "codex", revision: `v2r:${candidateRevision}`, activityDetail: "structured", jobType: "conversation", now: "2026-08-03T00:00:01.000Z" });
	canaryStore.recordEvent({ jobId: "rollback-canary-job", source: "helper", kind: "operator_response_missed", safePayload: {} });
	canaryStore.recordEvent({ jobId: "rollback-canary-job", source: "helper", kind: "failed", safePayload: { reasonCode: "approval_ui_detected" } });
	canaryStore.acceptIngressAndCreateJob({ sourceMessageId: "333333333333333333", scopeKey: "canary-scope", jobId: "successful-canary-job", backendId: "codex", revision: `v2r:${candidateRevision}`, activityDetail: "structured", jobType: "conversation", executionBinding: canaryExecutionBinding, now: "2026-08-03T00:00:02.000Z" });
	const canaryAttemptId = canaryStore.startAttempt("successful-canary-job", { attemptId: "successful-canary-attempt", now: "2026-08-03T00:00:03.000Z" });
	canaryStore.recordEvent({ jobId: "successful-canary-job", attemptId: canaryAttemptId, source: "helper", kind: "attempt_exited", occurredAt: "2026-08-03T00:00:04.000Z", safePayload: { terminationKind: "exited", exitCode: 0 } });
	canaryStore.recordEvent({ jobId: "successful-canary-job", attemptId: canaryAttemptId, source: "helper", kind: "attempt_succeeded", occurredAt: "2026-08-03T00:00:05.000Z", safePayload: {} });
	canaryStore.recordEvent({ jobId: "successful-canary-job", attemptId: canaryAttemptId, source: "helper", kind: "operator_response_sent", occurredAt: "2026-08-03T00:00:06.000Z", safePayload: {} });
	canaryStore.reserveDelivery({ deliveryKey: "successful-canary-delivery", jobId: "successful-canary-job", attemptId: canaryAttemptId, nonce: "successful-canary-nonce", channelId: CHANNEL, now: "2026-08-03T00:00:07.000Z" });
	canaryStore.finishDelivery({ deliveryKey: "successful-canary-delivery", status: "confirmed", messageId: BOT, now: "2026-08-03T00:00:08.000Z" });
	canaryStore.heartbeatService({ generation: canaryServiceGeneration, pid: process.pid, now: "2026-08-03T00:00:09.000Z" });
	canaryStore.close();
	const canary = evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "rollback-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") });
	assert.equal(canary.verdict, "stop");
	assert.equal(canary.reasons.includes("canary_execution_binding_invalid"), true);
	assert.equal(canary.reasons.includes("canary_admission_invalid"), true);
	for (const reason of ["approval_ui_detected", "canary_failure_or_recovery_event", "canary_job_incomplete", "delivery_unconfirmed", "operator_response_invalid", "operator_response_missed"]) assert.equal(canary.reasons.includes(reason), true);
	const successfulCanary = evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") });
	assert.deepEqual(successfulCanary, { schemaVersion: 1, bundleId: bundle.manifest.bundleId, jobId: "successful-canary-job", verdict: "continue", reasons: [] });
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify({ ...healthySupervisor(), state: "attention", attention: [{ code: "historical_attention", recoveryReview: 2, deliveryIssues: 1 }] })}\n`, { mode: 0o600 });
	assert.deepEqual(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons, []);
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify(healthySupervisor())}\n`, { mode: 0o600 });
	assert.deepEqual(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z"), registrationVerifier: () => { throw new Error("timer disabled or unit stale"); } }).reasons, ["managed_registration_invalid"]);
	const restartedGeneration = `${candidateRevision}.deadbeef`;
	const restartedDatabase = new DatabaseSync(paths.databasePath);
	restartedDatabase.prepare("UPDATE service_state SET generation = ? WHERE id = 1").run(restartedGeneration);
	restartedDatabase.close();
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify(healthySupervisor("2026-08-03T00:00:10.000Z", restartedGeneration))}\n`, { mode: 0o600 });
	assert.equal(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons.includes("service_runtime_not_current"), true);
	const originalGenerationDatabase = new DatabaseSync(paths.databasePath);
	originalGenerationDatabase.prepare("UPDATE service_state SET generation = ? WHERE id = 1").run(canaryServiceGeneration);
	originalGenerationDatabase.close();
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify(healthySupervisor())}\n`, { mode: 0o600 });
	const stoppedCandidateDatabase = new DatabaseSync(paths.databasePath);
	stoppedCandidateDatabase.prepare("UPDATE service_state SET pid = ? WHERE id = 1").run(2_147_483_647);
	stoppedCandidateDatabase.close();
	assert.equal(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons.includes("service_runtime_not_current"), true);
	const restoredCandidateDatabase = new DatabaseSync(paths.databasePath);
	restoredCandidateDatabase.prepare("UPDATE service_state SET pid = ? WHERE id = 1").run(process.pid);
	restoredCandidateDatabase.close();
	assert.deepEqual(evaluateCutoverCanary({ adkRoot: root, candidateRoot: root, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons, ["candidate_runtime_mismatch"]);
	const canaryDatabase = new DatabaseSync(paths.databasePath);
	canaryDatabase.prepare("UPDATE jobs SET revision = 'discord-v1' WHERE job_id = 'successful-canary-job'").run();
	canaryDatabase.close();
	assert.equal(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons.includes("canary_job_not_after_cutover"), true);
	const restoredCanaryDatabase = new DatabaseSync(paths.databasePath);
	restoredCanaryDatabase.prepare("UPDATE jobs SET revision = ? WHERE job_id = 'successful-canary-job'").run(`v2r:${candidateRevision}`);
	restoredCanaryDatabase.close();
	rmSync(paths.supervisorStatusPath);
	assert.deepEqual(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons, ["supervisor_state_missing"]);
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify(healthySupervisor("2026-08-02T23:59:59.000Z"))}\n`, { mode: 0o600 });
	assert.deepEqual(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons, ["supervisor_state_stale"]);
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify(healthySupervisor("2026-08-03T00:00:01.500Z"))}\n`, { mode: 0o600 });
	assert.deepEqual(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons, ["supervisor_state_stale"]);
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify(healthySupervisor("2026-08-03T00:00:06.500Z"))}\n`, { mode: 0o600 });
	assert.deepEqual(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons, ["supervisor_state_stale"]);
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify(healthySupervisor())}\n`, { mode: 0o600 });
	if (process.platform !== "win32") {
		chmodSync(paths.supervisorStatusPath, 0o644);
		assert.equal(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons.includes("supervisor_state_invalid"), true);
		protectOwnerOnly(paths.supervisorStatusPath, "file", "test supervisor snapshot");
	}
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify({ ...healthySupervisor(), state: "unhealthy", unhealthy: [{ reasonCode: "startup_or_runtime_failure" }] })}\n`, { mode: 0o600 });
	assert.equal(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons.includes("supervisor_unhealthy"), true);
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify(healthySupervisor())}\n`, { mode: 0o600 });
	writeFileSync(join(targetSkill, "uncommitted-target.txt"), "deployment drift\n", "utf8");
	assert.deepEqual(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons, ["candidate_runtime_mismatch"]);
	rmSync(join(targetSkill, "uncommitted-target.txt"));
	writeFileSync(join(candidateSkill, "uncommitted.txt"), "candidate drift\n", "utf8");
	assert.deepEqual(evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") }).reasons, ["candidate_runtime_mismatch"]);
	rmSync(join(candidateSkill, "uncommitted.txt"));
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify({ ...healthySupervisor(), startupFailureReasonCode: "token=SHOULD_NOT_PROJECT" })}\n`, { mode: 0o600 });
	const invalidCanary = evaluateCutoverCanary({ adkRoot: root, candidateRoot, jobId: "successful-canary-job", nowMs: Date.parse("2026-08-03T00:00:10.000Z") });
	assert.equal(invalidCanary.reasons.includes("failure_status_invalid"), true);
	assert.equal(JSON.stringify(invalidCanary).includes("SHOULD_NOT_PROJECT"), false);
	writeFileSync(paths.supervisorStatusPath, `${JSON.stringify(healthySupervisor())}\n`, { mode: 0o600 });
	const activeStore = new SessionStore(paths.databasePath);
	activeStore.createJob({ jobId: "rollback-active-job", backendId: "codex", revision: "discord-v2-read-only", activityDetail: "structured", jobType: "conversation" });
	activeStore.close();
	const blockedCalls = [];
	assert.throws(() => restoreCutoverRollbackBundle({ adkRoot: root, stopService: () => blockedCalls.push("stop"), installUnits: () => blockedCalls.push("install"), startService: () => blockedCalls.push("start") }), /idle ledger/);
	assert.deepEqual(blockedCalls, []);
	const terminalStore = new SessionStore(paths.databasePath);
	terminalStore.recordEvent({ jobId: "rollback-active-job", source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
	terminalStore.close();
	const raceCalls = [];
	assert.throws(() => restoreCutoverRollbackBundle({
		adkRoot: root,
		stopService: () => {
			raceCalls.push("stop");
			const raceStore = new SessionStore(paths.databasePath);
			raceStore.createJob({ jobId: "rollback-race-job", backendId: "codex", revision: "discord-v2-read-only", activityDetail: "structured", jobType: "conversation" });
			raceStore.close();
		},
		installUnits: () => raceCalls.push("install"),
		startService: () => raceCalls.push("start"),
	}), /idle ledger/);
	assert.deepEqual(raceCalls, ["stop"]);
	const raceTerminalStore = new SessionStore(paths.databasePath);
	raceTerminalStore.recordEvent({ jobId: "rollback-race-job", source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
	raceTerminalStore.close();
	const installRaceCalls = [];
	assert.throws(() => restoreCutoverRollbackBundle({
		adkRoot: root,
		stopService: () => installRaceCalls.push("stop"),
		installUnits: () => {
			installRaceCalls.push("install");
			const raceStore = new SessionStore(paths.databasePath);
			raceStore.createJob({ jobId: "rollback-install-race-job", backendId: "codex", revision: "discord-v2-read-only", activityDetail: "structured", jobType: "conversation" });
			raceStore.close();
		},
		startService: () => installRaceCalls.push("start"),
	}), /idle ledger/);
	assert.deepEqual(installRaceCalls, ["stop", "install"]);
	const installRaceTerminalStore = new SessionStore(paths.databasePath);
	installRaceTerminalStore.recordEvent({ jobId: "rollback-install-race-job", source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
	installRaceTerminalStore.close();
	const runtimeMarker = join(bundle.runtimePath, "runtime-version.txt");
	const originalRuntimeMarker = readFileSync(runtimeMarker);
	writeFileSync(runtimeMarker, "tampered\n", { mode: 0o600 });
	assert.throws(() => verifyCutoverRollbackBundle(bundle.bundleDirectory), /runtime digest mismatch/);
	writeFileSync(runtimeMarker, originalRuntimeMarker, { mode: 0o600 });
	for (const unitPath of Object.values(bundle.units)) {
		const originalUnit = readFileSync(unitPath);
		writeFileSync(unitPath, "tampered\n", { mode: 0o600 });
		assert.throws(() => verifyCutoverRollbackBundle(bundle.bundleDirectory), /unit digest mismatch/);
		writeFileSync(unitPath, originalUnit, { mode: 0o600 });
	}
	const database = new DatabaseSync(paths.databasePath);
	database.prepare("UPDATE metadata SET value = '999' WHERE key = 'schema_version'").run();
	database.close();
	assert.throws(() => createCutoverRollbackBundle({ ...bundleInput, now: new Date("2026-08-03T00:01:00.000Z") }), /cannot open the current Discord database schema/);
	writeFileSync(bundle.configPath, "{}\n", { mode: 0o600 });
	assert.throws(() => verifyCutoverRollbackBundle(bundle.bundleDirectory), /config digest mismatch/);
});
