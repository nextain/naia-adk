#!/usr/bin/env node
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMessengerConfig } from "./discord-config.mjs";
import { messengerInstancePaths, normalizeMessengerInstance } from "./instance-paths.mjs";
import { SessionStore } from "./store.mjs";
import { gatewayEvidenceBoundSeconds, projectUnattendedHealth } from "./unattended-health.mjs";
import { protectOwnerOnly } from "./platform-security.mjs";

function argumentsFor(argv) {
	const rootIndex = argv.indexOf("--adk-root");
	const instanceIndex = argv.indexOf("--instance");
	if (rootIndex < 0 || !argv[rootIndex + 1]) throw new Error("--adk-root is required");
	if (argv.includes("--loop")) throw new Error("interactive supervisor loops are unsupported; install the OS scheduler");
	return { adkRoot: resolve(argv[rootIndex + 1]), instance: normalizeMessengerInstance(instanceIndex < 0 ? "default" : argv[instanceIndex + 1]) };
}

function missingStatus(nowMs) {
	return { schemaVersion: 1, service: { state: "stopped", reasonCode: "service_state_missing" }, gateway: { lastHeartbeatAckAt: null }, jobs: { active: 0, suspectedStalled: 0, needsReview: 0 }, observedAt: new Date(nowMs).toISOString() };
}

export function observeOnce({ adkRoot, instance = "default", nowMs = Date.now() }) {
	const paths = messengerInstancePaths(adkRoot, instance);
	const config = loadMessengerConfig(paths.configPath);
	let store;
	let status;
	let jobs = [];
	try {
		if (existsSync(paths.databasePath)) {
			store = SessionStore.openReadOnly(paths.databasePath);
			status = store.status({ nowMs });
			jobs = store.listJobs({ nowMs });
		} else status = missingStatus(nowMs);
		const projection = projectUnattendedHealth({ status, jobs, nowMs, noProgressInterventionSeconds: config.runtime.noProgressInterventionSeconds ?? config.runtime.softSilenceSeconds ?? 120, gatewayEvidenceStaleSeconds: gatewayEvidenceBoundSeconds(config.runtime.heartbeatSeconds ?? 10) });
		mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
		protectOwnerOnly(paths.stateDirectory, "directory", "Discord supervisor state");
		const snapshot = { ...projection, instance: paths.instance };
		const temporary = `${paths.supervisorStatusPath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600, flag: "wx" });
		protectOwnerOnly(temporary, "file", "Discord supervisor snapshot");
		renameSync(temporary, paths.supervisorStatusPath);
		protectOwnerOnly(paths.supervisorStatusPath, "file", "Discord supervisor snapshot");
		return snapshot;
	} finally { store?.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	try {
		const options = argumentsFor(process.argv.slice(2));
		const result = observeOnce(options);
		console.log(JSON.stringify(result));
		process.exitCode = result.state === "unhealthy" ? 4 : 0;
	} catch (error) {
		console.error(`naia-discord-supervisor: ${error.message}`);
		process.exitCode = 1;
	}
}
