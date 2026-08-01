import { randomUUID } from "node:crypto";
import { getBackendAdapter } from "./adapters.mjs";
import { authorizeDiscordMessage } from "./discord-scope.mjs";
import { deliverJobResult, formatOperatorStatus } from "./discord-delivery.mjs";
import { runBackendAttempt } from "./backend-runner.mjs";
import { commandOptionsForProfile, currentExecutionProfile, sameExecutionProfile } from "./execution-profile.mjs";
import { promptWithDiscordConversation } from "./discord-conversation.mjs";

const PROGRESS_TEXT = "[진행 중]";

const FAILURE_TEXT = {
	no_progress_timeout: "일정 시간 동안 진행이 없어 작업을 중단했습니다.",
	timeout: "작업 제한 시간을 초과해 중단했습니다.",
	process_exit: "작업 프로세스가 비정상 종료됐습니다.",
	approval_ui_detected: "승인 입력을 요구하는 실행이 감지되어 안전하게 중단했습니다.",
	internal_error: "작업 중 내부 오류가 발생했습니다.",
};

const MAX_OPERATOR_RESPONSE_INTERVENTIONS = 4;

function failureReason(job) {
	const match = String(job?.latestSafeError ?? "").match(/^Job failed: ([a-z0-9_]+)$/);
	return match?.[1] ?? "internal_error";
}

function transientPrompt(message, botUserId, config) {
	if (typeof message.content !== "string" || message.content.length > 4_000) throw new Error("Discord content is missing or too large");
	const userText = message.content.replaceAll(`<@${botUserId}>`, "").replaceAll(`<@!${botUserId}>`, "").trim();
	if (!userText) throw new Error("Discord prompt is empty after mention removal");
	return [`Persona: ${config.persona.name}`, config.persona.instructions, `Role: ${config.role.name}`, `Allowed actions: ${config.role.allowedActions.join(", ")}`, "Communication: Reply in the language used by the user. Before tool work, provide a brief analysis and action plan as an intermediate update. During long work, report meaningful findings or phase changes before the final verified result. Do not repeat generic status text.", "User request:", userText].join("\n");
}

function commandText(message, botUserId) {
	return String(message.content ?? "").replaceAll(`<@${botUserId}>`, "").replaceAll(`<@!${botUserId}>`, "").trim();
}

export class DiscordMessageRouter {
	constructor({ config, store, token, botUserId, cwd, runtimeRoot, recoveryCodec = null, projectStatus = null, runner = runBackendAttempt, deliver = deliverJobResult, send = null, loadHistory = null, backendExecutables = {}, now = () => Date.now() }) {
		if (typeof send !== "function") throw new Error("confirmed Discord sender is required");
		this.config = config;
		this.store = store;
		this.token = token;
		this.botUserId = botUserId;
		this.cwd = cwd;
		this.runtimeRoot = runtimeRoot;
		this.runner = runner;
		this.deliver = deliver;
		this.send = send;
		this.loadHistory = loadHistory;
		this.backendExecutables = backendExecutables;
		this.recoveryCodec = recoveryCodec;
		this.projectStatus = projectStatus;
		this.now = now;
		this.threadParents = new Map();
		for (const binding of config.discord.bindings) {
			if (binding.kind === "thread") this.threadParents.set(binding.threadId, { parentChannelId: binding.channelId, guildId: binding.guildId });
		}
		this.queue = [];
		this.running = 0;
		this.runningScopes = new Set();
		this.maxConcurrent = config.runtime?.maxConcurrentJobs ?? 1;
		this.accepting = true;
		this.controllers = new Map();
		this.operatorResponses = new Map();
		this.operatorResponseWaiters = new Map();
	}

	async onDispatch(type, data, sequence) {
		if (!this.accepting) return { state: "stopping" };
		if (type === "THREAD_CREATE" || type === "THREAD_UPDATE") {
			if (data?.id && data?.parent_id) this.threadParents.set(data.id, { parentChannelId: data.parent_id, guildId: data.guild_id });
			return { state: "thread_cached" };
		}
		if (type === "THREAD_LIST_SYNC") {
			for (const thread of data?.threads ?? []) if (thread?.id && thread?.parent_id) this.threadParents.set(thread.id, { parentChannelId: thread.parent_id, guildId: data.guild_id });
			return { state: "threads_cached" };
		}
		if (type !== "MESSAGE_CREATE") return { state: "ignored" };
		const authorization = authorizeDiscordMessage({ message: data, bindings: this.config.discord.bindings, operatorUserIds: this.config.discord.operatorUserIds, botUserId: this.botUserId, threadParents: this.threadParents });
		const sourceMessageId = data.id;
		if (!authorization.allowed) {
			if (authorization.scope && sourceMessageId) this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "rejected", reasonCode: authorization.reasonCode, dispatchSequence: sequence });
			return { state: "rejected", reasonCode: authorization.reasonCode };
		}
		const command = commandText(data, this.botUserId);
		if (/^!naia(?:\s|$)/i.test(command)) return this.#handleCommand({ command, authorization, sourceMessageId, sequence });
		if (authorization.binding.canStartConversation !== true) {
			this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "rejected", reasonCode: "conversation_start_disabled", dispatchSequence: sequence });
			return { state: "rejected", reasonCode: "conversation_start_disabled" };
		}
		let prompt;
		try { prompt = transientPrompt(data, this.botUserId, this.config); }
		catch {
			this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "rejected", reasonCode: "prompt_invalid", dispatchSequence: sequence });
			return { state: "rejected", reasonCode: "prompt_invalid" };
		}
		const jobId = randomUUID();
		const backendId = this.config.backend.selected;
		const adapter = getBackendAdapter(backendId);
		const channelId = authorization.scope.threadId ?? authorization.scope.channelId;
		const executionProfile = this.#executionProfile(backendId);
		const commandOptions = commandOptionsForProfile(executionProfile);
		const recoveryEnvelope = this.recoveryCodec?.seal(JSON.stringify({ prompt, channelId, scopeKey: authorization.scopeKey, executionProfile })) ?? null;
		const ingress = this.store.acceptIngressAndCreateJob({ sourceMessageId, scopeKey: authorization.scopeKey, jobId, dispatchSequence: sequence, backendId, revision: "discord-v1", backendCapabilities: adapter.capabilities, activityDetail: adapter.activityDetail, jobType: "conversation",
			softSilenceMs: (this.config.runtime?.softSilenceSeconds ?? 120) * 1_000, recoveryEnvelope, now: this.#nowIso() });
		if (ingress.duplicate) return { state: "duplicate", jobId: ingress.jobId };
		const item = { jobId, backendId, prompt, channelId, scopeKey: authorization.scopeKey, sourceMessageId, allowedUserIds: authorization.binding.allowedUserIds, commandOptions, executionProfile };
		item.operatorReady = this.#scheduleOperatorResponse(item);
		this.queue.push(item);
		this.#drain();
		void this.projectStatus?.({ scopeKey: authorization.scopeKey, channelId }).catch(() => {});
		return { state: "accepted", jobId };
	}

	async #handleCommand({ command, authorization, sourceMessageId, sequence }) {
		const ingress = this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "handled", reasonCode: "status_command", dispatchSequence: sequence });
		if (ingress.duplicate) return { state: "duplicate" };
		const parts = command.trim().split(/\s+/);
		const action = (parts[1] ?? "status").toLowerCase();
		const allScopes = parts[2]?.toLowerCase() === "all";
		let content;
		if (action === "status") {
			if (allScopes && !authorization.isOperator) content = "이 바인딩에서는 전체 작업을 볼 수 없습니다.";
			else {
				const jobs = allScopes ? this.store.listJobs() : this.store.listJobsForScope(authorization.scopeKey);
				content = formatOperatorStatus(this.store.status(), jobs);
			}
		} else if (action === "jobs") {
			const jobs = this.store.listJobsForScope(authorization.scopeKey).slice(0, 8);
			content = jobs.length ? jobs.map((job) => `${job.jobId}: ${job.lifecycle} / ${job.activityHealth.value} / ${job.currentActivity ?? job.safeSummary}`).join("\n") : "이 대화 범위에는 작업이 없습니다.";
		} else if (action === "job" && parts[2]) {
			const job = this.store.getJob(parts[2], { includeEvents: false });
			content = job && (job.scopeKey === authorization.scopeKey || authorization.isOperator) ? `${job.jobId}: ${job.lifecycle} / ${job.activityHealth.value} (${job.activityHealth.reasonCode}) / ${job.currentActivity ?? job.safeSummary}` : "이 대화 범위에서 볼 수 없는 작업입니다.";
		} else content = "사용법: !naia status | jobs | job <id>";
		const channelId = authorization.scope.threadId ?? authorization.scope.channelId;
		await this.send({ token: this.token, channelId, botUserId: this.botUserId, content, nonce: randomUUID().replaceAll("-", "").slice(0, 24) });
		return { state: "command_handled", action };
	}

	#drain() {
		while (this.running < this.maxConcurrent && this.queue.length) {
			const index = this.queue.findIndex((candidate) => !candidate.scopeKey || !this.runningScopes.has(candidate.scopeKey));
			if (index < 0) break;
			const [item] = this.queue.splice(index, 1);
			this.running += 1;
			if (item.scopeKey) this.runningScopes.add(item.scopeKey);
			void this.#run(item).finally(() => {
				this.running -= 1;
				if (item.scopeKey) this.runningScopes.delete(item.scopeKey);
				this.#drain();
			});
		}
	}

	#commandOptions(backendId) {
		return commandOptionsForProfile(this.#executionProfile(backendId));
	}

	#executionProfile(backendId) {
		return currentExecutionProfile(this.config, backendId);
	}

	#nowIso() {
		return new Date(this.now()).toISOString();
	}

	#noProgressInterventionMs() {
		return (this.config.runtime?.noProgressInterventionSeconds ?? this.config.runtime?.softSilenceSeconds ?? 120) * 1_000;
	}

	#noProgressIsDue(job, nowMs) {
		if (job.activityHealth.value === "unresponsive") return true;
		if (job.activityHealth.value !== "suspected_stalled") return false;
		const lastProgressMs = Date.parse(job.lastProgressAt ?? job.updatedAt);
		return Number.isFinite(lastProgressMs) && nowMs - lastProgressMs >= this.#noProgressInterventionMs();
	}

	#scheduleOperatorResponse(item) {
		let resolveWaiter;
		const ready = new Promise((resolve) => { resolveWaiter = resolve; });
		this.operatorResponseWaiters.set(item.jobId, resolveWaiter);
		this.operatorResponses.set(item.jobId, { ...item, nonce: randomUUID().replaceAll("-", "").slice(0, 24), deadlineMs: this.now() + (this.config.runtime?.operatorResponseSeconds ?? 30) * 1_000, interventions: 0, intervening: false, sendPromise: null });
		void this.#sendOperatorResponse(item.jobId);
		return ready;
	}

	#resolveOperatorResponse(jobId, value) {
		this.operatorResponseWaiters.get(jobId)?.(value);
		this.operatorResponseWaiters.delete(jobId);
	}

	async #sendOperatorResponse(jobId) {
		const state = this.operatorResponses.get(jobId);
		if (!state || !this.send) return false;
		if (state.sendPromise) return state.sendPromise;
		const sendPromise = (async () => {
			try {
				const receipt = await this.send({ token: this.token, channelId: state.channelId, botUserId: this.botUserId, content: "[메시지 받음]", nonce: state.nonce });
				if (receipt?.state !== "confirmed") return false;
				this.store.recordEvent({ jobId, source: "helper", kind: "operator_response_sent", safePayload: {} });
				this.operatorResponses.delete(jobId);
				this.#resolveOperatorResponse(jobId, true);
				return true;
			} catch {
				return false;
			}
		})();
		state.sendPromise = sendPromise;
		try { return await sendPromise; }
		finally { if (state.sendPromise === sendPromise) state.sendPromise = null; }
	}

	async #run(item) {
		const controller = new AbortController();
		this.controllers.set(item.jobId, controller);
		try {
			const operatorReady = item.operatorReady ? await item.operatorReady : true;
			if (!operatorReady) {
				if (controller.signal.reason === "recovery") return;
				throw new Error("operator response was not confirmed");
			}
			if (controller.signal.aborted) return;
			const currentProfile = this.#executionProfile(item.backendId);
			if (!sameExecutionProfile(item.executionProfile ?? currentProfile, currentProfile)) {
				this.store.recordEvent({ jobId: item.jobId, source: "helper", kind: "profile_replaced", safePayload: {} });
				item = { ...item, executionProfile: currentProfile, commandOptions: commandOptionsForProfile(currentProfile) };
			}
			let prompt = item.prompt;
			if (this.loadHistory && item.sourceMessageId) {
				const loaded = await this.loadHistory({ token: this.token, channelId: item.channelId, beforeMessageId: item.sourceMessageId, botUserId: this.botUserId, allowedUserIds: item.allowedUserIds, signal: controller.signal });
				if (loaded?.state === "loaded") prompt = promptWithDiscordConversation(prompt, loaded.history);
			}
			const reported = new Set();
			let progressChain = Promise.resolve();
			const onSafeEvent = (event) => {
				if (event?.kind !== "tool_started") return;
				if (reported.size > 0 || !event.safePayload?.toolCategory) return;
				reported.add("progress");
				progressChain = progressChain.then(() => this.send({ token: this.token, channelId: item.channelId, botUserId: this.botUserId, content: PROGRESS_TEXT, nonce: randomUUID().replaceAll("-", "").slice(0, 24) })).catch(() => {});
			};
			const result = await this.runner({ store: this.store, jobId: item.jobId, backendId: item.backendId, prompt, cwd: this.cwd, runtimeRoot: this.runtimeRoot, executable: this.backendExecutables[item.backendId], commandOptions: item.commandOptions ?? this.#commandOptions(item.backendId), executionProfile: item.executionProfile, signal: controller.signal, onSafeEvent });
			await progressChain;
			if (result.backendOutcome !== "success") {
				await this.#reportFailure(item);
				return;
			}
			if (!result.transientResult) throw new Error("backend returned no deliverable final result");
			await this.deliver({ store: this.store, jobId: item.jobId, attemptId: result.attemptId, token: this.token, botUserId: this.botUserId, channelId: item.channelId, content: result.transientResult, signal: controller.signal });
		} catch {
			const job = this.store.getJob(item.jobId);
			if (job && !["failed", "cancelled", "completed", "recovery_review"].includes(job.lifecycle)) {
				try { this.store.recordEvent({ jobId: item.jobId, attemptId: job.attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } }); } catch {}
			}
			await this.#reportFailure(item);
		} finally {
			this.controllers.delete(item.jobId);
			const job = this.store.getJob(item.jobId, { includeEvents: false });
			if (job?.scopeKey) void this.projectStatus?.({ scopeKey: job.scopeKey, channelId: item.channelId }).catch(() => {});
		}
	}

	async #reportFailure(item) {
		const job = this.store.getJob(item.jobId, { includeEvents: false });
		if (!job || !["failed", "recovery_review"].includes(job.lifecycle)) return;
		const reasonCode = failureReason(job);
		const detail = job.lifecycle === "recovery_review"
			? "전달 또는 복구 상태가 불확실해 자동 재실행하지 않고 검토 대상으로 보존했습니다."
			: FAILURE_TEXT[reasonCode] ?? FAILURE_TEXT.internal_error;
		try {
			await this.send({ token: this.token, channelId: item.channelId, botUserId: this.botUserId, content: `작업을 완료하지 못했습니다. ${detail}\n작업 ID: ${item.jobId}`, nonce: randomUUID().replaceAll("-", "").slice(0, 24) });
		} catch {}
	}

	async waitForIdle() {
		while (this.running > 0 || this.queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 5));
	}

	async watchdog({ nowMs = this.now() } = {}) {
		if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("watchdog time must be a non-negative safe integer");
		const outcome = { noProgress: 0, operatorResponse: 0 };
		for (const state of [...this.operatorResponses.values()]) {
			if (state.deadlineMs > nowMs || state.intervening) continue;
			state.intervening = true;
			try {
				state.interventions += 1;
				if (await this.#sendOperatorResponse(state.jobId)) continue;
				const job = this.store.getJob(state.jobId, { nowMs, includeEvents: false });
				if (job) {
					try { this.store.recordEvent({ jobId: state.jobId, attemptId: job.attemptId ?? undefined, source: "helper", kind: "watchdog_intervened", safePayload: { watchdogReason: "operator_response" } }); } catch {}
				}
				outcome.operatorResponse += 1;
				if (state.interventions < MAX_OPERATOR_RESPONSE_INTERVENTIONS) {
					state.deadlineMs = this.now() + (this.config.runtime?.operatorResponseSeconds ?? 30) * 1_000;
					continue;
				}
				if (job) try { this.store.recordEvent({ jobId: state.jobId, attemptId: job.attemptId ?? undefined, source: "helper", kind: "operator_response_missed", safePayload: {} }); } catch {}
				this.controllers.get(state.jobId)?.abort("operator_response_timeout");
				this.#resolveOperatorResponse(state.jobId, false);
				this.operatorResponses.delete(state.jobId);
			} finally {
				state.intervening = false;
			}
		}
		for (const job of this.store.listJobs({ nowMs })) {
			if (!this.#noProgressIsDue(job, nowMs)) continue;
			const controller = this.controllers.get(job.jobId);
			if (controller?.signal.aborted) continue;
			try { this.store.recordEvent({ jobId: job.jobId, attemptId: job.attemptId ?? undefined, source: "helper", kind: "watchdog_intervened", safePayload: { watchdogReason: "no_progress" } }); } catch { continue; }
			if (controller) controller.abort("no_progress");
			else {
				try { this.store.recordEvent({ jobId: job.jobId, attemptId: job.attemptId ?? undefined, source: "helper", kind: "failed", safePayload: { reasonCode: "no_progress_timeout" } }); } catch {}
			}
			outcome.noProgress += 1;
		}
		return outcome;
	}

	async shutdown() {
		this.accepting = false;
		for (const controller of this.controllers.values()) controller.abort("recovery");
		for (const item of this.queue.splice(0)) {
			try { this.store.recordEvent({ jobId: item.jobId, source: "recovery", kind: "recovered", safePayload: { recoveryAction: "safe_retry" } }); } catch {}
		}
		this.operatorResponses.clear();
		for (const jobId of [...this.operatorResponseWaiters.keys()]) this.#resolveOperatorResponse(jobId, false);
		await this.waitForIdle();
	}

	resumeRecovered(items, { autoRetry = false } = {}) {
		if (items.length > 0 && !this.recoveryCodec) throw new Error("recovery codec is unavailable");
		for (const item of items) {
			try {
				const payload = JSON.parse(this.recoveryCodec.open(item.envelope));
				if (typeof payload.prompt !== "string" || !/^\d{17,20}$/.test(payload.channelId)) throw new Error("recovery payload is invalid");
				const executionProfile = this.#executionProfile(item.backendId);
				const profileChanged = !sameExecutionProfile(payload.executionProfile, executionProfile);
				const freshNoPromptReplacement = profileChanged && executionProfile.authorizationMode === "never";
				if (!autoRetry || (executionProfile.access !== "read-only" && !freshNoPromptReplacement)) throw new Error("automatic recovery is not allowed for this job");
				if (profileChanged) {
					this.store.recordEvent({ jobId: item.jobId, source: "recovery", kind: "profile_replaced", safePayload: {} });
				}
				const recovered = { jobId: item.jobId, backendId: item.backendId, prompt: payload.prompt, channelId: payload.channelId, scopeKey: typeof payload.scopeKey === "string" ? payload.scopeKey : null, commandOptions: commandOptionsForProfile(executionProfile), executionProfile };
				recovered.operatorReady = this.#scheduleOperatorResponse(recovered);
				this.queue.push(recovered);
			} catch {
				this.store.recordEvent({ jobId: item.jobId, source: "recovery", kind: "recovery_review_required", safePayload: {} });
			}
		}
		this.#drain();
	}
}
