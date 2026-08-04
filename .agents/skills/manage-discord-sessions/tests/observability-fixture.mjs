import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../helper/store.mjs";
import { protectOwnerOnly } from "../helper/platform-security.mjs";

export const roots = [];

export function cleanupRoots() {
	while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
}

export function fixture(ownershipReader = {}) {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-observability-"));
	roots.push(root);
	const configDir = join(root, "naia-settings/messenger-sessions");
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	writeFileSync(configPath, JSON.stringify({
		schemaVersion: 1,
		enabled: true,
		workspaceId: "test",
		persona: { name: "Reviewer", instructions: "Review." },
		role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: ["write"] },
		backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: false } } },
		discord: {
			credentialRef: "discord-token",
			botUserId: "111111111111111111",
			operatorUserIds: [],
			bindings: [{
				kind: "guild_channel",
				guildId: "333333333333333333",
				channelId: "444444444444444444",
				respondWhen: "mentioned",
				allowedUserIds: ["222222222222222222"],
				canStartConversation: false,
				operatorActions: true,
			}],
		},
		runtime: {
			heartbeatSeconds: 10,
			softSilenceSeconds: 120,
			noProgressInterventionSeconds: 120,
			operatorResponseSeconds: 30,
			approvalPolicy: "never",
			permissionProfileEpoch: "profile-1",
			maxConcurrentJobs: 1,
		},
		observability: { discordStatusProjection: true },
		service: { autoStart: true, startAt: "login" },
		recovery: { autoRetry: true },
	}));
	protectOwnerOnly(configPath, "file", "test messenger config");
	const stateDir = join(root, "naia-settings/.sessions/messenger-sessions");
	mkdirSync(stateDir, { recursive: true });
	const databasePath = join(stateDir, "runtime.sqlite3");
	return { root, databasePath, store: new SessionStore(databasePath, ownershipReader) };
}

export function iso(offsetMs = 0) {
	return new Date(Date.UTC(2026, 6, 30, 0, 0, 0) + offsetMs).toISOString();
}
export function createRunningJob(store, options = {}) {
	store.heartbeatService({ generation: "generation-1", pid: options.servicePid ?? process.pid, now: iso(options.heartbeatOffset ?? 0) });
	const jobId = options.jobId ?? "job-1";
	store.createJob({
		jobId,
		backendId: options.backendId ?? "codex",
		revision: options.revision ?? "rev-1",
		activityDetail: options.activityDetail ?? "structured",
		now: iso(),
		softSilenceMs: options.softSilenceMs ?? 120_000,
		hardDeadlineAt: options.hardDeadlineAt ?? null,
		requiredChecks: options.requiredChecks ?? [],
		jobType: options.jobType ?? "issue_work",
	});
	const attemptId = store.startAttempt(jobId, {
		attemptId: `${jobId}-attempt-1`,
		now: iso(100),
		childPid: options.childPid ?? process.pid,
	});
	return { jobId, attemptId };
}
