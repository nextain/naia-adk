#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMessengerConfig, FileCredentialResolver } from "./discord-config.mjs";
import { DiscordGatewaySession, StoredGatewayState } from "./discord-gateway.mjs";
import { DiscordMessageRouter } from "./discord-router.mjs";
import { SessionStore } from "./store.mjs";
import { loadOrCreateRecoveryKey, RecoveryCodec } from "./recovery-crypto.mjs";
import { DiscordStatusProjection } from "./discord-projection.mjs";
import { discordScopeKey } from "./discord-scope.mjs";
import { postDiscordMessage } from "./discord-delivery.mjs";
import { messengerInstancePaths, normalizeMessengerInstance } from "./instance-paths.mjs";
import { assertOwnerOnly } from "./platform-security.mjs";
import { fetchDiscordConversation } from "./discord-conversation.mjs";

function configuredBackendCommand(name) {
	const executable = process.env[`NAIA_${name.toUpperCase()}_EXECUTABLE`];
	if (!executable) return null;
	const encoded = process.env[`NAIA_${name.toUpperCase()}_PREFIX_ARGS`];
	if (!encoded) return executable;
	let prefixArgs;
	try { prefixArgs = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
	catch { throw new Error(`${name} backend prefix arguments are invalid`); }
	if (!Array.isArray(prefixArgs) || prefixArgs.length !== 1 || prefixArgs.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new Error(`${name} backend prefix arguments are invalid`);
	}
	return { command: executable, prefixArgs };
}

function parseServiceArguments(argv) {
	const rootIndex = argv.indexOf("--adk-root");
	const instanceIndex = argv.indexOf("--instance");
	if (rootIndex < 0 || !argv[rootIndex + 1] || argv[rootIndex + 1].startsWith("--")) throw new Error("--adk-root is required");
	if (instanceIndex >= 0 && (!argv[instanceIndex + 1] || argv[instanceIndex + 1].startsWith("--"))) throw new Error("--instance requires a value");
	if (argv.length !== (instanceIndex >= 0 ? 4 : 2)) throw new Error("unsupported service arguments");
	return {
		adkRoot: resolve(argv[rootIndex + 1]),
		instance: normalizeMessengerInstance(instanceIndex >= 0 ? argv[instanceIndex + 1] : "default"),
	};
}

export function isSqliteBusyError(error) {
	return error?.errcode === 5 || error?.code === "SQLITE_BUSY" || (error?.code === "ERR_SQLITE_ERROR" && /database (?:is )?locked/i.test(error?.message ?? ""));
}

export function heartbeatServiceSafely(store, input, { onBusy = () => console.error("naia-discord-service: heartbeat_sqlite_busy_skipped") } = {}) {
	try {
		store.heartbeatService(input);
		return true;
	} catch (error) {
		if (!isSqliteBusyError(error)) throw error;
		onBusy();
		return false;
	}
}

export async function runDiscordService({ adkRoot, instance = "default", webSocketFactory, fetchImpl, sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)), signalSource = process } = {}) {
	const root = resolve(adkRoot);
	const paths = messengerInstancePaths(root, instance);
	const config = loadMessengerConfig(paths.configPath);
	const token = new FileCredentialResolver(paths.credentialsDirectory).resolve(config.discord.credentialRef);
	const store = new SessionStore(paths.databasePath);
	const recoveryCodec = new RecoveryCodec(loadOrCreateRecoveryKey(paths.recoveryKeyPath));
	const projection = config.observability?.discordStatusProjection === true ? new DiscordStatusProjection({ store, token, botUserId: config.discord.botUserId, fetchImpl }) : null;
	const generation = randomUUID();
	let stopping = false;
	let gateway = null;
	let wakeReconnect = null;
	let wakeStop = null;
	const stopRequested = new Promise((resolveStop) => { wakeStop = resolveStop; });
	const delivery = fetchImpl ? (input) => import("./discord-delivery.mjs").then(({ deliverJobResult }) => deliverJobResult({ ...input, fetchImpl })) : undefined;
	const backendExecutables = {
		...(configuredBackendCommand("codex") ? { codex: configuredBackendCommand("codex") } : {}),
		...(configuredBackendCommand("claude") ? { claude: configuredBackendCommand("claude") } : {}),
	};
	const send = fetchImpl ? (input) => postDiscordMessage({ ...input, fetchImpl }) : postDiscordMessage;
	const loadHistory = (input) => fetchDiscordConversation({ ...input, fetchImpl: fetchImpl ?? fetch });
	const router = new DiscordMessageRouter({ config, store, token, botUserId: config.discord.botUserId, cwd: root, runtimeRoot: paths.runtimeRoot, recoveryCodec, projectStatus: projection ? (input) => projection.publishScope(input) : null, deliver: delivery, send, loadHistory, backendExecutables });
	let reconnectDelay = 1_000;
	const heartbeat = () => heartbeatServiceSafely(store, { generation, status: stopping ? "stopped" : "running", pid: stopping ? null : process.pid });
	heartbeat();
	const recoveredJobs = store.recoverInterruptedWork();
	router.resumeRecovered(recoveredJobs, { autoRetry: config.recovery?.autoRetry === true });
	if (projection) {
		for (const binding of config.discord.bindings.filter((item) => item.operatorActions === true)) {
			const channelId = binding.threadId ?? binding.channelId;
			if (!channelId) continue;
			const scopeKey = discordScopeKey({ kind: binding.kind, guildId: binding.guildId, channelId: binding.channelId, threadId: binding.threadId });
			void projection.publishScope({ scopeKey, channelId }).catch(() => {});
		}
	}
	const heartbeatTimer = setInterval(heartbeat, (config.runtime?.heartbeatSeconds ?? 10) * 1_000);
	const watchdogIntervalSeconds = Math.max(1, Math.min(config.runtime?.heartbeatSeconds ?? 10, config.runtime?.noProgressInterventionSeconds ?? config.runtime?.softSilenceSeconds ?? 120, config.runtime?.operatorResponseSeconds ?? 30));
	const watchdogTimer = setInterval(() => { void router.watchdog().catch(() => {}); }, watchdogIntervalSeconds * 1_000);
	watchdogTimer.unref?.();
	const stop = () => { stopping = true; gateway?.close(1_000); wakeReconnect?.(); wakeStop?.({ resumable: false }); };
	const controlTimer = setInterval(() => {
		if (!existsSync(paths.stopRequestPath)) return;
		try {
			assertOwnerOnly(paths.stopRequestPath, "file", "Discord stop request");
			const request = JSON.parse(readFileSync(paths.stopRequestPath, "utf8"));
			if (request?.schemaVersion === 1 && request.generation === generation) {
				unlinkSync(paths.stopRequestPath);
				stop();
			}
		} catch {}
	}, 250);
	signalSource.once?.("SIGTERM", stop);
	signalSource.once?.("SIGINT", stop);
	try {
		while (!stopping) {
			let disconnected;
			const closed = new Promise((resolveClosed) => { disconnected = resolveClosed; });
			gateway = new DiscordGatewaySession({
				token,
				stateRepository: new StoredGatewayState(store),
				webSocketFactory,
				messageContentIntent: config.discord.messageContentIntent === true,
				onDisconnect: disconnected,
				onDispatch: (type, data, sequence) => { if (type === "READY" || type === "RESUMED") reconnectDelay = 1_000; return router.onDispatch(type, data, sequence); },
			});
			gateway.connect();
			const event = await Promise.race([closed, stopRequested]);
			if (stopping) break;
			if (event.resumable === false) { stopping = true; break; }
			await Promise.race([sleep(reconnectDelay), new Promise((resolveWake) => { wakeReconnect = resolveWake; })]);
			wakeReconnect = null;
			reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
		}
	} finally {
		clearInterval(heartbeatTimer);
		clearInterval(watchdogTimer);
		clearInterval(controlTimer);
		await gateway?.drain();
		await router.shutdown();
		stopping = true;
		heartbeat();
		store.close();
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	let exitCode = 0;
	try {
		await runDiscordService(parseServiceArguments(process.argv.slice(2)));
	}
	catch {
		console.error("naia-discord-service: startup_or_runtime_failure");
		exitCode = 1;
	}
	// Native WebSocket implementations can retain a closing socket handle
	// after shutdown succeeds or fails. The service process owns no reusable
	// in-memory state, so terminate after the durable cleanup attempt returns.
	process.exit(exitCode);
}
