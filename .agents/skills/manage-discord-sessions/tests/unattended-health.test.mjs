import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gatewayEvidenceBoundSeconds, projectUnattendedHealth } from "../helper/unattended-health.mjs";
import { observeOnce } from "../helper/supervisor.mjs";
import { messengerInstancePaths } from "../helper/instance-paths.mjs";
import { SessionStore } from "../helper/store.mjs";
import { renderDiscordSupervisorUnits } from "../helper/systemd.mjs";
import { installSupervisedPair, verifyWindowsTaskAction, verifyWindowsTaskDisabled } from "../helper/service-manager.mjs";

const roots = [];
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const iso = (ms) => new Date(ms).toISOString();
const baseStatus = (state = "running") => ({ schemaVersion: 1, service: { state, reasonCode: `service_${state}` }, gateway: { lastHeartbeatAckAt: iso(9_000) } });
const job = (patch = {}) => ({ jobId: "job-1", lifecycle: "running", acceptedAt: iso(1_000), startedAt: iso(2_000), updatedAt: iso(9_500), lastProgressAt: iso(9_500), childState: { state: "owned" }, deliveryState: "not_started", ...patch });

test("DSO-009 health distinguishes current progress, queue silence, child loss, clock uncertainty, and history attention", () => {
	assert.equal(projectUnattendedHealth({ status: baseStatus(), jobs: [job()], nowMs: 10_000, noProgressInterventionSeconds: 2 }).state, "healthy");
	assert.equal(projectUnattendedHealth({ status: { ...baseStatus(), gateway: { lastHeartbeatAckAt: null } }, jobs: [job()], nowMs: 10_000, noProgressInterventionSeconds: 2 }).state, "attention");
	assert.ok(projectUnattendedHealth({ status: baseStatus(), jobs: [job({ lifecycle: "queued", acceptedAt: iso(1_000), childState: { state: "not_expected" } })], nowMs: 10_000, noProgressInterventionSeconds: 2 }).unhealthy.some((item) => item.code === "active_work_overdue"));
	assert.ok(projectUnattendedHealth({ status: baseStatus(), jobs: [job({ lastProgressAt: iso(1_000) })], nowMs: 10_000, noProgressInterventionSeconds: 2 }).unhealthy.some((item) => item.code === "active_work_overdue"));
	assert.ok(projectUnattendedHealth({ status: baseStatus(), jobs: [job({ childState: { state: "missing" } })], nowMs: 10_000, noProgressInterventionSeconds: 2 }).unhealthy.some((item) => item.code === "owned_child_missing"));
	assert.ok(projectUnattendedHealth({ status: baseStatus(), jobs: [job({ childState: { state: "conflict" } })], nowMs: 10_000, noProgressInterventionSeconds: 2 }).unhealthy.some((item) => item.code === "owned_child_conflict"));
	for (const childState of ["unknown", "not_expected"]) assert.ok(projectUnattendedHealth({ status: baseStatus(), jobs: [job({ childState: { state: childState } })], nowMs: 10_000, noProgressInterventionSeconds: 2 }).attention.some((item) => item.code === "owned_child_evidence_unknown"));
	assert.ok(projectUnattendedHealth({ status: baseStatus(), jobs: [job({ lifecycle: "waiting_approval" })], nowMs: 10_000, noProgressInterventionSeconds: 2 }).unhealthy.some((item) => item.code === "approval_wait_forbidden"));
	for (const lifecycle of ["retry_wait", "result_ready", "delivering"]) {
		const waiting = projectUnattendedHealth({ status: baseStatus(), jobs: [job({ lifecycle, lastProgressAt: iso(1_000), childState: { state: "not_expected" } })], nowMs: 10_000, noProgressInterventionSeconds: 2 });
		assert.equal(waiting.state, "attention");
		assert.equal(waiting.unhealthy.length, 0);
		assert.ok(projectUnattendedHealth({ status: baseStatus(), jobs: [job({ lifecycle, updatedAt: iso(1_000), childState: { state: "not_expected" } })], nowMs: 10_000, noProgressInterventionSeconds: 2 }).unhealthy.some((item) => item.code === "active_work_overdue"));
	}
	assert.ok(projectUnattendedHealth({ status: baseStatus(), jobs: [job({ lastProgressAt: iso(20_000) })], nowMs: 10_000, noProgressInterventionSeconds: 2 }).attention.some((item) => item.code === "work_clock_evidence_unknown"));
	const historical = projectUnattendedHealth({ status: baseStatus(), jobs: [job({ lifecycle: "recovery_review", deliveryState: "unknown" })], nowMs: 10_000, noProgressInterventionSeconds: 2 });
	assert.equal(historical.state, "attention");
	assert.equal(historical.unhealthy.length, 0);
	assert.equal(historical.foreignAgentSupervision, "unsupported");
});

test("DSO-009 stale Gateway acknowledgement remains attention instead of inferred health", () => {
	const health = projectUnattendedHealth({ status: { ...baseStatus(), gateway: { lastHeartbeatAckAt: iso(1_000) } }, jobs: [], nowMs: 400_000, noProgressInterventionSeconds: 3_600, gatewayEvidenceStaleSeconds: 180 });
	assert.equal(health.state, "attention");
	assert.equal(health.gatewayEvidence, "stale");
});

test("DSO-009 Gateway evidence bound is derived independently from heartbeat policy", () => {
	assert.equal(gatewayEvidenceBoundSeconds(10), 120);
	assert.equal(gatewayEvidenceBoundSeconds(60), 180);
	assert.throws(() => gatewayEvidenceBoundSeconds(0), /heartbeatSeconds/);
});

test("DSO-009 stopped or stale service is unhealthy independently of a model turn", () => {
	for (const state of ["stopped", "stale"]) assert.equal(projectUnattendedHealth({ status: baseStatus(state), jobs: [], nowMs: 10_000 }).state, "unhealthy");
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-supervisor-"));
	roots.push(root);
	const paths = messengerInstancePaths(root);
	mkdirSync(join(root, "naia-settings/messenger-sessions"), { recursive: true, mode: 0o700 });
	const config = { schemaVersion: 1, enabled: true, workspaceId: "test", persona: { name: "Observer", instructions: "Observe safely." }, role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: [] }, backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: false } } }, discord: { credentialRef: "token", botUserId: "111111111111111111", operatorUserIds: [], bindings: [{ kind: "dm", userId: "222222222222222222", respondWhen: "always", allowedUserIds: ["222222222222222222"], canStartConversation: true, operatorActions: true }] }, runtime: { heartbeatSeconds: 10, softSilenceSeconds: 2, noProgressInterventionSeconds: 2, operatorResponseSeconds: 1, approvalPolicy: "never", permissionProfileEpoch: "test", maxConcurrentJobs: 1, conversationCoordinator: false }, observability: { discordStatusProjection: false }, service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: true } };
	writeFileSync(paths.configPath, JSON.stringify(config), { mode: 0o600 });
	chmodSync(paths.configPath, 0o600);
	return { root, paths };
}

function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

test("DSO-009 observer writes only its atomic snapshot and leaves the ledger bytes unchanged", () => {
	const { root, paths } = fixture();
	const store = new SessionStore(paths.databasePath);
	store.createJob({ jobId: "wal-job", backendId: "codex", activityDetail: "structured", jobType: "conversation" });
	const before = digest(paths.databasePath);
	const walBefore = existsSync(`${paths.databasePath}-wal`) ? digest(`${paths.databasePath}-wal`) : null;
	const eventCountBefore = store.eventsAfter({ afterOrdinal: 0 }).length;
	const first = observeOnce({ adkRoot: root, nowMs: 10_000 });
	const second = observeOnce({ adkRoot: root, nowMs: 70_000 });
	assert.equal(first.state, "unhealthy");
	assert.equal(second.observedAt, iso(70_000));
	assert.equal(JSON.parse(readFileSync(paths.supervisorStatusPath, "utf8")).foreignAgentSupervision, "unsupported");
	assert.equal(digest(paths.databasePath), before);
	if (walBefore !== null) assert.equal(digest(`${paths.databasePath}-wal`), walBefore);
	assert.equal(store.eventsAfter({ afterOrdinal: 0 }).length, eventCountBefore);
	assert.equal(store.getJob("wal-job").lifecycle, "queued");
	store.close();
});

test("DSO-009 systemd observer has a separate identity and a 60 second persistent timer", () => {
	const { root } = fixture();
	const rendered = renderDiscordSupervisorUnits({ adkRoot: root, nodePath: "/usr/bin/node" });
	assert.match(rendered.serviceName, /-supervisor\.service$/);
	assert.match(rendered.timerName, /-supervisor\.timer$/);
	assert.match(rendered.timerContent, /OnUnitActiveSec=60s/);
	assert.match(rendered.timerContent, /Persistent=true/);
	assert.match(rendered.serviceContent, /supervisor\.mjs/);
});

test("DSO-009 CLI reports an absent service as unhealthy without an interactive model", () => {
	const { root } = fixture();
	const cli = fileURLToPath(new URL("../helper/cli.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [cli, "health-check", "--json", "--adk-root", root], { encoding: "utf8" });
	assert.equal(result.status, 4);
	assert.equal(JSON.parse(result.stdout).state, "unhealthy");
});

test("DSO-009 independently scheduled payload refreshes a stopped-service snapshot on separate invocations", () => {
	const { root, paths } = fixture();
	const supervisor = fileURLToPath(new URL("../helper/supervisor.mjs", import.meta.url));
	const run = () => spawnSync(process.execPath, [supervisor, "--adk-root", root], { encoding: "utf8" });
	assert.equal(run().status, 4);
	const first = JSON.parse(readFileSync(paths.supervisorStatusPath, "utf8"));
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	assert.equal(run().status, 4);
	const second = JSON.parse(readFileSync(paths.supervisorStatusPath, "utf8"));
	assert.equal(first.state, "unhealthy");
	assert.equal(second.state, "unhealthy");
	assert.ok(Date.parse(second.observedAt) > Date.parse(first.observedAt));
});

test("DSO-009 observer honors the validated silence default when the explicit intervention bound is omitted", () => {
	const { root, paths } = fixture();
	const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
	delete config.runtime.noProgressInterventionSeconds;
	writeFileSync(paths.configPath, JSON.stringify(config), { mode: 0o600 });
	assert.equal(observeOnce({ adkRoot: root, nowMs: 10_000 }).state, "unhealthy");
});

test("DSO-009 Windows supervisor registration accepts only one limited minute trigger", () => {
	const launcher = "/tmp/supervisor-once.cmd";
	const xml = `<Task><Triggers><CalendarTrigger><StartBoundary>2026-08-03T00:00:00</StartBoundary><Repetition><Interval>PT1M</Interval></Repetition></CalendarTrigger></Triggers><Principals><Principal><UserId>S-1-5-21-test</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>${launcher}</Command></Exec></Actions></Task>`;
	assert.equal(verifyWindowsTaskAction(xml, launcher, "S-1-5-21-test", { schedule: "minute" }), true);
	assert.throws(() => verifyWindowsTaskAction(xml.replace("PT1M", "PT5M"), launcher, "S-1-5-21-test", { schedule: "minute" }), /one minute trigger/);
	assert.throws(() => verifyWindowsTaskAction(xml.replace("<Enabled>true", "<Enabled>false"), launcher, "S-1-5-21-test", { schedule: "minute" }), /must be enabled/);
	assert.equal(verifyWindowsTaskDisabled(xml.replace("<Enabled>true", "<Enabled>false")), true);
});

test("DSO-009 service installation verifies supervisor first and quarantines every partial failure", () => {
	const events = [];
	const installed = installSupervisedPair({ installSupervisor: () => { events.push("supervisor"); return "timer"; }, installService: (supervisor) => { events.push(`service:${supervisor}`); return "main"; }, quarantineService: () => events.push("quarantine") });
	assert.deepEqual(installed, { supervisor: "timer", service: "main" });
	assert.deepEqual(events, ["supervisor", "service:timer"]);
	events.length = 0;
	assert.throws(() => installSupervisedPair({ installSupervisor: () => { events.push("supervisor"); throw new Error("timer failed"); }, installService: () => events.push("service"), quarantineService: () => events.push("quarantine") }), /timer failed/);
	assert.deepEqual(events, ["supervisor", "quarantine"]);
	events.length = 0;
	assert.throws(() => installSupervisedPair({ installSupervisor: () => { events.push("supervisor"); return "timer"; }, installService: () => { events.push("service"); throw new Error("main failed"); }, quarantineService: () => events.push("quarantine") }), /main failed/);
	assert.deepEqual(events, ["supervisor", "service", "quarantine"]);
	events.length = 0;
	assert.throws(() => installSupervisedPair({ installSupervisor: () => { throw new Error("timer failed"); }, installService: () => {}, quarantineService: () => { events.push("quarantine"); throw new Error("disable failed"); } }), /timer failed; service quarantine failed: disable failed/);
	assert.deepEqual(events, ["quarantine"]);
});

test("DSO-009 entry points and workflow reject stale unconditional approval gates", () => {
	const adkRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
	for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) assert.doesNotMatch(readFileSync(join(adkRoot, name), "utf8"), /(?:사용자 확인|사용자 승인) \(게이트\)/);
	assert.doesNotMatch(readFileSync(join(adkRoot, "AGENTS.en.md"), "utf8"), /(?:user confirmation|user approval) \(gate\)/i);
	const workflow = readFileSync(join(adkRoot, ".agents/workflows/issue-driven-development.yaml"), "utf8");
	assert.doesNotMatch(workflow, /plan approval/i);
	assert.match(workflow, /internal checkpoint for bounded requests/);
});
