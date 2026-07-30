#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SessionStore } from "./store.mjs";

class UsageError extends Error {}

function parseArgs(argv) {
	const positional = [];
	const options = { json: false, jsonl: false, events: false, once: false, active: false, failed: false };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--json") options.json = true;
		else if (value === "--jsonl") options.jsonl = true;
		else if (value === "--events") options.events = true;
		else if (value === "--once") options.once = true;
		else if (value === "--active") options.active = true;
		else if (value === "--failed") options.failed = true;
		else if (value === "--adk-root" || value === "--job") {
			const next = argv[index + 1];
			if (!next || next.startsWith("--")) throw new UsageError(`${value} requires a value`);
			options[value === "--adk-root" ? "adkRoot" : "jobId"] = next;
			index += 1;
		} else if (value.startsWith("--")) throw new UsageError(`unknown option: ${value}`);
		else positional.push(value);
	}
	return { positional, options };
}

function validateInvocation(positional, options) {
	const command = positional[0] ?? "status";
	const allowed = {
		status: new Set(["json"]),
		jobs: new Set(["json", "active", "failed"]),
		job: new Set(["json", "events"]),
		watch: new Set(["jsonl", "once", "jobId"]),
	};
	if (!allowed[command]) throw new UsageError(`unsupported command: ${command}`);
	const expectedPositionals = positional.length === 0 ? 0 : command === "job" ? 2 : 1;
	if (positional.length !== expectedPositionals) throw new UsageError(`invalid arguments for ${command}`);
	if (command === "jobs" && options.active && options.failed) throw new UsageError("--active and --failed are mutually exclusive");
	for (const [key, value] of Object.entries(options)) {
		if (key === "adkRoot" || value === false || value === undefined) continue;
		if (!allowed[command].has(key)) throw new UsageError(`option --${key} is not valid for ${command}`);
	}
	return command;
}

function humanJob(job) {
	return `${job.jobId}  ${job.lifecycle}  ${job.activityHealth.value} (${job.activityHealth.reasonCode})  child=${job.childState?.state ?? "unknown"}  ${job.backendId}  ${job.safeSummary}`;
}

function output(value, jsonMode) {
	if (jsonMode) console.log(JSON.stringify(value, null, 2));
	else if (Array.isArray(value)) value.forEach((item) => console.log(humanJob(item)));
	else console.log(value);
}

let positional;
let options;
let command;
try {
	({ positional, options } = parseArgs(process.argv.slice(2)));
	command = validateInvocation(positional, options);
} catch (error) {
	console.error(error.message);
	process.exit(error instanceof UsageError ? 2 : 1);
}
const adkRoot = resolve(options.adkRoot ?? process.env.NAIA_ADK_PATH ?? process.cwd());
const databasePath = resolve(adkRoot, "naia-settings/.sessions/messenger-sessions/runtime.sqlite3");

if (!existsSync(databasePath) && command === "status") {
	const empty = {
		schemaVersion: 1,
		service: { state: "stopped", reasonCode: "service_state_missing", observedAt: new Date().toISOString(), heartbeatAt: null, processAlive: null },
		gateway: { resumable: false, sequence: null, lastHeartbeatAckAt: null },
		jobs: { active: 0, suspectedStalled: 0, needsReview: 0 },
	};
	if (options.json) console.log(JSON.stringify(empty, null, 2));
	else console.log("service=stopped reason=service_state_missing active=0 stalled=0 review=0");
	process.exit(0);
}

if (!existsSync(databasePath)) {
	console.error(`No Discord session state at ${databasePath}`);
	process.exit(3);
}

let store;
try {
	store = new SessionStore(databasePath);
} catch (error) {
	console.error(`Discord session state unavailable: ${error.message}`);
	process.exit(3);
}
try {
	if (command === "status") {
		const status = store.status();
		if (options.json) output(status, true);
		else output(`service=${status.service.state} reason=${status.service.reasonCode} gateway=${status.gateway.resumable ? "resumable" : "fresh_connect"} active=${status.jobs.active} stalled=${status.jobs.suspectedStalled} review=${status.jobs.needsReview}`, false);
	} else if (command === "jobs") {
		let jobs = store.listJobs();
		if (options.active) jobs = jobs.filter((job) => !["completed", "failed", "cancelled", "recovery_review"].includes(job.lifecycle));
		if (options.failed) jobs = jobs.filter((job) => job.lifecycle === "failed" || job.lifecycle === "recovery_review");
		output(options.json ? { schemaVersion: 1, jobs } : jobs, options.json);
	} else if (command === "job") {
		const jobId = positional[1];
		if (!jobId) throw new Error("job id is required");
		const job = store.getJob(jobId, { includeEvents: options.events || options.json });
		if (!job) {
			console.error(`unknown job: ${jobId}`);
			process.exitCode = 2;
		} else if (options.json) output({ schemaVersion: 1, job }, true);
		else {
			console.log(humanJob(job));
			if (options.events) job.events.forEach((event) => console.log(`  ${event.sequence} ${event.occurredAt} ${event.kind} ${event.safeSummary}`));
		}
	} else if (command === "watch") {
		let cursor = 0;
		const emit = () => {
			const events = store.eventsAfter({ jobId: options.jobId, afterOrdinal: cursor });
			for (const event of events) {
				cursor = Math.max(cursor, event.ordinal);
				if (options.jsonl) console.log(JSON.stringify({ schemaVersion: 1, event }));
				else console.log(`${event.occurredAt} ${event.jobId} ${event.kind} ${event.safeSummary}`);
			}
		};
		emit();
		if (!options.once) {
			const timer = setInterval(emit, 500);
			process.on("SIGINT", () => {
				clearInterval(timer);
				store.close();
				process.exit(0);
			});
			await new Promise(() => {});
		}
	} else {
		console.error(`unsupported command: ${command}`);
		process.exitCode = 2;
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
} finally {
	if (command !== "watch" || options.once) store.close();
}
