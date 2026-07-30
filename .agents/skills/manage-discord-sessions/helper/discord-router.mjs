import { randomUUID } from "node:crypto";
import { getBackendAdapter } from "./adapters.mjs";
import { authorizeDiscordMessage } from "./discord-scope.mjs";
import { deliverJobResult, formatOperatorStatus, postDiscordMessage } from "./discord-delivery.mjs";
import { runBackendAttempt } from "./backend-runner.mjs";

function transientPrompt(message, botUserId, config) {
	if (typeof message.content !== "string" || message.content.length > 4_000) throw new Error("Discord content is missing or too large");
	const userText = message.content.replaceAll(`<@${botUserId}>`, "").replaceAll(`<@!${botUserId}>`, "").trim();
	if (!userText) throw new Error("Discord prompt is empty after mention removal");
	return [`Persona: ${config.persona.name}`, config.persona.instructions, `Role: ${config.role.name}`, `Allowed actions: ${config.role.allowedActions.join(", ")}`, "User request:", userText].join("\n");
}

function commandText(message, botUserId) {
	return String(message.content ?? "").replaceAll(`<@${botUserId}>`, "").replaceAll(`<@!${botUserId}>`, "").trim();
}

export class DiscordMessageRouter {
	constructor({ config, store, token, botUserId, cwd, runtimeRoot, recoveryCodec = null, projectStatus = null, runner = runBackendAttempt, deliver = deliverJobResult, send = postDiscordMessage, backendExecutables = {} }) {
		this.config = config;
		this.store = store;
		this.token = token;
		this.botUserId = botUserId;
		this.cwd = cwd;
		this.runtimeRoot = runtimeRoot;
		this.runner = runner;
		this.deliver = deliver;
		this.send = send;
		this.backendExecutables = backendExecutables;
		this.recoveryCodec = recoveryCodec;
		this.projectStatus = projectStatus;
		this.threadParents = new Map();
		for (const binding of config.discord.bindings) {
			if (binding.kind === "thread") this.threadParents.set(binding.threadId, { parentChannelId: binding.channelId, guildId: binding.guildId });
		}
		this.queue = [];
		this.running = 0;
		this.maxConcurrent = config.runtime?.maxConcurrentJobs ?? 1;
		this.accepting = true;
		this.controllers = new Map();
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
		const commandOptions = this.#commandOptions(backendId);
		const recoveryEnvelope = this.recoveryCodec?.seal(JSON.stringify({ prompt, channelId, commandOptions })) ?? null;
		const ingress = this.store.acceptIngressAndCreateJob({ sourceMessageId, scopeKey: authorization.scopeKey, jobId, dispatchSequence: sequence, backendId, revision: "discord-v1", backendCapabilities: adapter.capabilities, activityDetail: adapter.activityDetail, jobType: "conversation",
			softSilenceMs: (this.config.runtime?.softSilenceSeconds ?? 120) * 1_000, recoveryEnvelope });
		if (ingress.duplicate) return { state: "duplicate", jobId: ingress.jobId };
		this.queue.push({ jobId, backendId, prompt, channelId, commandOptions });
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
			const item = this.queue.shift();
			this.running += 1;
			void this.#run(item).finally(() => { this.running -= 1; this.#drain(); });
		}
	}

	#commandOptions(backendId) {
		const requestedMutation = this.config.role.allowedActions.includes("write") || this.config.role.allowedActions.includes("execute");
		const mutationNeedsApproval = this.config.role.requiresApproval?.includes("write") || this.config.role.requiresApproval?.includes("execute");
		const mayMutate = requestedMutation && !mutationNeedsApproval;
		return backendId === "codex" ? { sandbox: mayMutate ? "workspace-write" : "read-only" } : { permissionMode: mayMutate ? "dontAsk" : "plan", settingSources: "project" };
	}

	async #run(item) {
		const controller = new AbortController();
		this.controllers.set(item.jobId, controller);
		try {
			const result = await this.runner({ store: this.store, jobId: item.jobId, backendId: item.backendId, prompt: item.prompt, cwd: this.cwd, runtimeRoot: this.runtimeRoot, executable: this.backendExecutables[item.backendId], commandOptions: item.commandOptions ?? this.#commandOptions(item.backendId), signal: controller.signal });
			if (result.backendOutcome !== "success") return;
			if (!result.transientResult) throw new Error("backend returned no deliverable final result");
			await this.deliver({ store: this.store, jobId: item.jobId, attemptId: result.attemptId, token: this.token, botUserId: this.botUserId, channelId: item.channelId, content: result.transientResult, signal: controller.signal });
		} catch {
			const job = this.store.getJob(item.jobId);
			if (job && !["failed", "cancelled", "completed", "recovery_review"].includes(job.lifecycle)) {
				try { this.store.recordEvent({ jobId: item.jobId, attemptId: job.attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } }); } catch {}
			}
		} finally {
			this.controllers.delete(item.jobId);
			const job = this.store.getJob(item.jobId, { includeEvents: false });
			if (job?.scopeKey) void this.projectStatus?.({ scopeKey: job.scopeKey, channelId: item.channelId }).catch(() => {});
		}
	}

	async waitForIdle() {
		while (this.running > 0 || this.queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 5));
	}

	async shutdown() {
		this.accepting = false;
		for (const controller of this.controllers.values()) controller.abort("recovery");
		for (const item of this.queue.splice(0)) {
			try { this.store.recordEvent({ jobId: item.jobId, source: "recovery", kind: "recovered", safePayload: { recoveryAction: "safe_retry" } }); } catch {}
		}
		await this.waitForIdle();
	}

	resumeRecovered(items, { autoRetry = false } = {}) {
		if (items.length > 0 && !this.recoveryCodec) throw new Error("recovery codec is unavailable");
		for (const item of items) {
			try {
				const payload = JSON.parse(this.recoveryCodec.open(item.envelope));
				if (typeof payload.prompt !== "string" || !/^\d{17,20}$/.test(payload.channelId)) throw new Error("recovery payload is invalid");
				const readOnly = payload.commandOptions?.sandbox === "read-only" || payload.commandOptions?.permissionMode === "plan";
				if (!autoRetry || !readOnly) throw new Error("automatic recovery is not allowed for this job");
				this.queue.push({ jobId: item.jobId, backendId: item.backendId, prompt: payload.prompt, channelId: payload.channelId, commandOptions: payload.commandOptions });
			} catch {
				this.store.recordEvent({ jobId: item.jobId, source: "recovery", kind: "recovery_review_required", safePayload: {} });
			}
		}
		this.#drain();
	}
}
