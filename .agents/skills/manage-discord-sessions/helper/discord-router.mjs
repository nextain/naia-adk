import { randomUUID } from "node:crypto";
import { getBackendAdapter } from "./adapters.mjs";
import { authorizeDiscordMessage } from "./discord-scope.mjs";
import { deliverJobResult, formatOperatorStatus, postDiscordDirectMessage } from "./discord-delivery.mjs";
import { runBackendAttempt } from "./backend-runner.mjs";
import { commandOptionsForProfile, configurationRevision, currentExecutionProfile, discordBindingIdentity, durableExecutionBinding, effectiveAllowedActions, participantAuthorityRevision, sameExecutionProfile } from "./execution-profile.mjs";
import { promptWithDiscordConversation, trustedParticipantPolicy } from "./discord-conversation.mjs";
import { attachmentPromptSection } from "./discord-attachments.mjs";
import { verifyAgentContextBeforeAttempt } from "./agent-context.mjs";

const FAILURE_TEXT = {
	no_progress_timeout: "일정 시간 동안 진행이 없어 작업을 중단했습니다.",
	timeout: "작업 제한 시간을 초과해 중단했습니다.",
	process_exit: "작업 프로세스가 비정상 종료됐습니다.",
	approval_ui_detected: "승인 입력을 요구하는 실행이 감지되어 안전하게 중단했습니다.",
	context_changed_restart_required: "프로젝트 규칙이 서비스 시작 후 변경되어, 새 규칙을 다시 읽도록 작업을 중단했습니다.",
	discord_history_load_failed: "Discord 대화 기록을 불러오는 단계에서 실패했습니다.",
	backend_version_probe_failed: "코딩 백엔드 실행 파일 확인 단계에서 실패했습니다.",
	backend_authentication_failed: "코딩 백엔드 인증 준비 단계에서 실패했습니다.",
	backend_invocation_invalid: "코딩 백엔드 실행 인자 구성 단계에서 실패했습니다.",
	backend_spawn_failed: "코딩 백엔드 프로세스 시작 단계에서 실패했습니다.",
	internal_error: "작업 중 내부 오류가 발생했습니다.",
};

const MAX_QUEUED_TURNS = 32;
const MAX_SCOPE_QUEUED_TURNS = 8;
// Proactive notifications are restricted to one configured recipient. The model
// never supplies a recipient ID, and no other operator can be targeted.
//
// The recipient comes from the instance config, not from this file. A default
// baked in here would mean every workspace that clones this skill tries to DM
// a stranger, and it would publish that person's account ID in a public
// repository. When the field is unset the feature stays off.
export function proactiveDmRecipient(config) {
	const recipient = config?.discord?.proactiveDmRecipientUserId;
	if (typeof recipient !== "string" || !/^\d{17,20}$/.test(recipient)) return null;
	return config?.discord?.operatorUserIds?.includes(recipient) === true ? recipient : null;
}

function localOperatorSnowflake(nowMs) {
	const discordEpoch = 1_420_070_400_000n;
	const timestamp = BigInt(Math.max(0, Math.trunc(nowMs))) - discordEpoch;
	return ((timestamp << 22n) | BigInt(Math.floor(Math.random() * 4_194_304))).toString();
}

function failureReason(job) {
	const match = String(job?.latestSafeError ?? "").match(/^Job failed: ([a-z0-9_]+)$/);
	return match?.[1] ?? "internal_error";
}

export function noProgressInterventionDue(job, nowMs, interventionMs) {
	const health = job?.activityHealth?.value;
	const reasonCode = job?.activityHealth?.reasonCode;
	if (health === "unresponsive" && reasonCode !== "owned_child_missing") return true;
	if (health !== "suspected_stalled" && !(health === "unresponsive" && reasonCode === "owned_child_missing")) return false;
	const lastProgressMs = Date.parse(job.lastProgressAt ?? job.updatedAt);
	return Number.isFinite(lastProgressMs) && nowMs - lastProgressMs >= interventionMs;
}

/**
 * 한 Discord 메시지가 담은 요청 전체. 본문 글과 첨부 서술을 합친다.
 *
 * 첨부를 여기서 합치는 이유는 두 가지다. 프롬프트와 복구 봉투가 같은 문자열을
 * 쓰게 되어 재시도해도 파일 정보가 사라지지 않고, 파일만 보낸 메시지가 "빈 요청"
 * 으로 판정되어 조용히 버려지지 않는다.
 */
export function discordRequestText(message, botUserId, { authorization = null, instance = null } = {}) {
	if (typeof message.content !== "string" || message.content.length > 4_000) throw new Error("Discord content is missing or too large");
	const userText = normalizedDiscordText(message.content, botUserId);
	const attachmentSection = attachmentPromptSection(message, {
		channelId: authorization?.scope?.threadId ?? authorization?.scope?.channelId ?? null,
		instance,
	});
	return [userText, attachmentSection].filter(Boolean).join("\n\n");
}

export function transientPrompt(message, botUserId, config, authorization = null, agentContextSnapshot = null, { instance = null, accessCeiling = null } = {}) {
	return boundRequestPrompt(discordRequestText(message, botUserId, { authorization, instance }), config, authorization, agentContextSnapshot, accessCeiling);
}

// 사용자 본문 4,000자에 우리가 만든 첨부 블록이 더해질 수 있다. 그 블록은 파일
// 10개까지, 이름은 각 120자로 묶여 있어 1.5KB 를 넘지 않는다.
const MAX_REQUEST_TEXT_LENGTH = 6_000;

/**
 * 이 인스턴스가 쓰는 페르소나 글.
 *
 * `instructionsFile` 을 적었으면 그 파일의 글이 정체성이고, `instructions` 는 이
 * 인스턴스에만 해당하는 경계다. 파일을 적었는데 스냅샷에 그 글이 없으면 조용히
 * 빼지 않고 멈춘다 — 정체성이 빠진 채로 도는 것이 잘못된 정체성보다 낫지 않다.
 */
export function personaInstructions(config, agentContextSnapshot) {
	// 나이아 설정에서 오는 페르소나는 스냅샷이 들고 있다. 파일과 같은 자리에 같은
	// 방식으로 해시되어 있으므로 확인하는 방법도 같다.
	if (config.persona.source === "naia-settings") {
		const fromSettings = agentContextSnapshot?.personaText ?? null;
		if (typeof fromSettings !== "string" || fromSettings.trim() === "") throw new Error("naia settings persona is missing from the agent context snapshot");
		return [fromSettings, config.persona.instructions].filter(Boolean).join("\n");
	}
	const shared = config.persona.instructionsFile === undefined ? null : agentContextSnapshot?.personaText ?? null;
	if (config.persona.instructionsFile !== undefined && (typeof shared !== "string" || agentContextSnapshot?.personaFile !== config.persona.instructionsFile)) {
		throw new Error("configured persona file is missing from the agent context snapshot");
	}
	// 빈 파일은 "글자 수 0인 정체성"이 아니라 배선 실수다.
	if (shared !== null && shared.trim() === "") throw new Error("configured persona file is empty");
	return [shared, config.persona.instructions].filter(Boolean).join("\n");
}

/** 프롬프트에 적히는 이름. 나이아 설정에서 오면 그 설정의 agentName 을 쓴다. */
export function personaName(config, agentContextSnapshot) {
	if (typeof config.persona.name === "string" && config.persona.name) return config.persona.name;
	const fromSettings = agentContextSnapshot?.personaAgentName ?? null;
	if (typeof fromSettings === "string" && fromSettings) return fromSettings;
	throw new Error("persona name is unavailable");
}

/**
 * 이번 요청이 실제로 쓸 수 있는 행동.
 *
 * 접근 상한이 걸리면 권한 목록에서 쓰기와 실행이 빠진다. 프롬프트와 작업 종류가
 * 이 값을 따로 계산하면 갈라진다 — 2026-09-13 에 실제로 갈라졌다. 읽기 전용으로
 * 넣은 요청의 프롬프트에는 이슈 계약이 없는데 기록에는 `issue_work` 로 남아,
 * "이슈로 한 작업"을 세면 하지도 않은 것이 섞였다. 한 곳에서 계산한다.
 */
export function effectiveRequestActions(config, authorization, accessCeiling = null) {
	const actions = effectiveAllowedActions(config, authorization);
	return accessCeiling === "read-only" ? actions.filter((action) => action !== "write" && action !== "execute") : actions;
}

/** 이 요청이 프로젝트를 바꿀 수 있어서 이슈 선행 계약을 지는가. */
export function carriesIssueContract(config, authorization, accessCeiling = null) {
	if (!config.workspace?.issueTracker) return false;
	const actions = effectiveRequestActions(config, authorization, accessCeiling);
	return actions.includes("write") || actions.includes("execute");
}

/**
 * 작업 요청은 이슈로 시작한다.
 *
 * 실을지 말지는 문장을 규칙으로 분류해서 정하지 않는다. 그런 분류기는 평범한 한
 * 문장에도 흔들린다. 대신 **이미 판정한 권한**으로 가른다. 이번 요청에 쓰기나
 * 실행이 허용되었다면 프로젝트를 바꿀 수 있는 요청이고, 그때만 계약이 실린다.
 * 읽기·회신뿐인 요청은 대화이므로 이슈를 만들지 않는다.
 *
 * 무엇이 대화이고 무엇이 작업인지의 마지막 판단은 모델이 한다. 계약이 묶는 것은
 * "바꾸기 전에 이슈가 있어야 한다"는 순서뿐이다.
 */
export function issueFirstContract({ repo, currentIssueUrl = null }) {
	const lines = [
		`Issue-first contract: This request may change the project, so the work is tracked in ${repo} before it happens.`,
		"1. Read the deterministic project context above, then search the project for the code and prior work this request touches.",
	];
	if (currentIssueUrl) {
		lines.push(
			`2. This conversation was last working on ${currentIssueUrl}. Check that it is still open and actually covers this request; if it does, continue it. If it is closed, or this request is different work, follow steps 3 and 4 instead and open a new one.`,
			`3. ${ISSUE_DECLARATION}`,
		);
	} else {
		lines.push(
			`2. Search the open issues of ${repo} for this work. If one already covers it, use that one instead of opening another.`,
			`3. If none covers it, create one in ${repo} stating the goal, the scope, and how completion is judged.`,
			`4. ${ISSUE_DECLARATION}`,
		);
	}
	lines.push(
		"If the request turns out to be a question rather than a change, answer it and do not open an issue.",
		"Follow the repository's issue-driven development workflow for the rest of the work; treat its phase gates as internal checkpoints.",
	);
	return lines.join("\n");
}

/** 회신에서 이슈를 밝히는 유일한 형식. 이 표지가 붙은 줄만 거둔다. */
export const ISSUE_MARKER = "Issue:";

const ISSUE_DECLARATION = `State the issue this work belongs to on the last line of your reply, in exactly this form with nothing else on that line: ${ISSUE_MARKER} <url>. Only that exact line is read back; a URL anywhere else in the reply, including a list of related issues, is ignored. If this turned out to be a question and you did no project work, do not write that line at all. Report the work you actually did and verified above it.`;

/**
 * 그 회신이 이 작업의 이슈를 밝히고 있는가.
 *
 * 주소처럼 생긴 줄을 받으면 인용과 선언을 가를 수 없다. 쓰기 권한을 가진 사람이
 * 질문을 했을 때 모델이 끝에 "관련 이슈"를 줄마다 늘어놓으면 그 마지막 것이 대화에
 * 매인다. 그래서 선언에 전용 표지를 둔다. 목록 줄도, 인용 줄도, 본문 중간의 주소도
 * 받지 않는다. 여러 줄이면 마지막 것을 쓴다.
 * 다른 저장소, 끌어오기 요청, 평문 http, 유사 호스트, 0번 이슈는 받지 않는다.
 */
export function harvestIssueUrl(text, repo) {
	if (typeof text !== "string" || typeof repo !== "string") return null;
	const lines = text.split(/\r?\n/);
	while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
	const lastLine = lines.at(-1);
	if (lastLine === undefined) return null;
	const pattern = new RegExp(`^[ \\t]*${ISSUE_MARKER}[ \\t]+https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/([1-9]\\d{0,8})/?[ \\t.]*$`, "i");
	const found = pattern.exec(lastLine);
	return found === null ? null : `https://github.com/${repo}/issues/${Number(found[1])}`;
}

export function boundRequestPrompt(userText, config, authorization = null, agentContextSnapshot = null, accessCeiling = null, { currentIssueUrl = null } = {}) {
	if (typeof userText !== "string" || !userText || userText.length > MAX_REQUEST_TEXT_LENGTH) throw new Error("Discord prompt is empty or too large");
	// 상한이 걸린 제출은 프롬프트에 적히는 행동 목록부터 낮춘다. 실행 프로필만
	// 낮추고 목록을 그대로 두면 모델이 허용된다고 읽는다.
	const allowedActions = effectiveRequestActions(config, authorization, accessCeiling);
	const backendId = config.backend?.selected ?? "codex";
	const executionProfile = currentExecutionProfile(config, backendId, authorization, { accessCeiling });
	const costProfile = config.backend?.profiles?.[backendId]?.costProfile ?? (backendId === "codex" ? "balanced" : "provider-default");
	const parts = [];
	if (agentContextSnapshot) parts.push(agentContextSnapshot.prefix, "");
	parts.push(`Persona: ${personaName(config, agentContextSnapshot)}`, personaInstructions(config, agentContextSnapshot), `Role: ${config.role.name}`);
	if (config.schemaVersion === 2) parts.push(trustedParticipantPolicy({ participantProfile: authorization?.participantProfile, effectiveActions: allowedActions }));
	if (config.schemaVersion === 2 && Array.isArray(config.workspace?.allowedPaths)) parts.push(`Allowed workspace paths: ${config.workspace.allowedPaths.join(", ")}. Use only these explicitly configured project paths; do not access other projects.`);
	parts.push(
		`Allowed actions: ${allowedActions.join(", ")}`,
		`Gateway execution contract: ${executionProfile.access}. Cost profile: ${costProfile}.`,
		executionProfile.access !== "read-only"
			? executionProfile.access === "danger-full-access"
				? "The host has verified the sole operator, DM-only Discord binding, project context, and trusted-local no-prompt policy for this request. This Gateway execution contract grants the current OS user's local access for the current job. It does not grant root authority or broaden the user's request. Use only the configured actions and the resources needed to complete that bounded request."
				: "The host has verified the operator, Discord binding, participant action intersection, project context, and no-prompt policy for this request. This Gateway execution contract is the explicit mutation authority for the current job. Do not downgrade it to read-only merely because no interactive session binding exists. Mutate only inside the configured workspace and granted actions."
			: "This job is read-only. Do not modify files, repository state, services, or external systems.",
		"Routine authority: A bounded user request authorizes its normal in-scope execution path. Treat workflow phase gates, including Understand, Scope, Plan, Sync, and Close, as internal checkpoints; do not ask the user to approve them.",
		"No approval click is available in this unattended session. Never request or wait for interactive approval.",
		"Authority limit: Ask only when a material unresolved choice would change the requested scope. If an action is outside the granted actions, stop safely and report the limitation without expanding authority or claiming completion.",
		"Current-turn truthfulness: Never promise to continue, resume, deploy, or report later after this job ends. In the current job, either perform and verify the concrete bounded work, or state the exact missing request, authority, credential, or external precondition. A prior failed or terminal job is not automatically resumed; do not imply that it is running.",
		"Communication: Reply in the language used by the user. Before tool work, provide a brief analysis and action plan as an intermediate update. During long work, report meaningful findings or phase changes before the final verified result. Do not repeat generic status text.",
		"Discord access: Do not access Discord directly. If the operator explicitly requests a separate DM, return exactly one discordDm JSON object; the gateway will deliver it only to the fixed workspace-owner recipient.",
	);
	if (carriesIssueContract(config, authorization, accessCeiling)) {
		parts.push("", issueFirstContract({ repo: config.workspace.issueTracker.repo, currentIssueUrl }));
	}
	parts.push("User request:", userText);
	return parts.join("\n");
}

function parseDiscordDmRequest(value) {
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1) return null;
		const request = parsed.discordDm;
		if (!request || typeof request !== "object" || Array.isArray(request)) return null;
		if (typeof request.content !== "string" || request.content.length < 1 || request.content.length > 2_000) return null;
		if (typeof request.successReply !== "string" || request.successReply.length < 1 || request.successReply.length > 2_000) return null;
		if (typeof request.failureReply !== "string" || request.failureReply.length < 1 || request.failureReply.length > 2_000) return null;
		return request;
	} catch { return null; }
}

function commandText(message, botUserId) {
	return normalizedDiscordText(String(message.content ?? ""), botUserId);
}

function normalizedDiscordText(value, botUserId) {
	return String(value)
		.replaceAll(`<@${botUserId}>`, "")
		.replaceAll(`<@!${botUserId}>`, "")
		.replace(/<@!?\d{17,20}>/g, "[Discord user mention]")
		.replace(/<@&\d{17,20}>/g, "[Discord role mention]")
		.replace(/<#\d{17,20}>/g, "[Discord channel mention]")
		.trim();
}

export class DiscordMessageRouter {
	constructor({ config, store, token, botUserId, cwd, allowedPaths = [cwd], agentContexts = null, runtimeRoot, instance = "default", agentContextSnapshot = null, runtimeRevision = null, recoveryCodec = null, projectStatus = null, runner = runBackendAttempt, deliver = deliverJobResult, directMessage = postDiscordDirectMessage, send = null, loadHistory = null, backendExecutables = {}, verifyRuntimeInputs = null, now = () => Date.now() }) {
		if (typeof send !== "function") throw new Error("confirmed Discord sender is required");
		if (verifyRuntimeInputs !== null && typeof verifyRuntimeInputs !== "function") throw new Error("runtime input verifier must be a function");
		if (config.schemaVersion === 2) {
			if (!agentContextSnapshot || agentContextSnapshot.schemaVersion !== 1 || typeof agentContextSnapshot.contextHash !== "string" || typeof agentContextSnapshot.workspaceRoot !== "string" || typeof agentContextSnapshot.agentId !== "string") throw new Error("schema v2 requires a valid agent context snapshot");
			if (!config.agentProfiles && (cwd !== agentContextSnapshot.workspaceRoot || config.workspace?.agentId !== agentContextSnapshot.agentId)) throw new Error("schema v2 workspace identity does not match its context snapshot");
		}
		this.config = config;
		this.store = store;
		this.token = token;
		this.botUserId = botUserId;
		this.cwd = cwd;
		this.allowedPaths = [...allowedPaths];
		this.runtimeRoot = runtimeRoot;
		this.instance = instance;
		this.agentContextSnapshot = agentContextSnapshot;
		this.agentContexts = agentContexts ?? { default: { cwd, allowedPaths: [...allowedPaths], snapshot: agentContextSnapshot } };
		if (runtimeRevision !== null && !/^[a-f0-9]{40}$/.test(runtimeRevision)) throw new Error("managed runtime revision is invalid");
		this.runtimeRevision = runtimeRevision;
		this.runner = runner;
		this.deliver = deliver;
		if (typeof directMessage !== "function") throw new Error("direct message sender is required");
		this.directMessage = directMessage;
		this.send = send;
		this.loadHistory = loadHistory;
		this.backendExecutables = backendExecutables;
		this.verifyRuntimeInputs = verifyRuntimeInputs;
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
		this.workItems = new Map();
		this.pendingDeliveries = new Set();
		this.pendingAcknowledgementFinalizers = new Set();
		this.pendingOutbound = new Set();
		this.outboundControllers = new Set();
		this.outboundClosed = false;
	}

	async onDispatch(type, data, sequence, { accessCeiling = null } = {}) {
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
		this.#verifyRuntimeInputs();
		const authorization = authorizeDiscordMessage({ message: data, bindings: this.config.discord.bindings, operatorUserIds: this.config.discord.operatorUserIds, participantProfiles: this.config.discord.participantProfiles, botUserId: this.botUserId, threadParents: this.threadParents });
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
		const queuedInScope = this.queue.filter((item) => item.scopeKey === authorization.scopeKey).length;
		if (this.queue.length >= MAX_QUEUED_TURNS || queuedInScope >= MAX_SCOPE_QUEUED_TURNS) {
			this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "rejected", reasonCode: "request_queue_full", dispatchSequence: sequence });
				void this.#sendControl({ token: this.token, channelId: authorization.scope.threadId ?? authorization.scope.channelId, botUserId: this.botUserId, content: "요청이 많아 이번 메시지를 처리하지 못했습니다. 잠시 뒤 다시 보내 주세요. / The request queue is full; please retry shortly.", nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise.catch(() => {});
			return { state: "rejected", reasonCode: "request_queue_full" };
		}
		let prompt;
		let currentRequest;
		try {
			currentRequest = discordRequestText(data, this.botUserId, { authorization, instance: this.instance });
			if (!currentRequest || currentRequest.length > MAX_REQUEST_TEXT_LENGTH) throw new Error("Discord prompt is empty or too large");
			const selected = this.#agentContext(authorization.binding);
			prompt = boundRequestPrompt(currentRequest, this.#profileConfig(authorization.binding), authorization, selected.snapshot, accessCeiling, { currentIssueUrl: this.#currentIssueUrl(authorization.scopeKey) });
		}
		catch {
			this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "rejected", reasonCode: "prompt_invalid", dispatchSequence: sequence });
			// 조용히 버리면 보낸 사람은 봇이 죽은 줄 안다. 큐가 찼을 때처럼 이유를 남긴다.
			void this.#sendControl({ token: this.token, channelId: authorization.scope.threadId ?? authorization.scope.channelId, botUserId: this.botUserId, content: "이 메시지에서 처리할 요청을 찾지 못했습니다. 요청할 내용을 글로 적어 주세요. / No actionable request was found in that message; please describe what you need in text.", nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise.catch(() => {});
			return { state: "rejected", reasonCode: "prompt_invalid" };
		}
		const jobId = randomUUID();
		const backendId = this.config.backend.selected;
		const adapter = getBackendAdapter(backendId);
		const channelId = authorization.scope.threadId ?? authorization.scope.channelId;
		const selected = this.#agentContext(authorization.binding);
		const authority = this.#authority(authorization, selected.snapshot);
		const executionProfile = this.#executionProfile(backendId, authority, accessCeiling);
		const commandOptions = this.#withBackendOptions(backendId, commandOptionsForProfile(executionProfile));
		const recoveryEnvelope = this.recoveryCodec?.seal(JSON.stringify({ schemaVersion: 2, currentRequest, channelId, scopeKey: authorization.scopeKey, executionProfile, accessCeiling, participantUserId: authorization.scope.authorId, bindingIdentity: authority.bindingIdentity, authorityRevision: authority.authorityRevision ?? null, configRevision: configurationRevision(this.config), contextHash: selected.snapshot?.contextHash ?? null, agentProfileId: authorization.binding.agentProfileId ?? "default", runtimeRevision: this.runtimeRevision })) ?? null;
		const revisionBase = this.config.schemaVersion === 2 ? `discord-v2-${executionProfile.access}` : "discord-v1";
		const managedRevisionBase = executionProfile.access === "read-only" ? "v2r" : "v2w";
		const jobRevision = this.runtimeRevision === null ? revisionBase : this.config.schemaVersion === 2 ? `${managedRevisionBase}:${this.runtimeRevision}` : `${revisionBase}:${this.runtimeRevision}`;
		const executionBinding = this.config.schemaVersion === 2 && executionProfile.access === "read-only" ? durableExecutionBinding({ config: this.config, instance: this.instance, agentContextSnapshot: selected.snapshot, participantUserId: authorization.scope.authorId, binding: authorization.binding, executionProfile }) : null;
		const ingress = this.store.acceptIngressAndCreateJob({ sourceMessageId, scopeKey: authorization.scopeKey, jobId, dispatchSequence: sequence, backendId, revision: jobRevision, backendCapabilities: adapter.capabilities, activityDetail: adapter.activityDetail, jobType: carriesIssueContract(this.#profileConfig(authorization.binding), authorization, accessCeiling) ? "issue_work" : "conversation", requestExcerpt: currentRequest,
			softSilenceMs: (this.config.runtime?.softSilenceSeconds ?? 120) * 1_000, recoveryEnvelope, executionBinding, now: this.#nowIso() });
		if (ingress.duplicate) return { state: "duplicate", jobId: ingress.jobId };
		const item = { jobId, backendId, prompt, currentRequest, channelId, scopeKey: authorization.scopeKey, sourceMessageId, allowedUserIds: authorization.binding.allowedUserIds, binding: authorization.binding, participantUserId: authorization.scope.authorId, authority, commandOptions, executionProfile, accessCeiling, agentContext: selected };
		this.workItems.set(jobId, item);
		this.#sendOperatorResponse(item);
		this.queue.push(item);
		this.#drain();
		void this.projectScope({ scopeKey: authorization.scopeKey, channelId }).catch(() => {});
		return { state: "accepted", jobId };
	}

	async submitOperatorRequest({ channelId, authorId, content, access = null }) {
		if (!/^\d{17,20}$/.test(channelId ?? "") || !/^\d{17,20}$/.test(authorId ?? "") || typeof content !== "string" || !content.trim() || content.length > 4_000) {
			return { state: "rejected", action: "submit", reasonCode: "invalid_operator_submission" };
		}
		const binding = this.config.discord.bindings.find((candidate) =>
			candidate.operatorActions === true
			&& candidate.canStartConversation === true
			&& candidate.allowedUserIds.includes(authorId)
			&& (candidate.threadId ?? candidate.channelId) === channelId);
		if (!binding || !this.config.discord.operatorUserIds.includes(authorId)) return { state: "rejected", action: "submit", reasonCode: "operator_binding_unavailable" };
		const data = {
			id: localOperatorSnowflake(this.now()),
			channel_id: channelId,
			...(binding.guildId ? { guild_id: binding.guildId } : {}),
			author: { id: authorId, bot: false },
			content: binding.respondWhen === "mentioned" ? `<@${this.botUserId}> ${content.trim()}` : content.trim(),
			mentions: binding.respondWhen === "mentioned" ? [{ id: this.botUserId }] : [],
		};
		// 상한은 낮추는 방향으로만 받는다. 다른 값이 오면 권한을 넓히려는 시도로 본다.
		if (access !== null && access !== "read-only") return { state: "rejected", action: "submit", reasonCode: "invalid_access_attenuation" };
		const result = await this.onDispatch("MESSAGE_CREATE", data, null, { accessCeiling: access });
		return { ...result, action: "submit", semantics: access === "read-only" ? "owner_controlled_read_only_submission" : "owner_controlled_operator_submission" };
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
		await this.#sendControl({ token: this.token, channelId, botUserId: this.botUserId, content, nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise;
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

	#commandOptions(backendId, authority = null) {
		return this.#withBackendOptions(backendId, commandOptionsForProfile(this.#executionProfile(backendId, authority)));
	}

	#withBackendOptions(backendId, options) {
		const profile = this.config.backend.profiles?.[backendId];
		const withCommon = {
			...options,
			...(profile?.model ? { model: profile.model } : {}),
			networkAccess: this.config.runtime?.networkAccess === true,
			credentialProfiles: [...(this.config.runtime?.credentialProfiles ?? [])],
		};
		return backendId === "codex" ? {
			...withCommon,
			costProfile: profile?.costProfile ?? "balanced",
			...(profile?.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
		} : withCommon;
	}

	/** 이 바인딩이 쓰는 이슈 저장소. 설정에 없으면 이슈 선행 계약도 없다. */
	#issueTracker(binding) {
		return this.#profileConfig(binding)?.workspace?.issueTracker ?? null;
	}

	/** 이 대화가 지금 물고 있는 이슈. 읽기가 실패해도 요청을 막지는 않는다. */
	#currentIssueUrl(scopeKey) {
		if (typeof scopeKey !== "string" || !scopeKey) return null;
		try { return this.store.currentScopeIssue(scopeKey); } catch { return null; }
	}

	/**
	 * 회신이 말한 이슈 주소를 거둔다.
	 *
	 * 설정된 저장소의 이슈만 받는다. 모델이 남의 저장소 주소를 적어도 그것으로
	 * 이 대화가 매이지 않는다. 거두기가 실패해도 회신 전달은 막지 않는다.
	 */
	#recordIssueFromResult(item, finalContent) {
		const tracker = this.#issueTracker(item.binding);
		if (tracker === null) return null;
		// 계약을 지고 실행한 작업에서만 거둔다. 트래커가 설정되었다는 이유로 모든
		// 회신에서 거두면, 읽기 전용 대화가 관련 이슈를 언급만 해도 그 이슈가
		// 대화에 매이고 다음 쓰기 요청이 엉뚱한 이슈를 잇는다.
		if (!carriesIssueContract(this.#profileConfig(item.binding), item.authority, item.accessCeiling ?? null)) return null;
		const issueUrl = harvestIssueUrl(finalContent, tracker.repo);
		if (issueUrl === null) return null;
		try { this.store.recordJobIssue({ jobId: item.jobId, scopeKey: item.scopeKey ?? null, issueUrl }); }
		catch { return null; }
		return issueUrl;
	}

	#profileConfig(binding) {
		const profile = binding?.agentProfileId ? this.config.agentProfiles?.[binding.agentProfileId] : null;
		return profile ? { ...this.config, workspace: profile.workspace, persona: profile.persona } : this.config;
	}

	#agentContext(binding) {
		const id = binding?.agentProfileId ?? "default";
		const context = this.agentContexts[id];
		if (!context) throw new Error("binding agent context is unavailable");
		return context;
	}

	#authority(authorization, snapshot = this.agentContextSnapshot) {
		if (this.config.schemaVersion !== 2) return authorization;
		const identity = discordBindingIdentity(authorization.binding);
		const actions = effectiveAllowedActions(this.config, authorization);
		const authorityRevision = participantAuthorityRevision({
			workspaceIdentity: `${snapshot?.agentId}\0${snapshot?.workspaceRoot}`,
			bindingIdentity: identity,
			participantUserId: authorization.scope.authorId,
			participantProfile: authorization.participantProfile,
			effectiveActions: actions,
			permissionProfileEpoch: this.config.runtime?.permissionProfileEpoch ?? "default",
		});
		return { ...authorization, bindingIdentity: identity, authorityRevision, contextHash: snapshot?.contextHash };
	}

	#recoveryAuthority(payload) {
		if (this.config.schemaVersion !== 2) throw new Error("legacy recovery requires review");
		if (payload?.schemaVersion !== 2 || typeof payload.participantUserId !== "string" || typeof payload.bindingIdentity !== "string") throw new Error("recovery authority is missing");
		if (!/^[a-f0-9]{40}$/.test(payload.runtimeRevision ?? "") || payload.runtimeRevision !== this.runtimeRevision) throw new Error("recovery runtime changed");
		const binding = this.config.discord.bindings.find((candidate) => discordBindingIdentity(candidate) === payload.bindingIdentity && candidate.allowedUserIds.includes(payload.participantUserId));
		const participantProfile = this.config.discord.participantProfiles?.[payload.participantUserId];
		if (!binding || !participantProfile) throw new Error("recovery participant authority changed");
		const selected = this.#agentContext(binding);
		if ((payload.agentProfileId ?? "default") !== (binding.agentProfileId ?? "default") || payload.contextHash !== selected.snapshot?.contextHash || payload.configRevision !== configurationRevision(this.config)) throw new Error("recovery configuration changed");
		const authorization = {
			allowed: true,
			binding,
			participantProfile,
			isOperator: this.config.discord.operatorUserIds.includes(payload.participantUserId) && binding.operatorActions === true,
			scope: { authorId: payload.participantUserId },
		};
		const authority = this.#authority(authorization, selected.snapshot);
		if (payload.authorityRevision !== authority.authorityRevision) throw new Error("recovery participant authority changed");
		return authority;
	}

	#executionProfile(backendId, authority = null, accessCeiling = null) {
		return currentExecutionProfile(this.config, backendId, authority, { accessCeiling });
	}

	#nowIso() {
		return new Date(this.now()).toISOString();
	}

	#verifyRuntimeInputs() {
		try { this.verifyRuntimeInputs?.(); }
		catch {
			const error = new Error("Discord runtime inputs changed; restart is required");
			error.code = "context_changed_restart_required";
			throw error;
		}
	}

	#noProgressInterventionMs() {
		return (this.config.runtime?.noProgressInterventionSeconds ?? this.config.runtime?.softSilenceSeconds ?? 120) * 1_000;
	}

	#noProgressIsDue(job, nowMs) {
		return noProgressInterventionDue(job, nowMs, this.#noProgressInterventionMs());
	}

	#runOutbound(operation) {
		const controller = new AbortController();
		if (this.outboundClosed) controller.abort("shutdown");
		this.outboundControllers.add(controller);
		let pending;
		pending = Promise.resolve()
			.then(() => operation(controller.signal))
			.finally(() => {
				this.outboundControllers.delete(controller);
				this.pendingOutbound.delete(pending);
			});
		this.pendingOutbound.add(pending);
		return { controller, promise: pending };
	}

	#sendControl(input) {
		return this.#runOutbound((signal) => this.send({ ...input, signal }));
	}

	projectScope(input) {
		if (!this.projectStatus) return Promise.resolve();
		return this.#runOutbound((signal) => this.projectStatus({ ...input, signal })).promise;
	}

	#sendOperatorResponse(item) {
		const deadlineMs = (this.config.runtime?.operatorResponseSeconds ?? 30) * 1_000;
		let deadline;
		let finalizeMissed;
		const outbound = this.#sendControl({ token: this.token, channelId: item.channelId, botUserId: this.botUserId, content: "[메시지 받음]", nonce: randomUUID().replaceAll("-", "").slice(0, 24) });
		const sendOutcome = outbound.promise
			.then((receipt) => receipt?.state === "confirmed" ? "operator_response_sent" : "operator_response_missed", () => "operator_response_missed");
		const deadlineOutcome = new Promise((resolveDeadline) => {
			finalizeMissed = () => {
				outbound.controller.abort("operator_response_timeout");
				resolveDeadline("operator_response_missed");
			};
			deadline = setTimeout(finalizeMissed, deadlineMs);
			deadline.unref?.();
		});
		this.pendingAcknowledgementFinalizers.add(finalizeMissed);
		const pending = Promise.race([sendOutcome, deadlineOutcome])
			.then((kind) => {
				try { this.store.recordEvent({ jobId: item.jobId, source: "helper", kind, safePayload: {} }); } catch {}
			})
			.finally(() => {
				clearTimeout(deadline);
				this.pendingAcknowledgementFinalizers.delete(finalizeMissed);
				this.pendingDeliveries.delete(pending);
			});
		this.pendingDeliveries.add(pending);
	}

	#operatorResponseFinalized(jobId) {
		const events = this.store.getJob(jobId)?.events ?? [];
		return events.some((event) => event.kind === "operator_response_sent" || event.kind === "operator_response_missed");
	}

	async #run(item) {
		const controller = new AbortController();
		this.controllers.set(item.jobId, controller);
		try {
			if (controller.signal.aborted) return;
			this.#verifyRuntimeInputs();
			const currentProfile = this.#executionProfile(item.backendId, item.authority, item.accessCeiling ?? null);
			if (!sameExecutionProfile(item.executionProfile ?? currentProfile, currentProfile)) {
				this.store.recordEvent({ jobId: item.jobId, source: "helper", kind: "profile_replaced", safePayload: {} });
				item = { ...item, executionProfile: currentProfile, commandOptions: this.#withBackendOptions(item.backendId, commandOptionsForProfile(currentProfile)) };
			}
			let prompt = item.prompt;
			if (this.loadHistory && item.sourceMessageId) {
				let loaded;
				try { loaded = await this.loadHistory({ token: this.token, channelId: item.channelId, beforeMessageId: item.sourceMessageId, botUserId: this.botUserId, allowedUserIds: item.allowedUserIds, participantProfiles: this.config.discord.participantProfiles, requesterUserId: item.participantUserId, historyVisibility: item.binding?.historyVisibility ?? "shared", signal: controller.signal }); }
				catch (error) { if (error && typeof error === "object") error.code = "discord_history_load_failed"; throw error; }
				if (loaded?.state === "loaded") prompt = promptWithDiscordConversation(prompt, loaded.history, item.currentRequest);
			}
			const selected = item.agentContext ?? this.#agentContext(item.binding);
			if (selected.snapshot) verifyAgentContextBeforeAttempt(selected.snapshot);
			const preSpawnCheck = this.verifyRuntimeInputs || selected.snapshot ? () => {
				this.#verifyRuntimeInputs();
				if (selected.snapshot) verifyAgentContextBeforeAttempt(selected.snapshot);
			} : null;
			const result = await this.runner({ store: this.store, jobId: item.jobId, backendId: item.backendId, prompt, cwd: selected.cwd, allowedPaths: selected.allowedPaths, runtimeRoot: this.runtimeRoot, executable: this.backendExecutables[item.backendId], commandOptions: item.commandOptions ?? this.#commandOptions(item.backendId, item.authority), executionProfile: item.executionProfile, signal: controller.signal, preSpawnCheck });
			if (result.backendOutcome !== "success") {
				await this.#reportFailure(item);
				return;
			}
			if (!result.transientResult) throw new Error("backend returned no deliverable final result");
			let finalContent = result.transientResult;
			const dmRequest = parseDiscordDmRequest(finalContent);
			if (dmRequest) {
				const recipient = proactiveDmRecipient(this.config);
				let receipt = { state: "failed", reasonCode: recipient ? "dm_delivery_failed" : "fixed_recipient_not_authorized" };
				if (recipient && effectiveAllowedActions(this.config, item.authority).includes("reply")) receipt = await this.directMessage({ token: this.token, userId: recipient, content: dmRequest.content, nonce: randomUUID().replaceAll("-", "").slice(0, 24), botUserId: this.botUserId, signal: controller.signal });
				finalContent = receipt.state === "confirmed" ? dmRequest.successReply : dmRequest.failureReply;
			}
			this.#recordIssueFromResult(item, finalContent);
			await this.deliver({ store: this.store, jobId: item.jobId, attemptId: result.attemptId, token: this.token, botUserId: this.botUserId, channelId: item.channelId, content: finalContent, signal: controller.signal });
		} catch (error) {
			const job = this.store.getJob(item.jobId);
			if (job && !["failed", "cancelled", "completed", "recovery_review"].includes(job.lifecycle)) {
				if (controller.signal.aborted && controller.signal.reason === "operator_cancel") {
					try { this.store.recordEvent({ jobId: item.jobId, attemptId: job.attemptId, source: "helper", kind: "cancelled", safePayload: {} }); } catch {}
				} else {
					const reasonCode = new Set(["context_changed_restart_required", "discord_history_load_failed", "backend_version_probe_failed", "backend_authentication_failed", "backend_invocation_invalid", "backend_spawn_failed"]).has(error?.code) ? error.code : "internal_error";
					try { this.store.recordEvent({ jobId: item.jobId, attemptId: job.attemptId, source: "helper", kind: "failed", safePayload: { reasonCode } }); } catch {}
				}
			}
			await this.#reportFailure(item);
		} finally {
			this.controllers.delete(item.jobId);
			this.workItems.delete(item.jobId);
			const job = this.store.getJob(item.jobId, { includeEvents: false });
				if (job?.scopeKey) void this.projectScope({ scopeKey: job.scopeKey, channelId: item.channelId }).catch(() => {});
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
				await this.#sendControl({ token: this.token, channelId: item.channelId, botUserId: this.botUserId, content: `작업을 완료하지 못했습니다. ${detail}\n작업 ID: ${item.jobId}`, nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise;
		} catch {}
	}

	async waitForIdle({ includeDeliveries = true } = {}) {
		while (this.running > 0 || this.queue.length > 0 || (includeDeliveries && this.pendingDeliveries.size > 0)) await new Promise((resolve) => setTimeout(resolve, 5));
	}

	cancelJob(jobId) {
		const queuedIndex = this.queue.findIndex((item) => item.jobId === jobId);
		if (queuedIndex >= 0) {
			this.queue.splice(queuedIndex, 1);
			this.workItems.delete(jobId);
			this.store.recordEvent({ jobId, source: "helper", kind: "cancel_requested", safePayload: {} });
			this.store.recordEvent({ jobId, source: "helper", kind: "cancelled", safePayload: {} });
			return { state: "accepted", action: "cancel", jobId, target: "queued" };
		}
		const controller = this.controllers.get(jobId);
		if (!controller || controller.signal.aborted) return { state: "rejected", action: "cancel", jobId, reasonCode: "job_not_active" };
		const job = this.store.getJob(jobId, { includeEvents: false });
		this.store.recordEvent({ jobId, attemptId: job?.attemptId ?? undefined, source: "helper", kind: "cancel_requested", safePayload: {} });
		controller.abort("operator_cancel");
		return { state: "accepted", action: "cancel", jobId, target: "running" };
	}

	replaceJob(jobId, { action = "restart", amendment = null } = {}) {
		if (!new Set(["restart", "amend"]).has(action)) return { state: "rejected", action, jobId, reasonCode: "invalid_control_action" };
		if (action === "amend" && (typeof amendment !== "string" || !amendment.trim() || amendment.length > 4_000)) return { state: "rejected", action, jobId, reasonCode: "amendment_invalid" };
		if (!this.recoveryCodec) return { state: "rejected", action, jobId, reasonCode: "recovery_codec_unavailable" };
		const sourceJob = this.store.getJob(jobId, { includeEvents: false });
		if (!sourceJob) return { state: "rejected", action, jobId, reasonCode: "job_not_found" };
		const activeItem = this.workItems.get(jobId) ?? this.queue.find((candidate) => candidate.jobId === jobId);
		let item = activeItem;
		if (!item) {
			if (sourceJob.lifecycle !== "failed") return { state: "rejected", action, jobId, reasonCode: "job_not_restartable" };
			const envelope = this.store.loadJobRecovery(jobId);
			if (!envelope) return { state: "rejected", action, jobId, reasonCode: "recovery_envelope_unavailable" };
			try {
				const payload = JSON.parse(this.recoveryCodec.open(envelope));
				const accessCeiling = payload.accessCeiling ?? null;
				if (typeof payload.currentRequest !== "string" || !payload.currentRequest || payload.currentRequest.length > MAX_REQUEST_TEXT_LENGTH || !/^\d{17,20}$/.test(payload.channelId)) throw new Error("recovery payload is invalid");
				const authority = this.#recoveryAuthority(payload);
				const binding = authority.binding;
				const agentContext = this.#agentContext(binding);
				const executionProfile = this.#executionProfile(sourceJob.backendId, authority, accessCeiling);
				if (!sameExecutionProfile(payload.executionProfile, executionProfile)) throw new Error("recovery execution profile changed");
				item = {
					jobId,
					backendId: sourceJob.backendId,
					currentRequest: payload.currentRequest,
					channelId: payload.channelId,
					scopeKey: typeof payload.scopeKey === "string" ? payload.scopeKey : null,
					participantUserId: payload.participantUserId,
					authority,
					commandOptions: this.#withBackendOptions(sourceJob.backendId, commandOptionsForProfile(executionProfile)),
					executionProfile,
					binding,
					agentContext,
				};
			} catch {
				return { state: "rejected", action, jobId, reasonCode: "recovery_binding_changed" };
			}
		}
		const currentRequest = action === "amend" ? `${item.currentRequest}\n\nOperator amendment:\n${amendment.trim()}` : item.currentRequest;
		if (currentRequest.length > MAX_REQUEST_TEXT_LENGTH) return { state: "rejected", action, jobId, reasonCode: "amendment_too_large" };
		const replacementJobId = randomUUID();
		const selected = item.agentContext ?? this.#agentContext(item.binding);
		const replacementPrompt = boundRequestPrompt(currentRequest, this.#profileConfig(item.binding), item.authority, selected.snapshot, item.accessCeiling ?? null, { currentIssueUrl: this.#currentIssueUrl(item.scopeKey) });
		const replacementEnvelope = this.recoveryCodec.seal(JSON.stringify({ schemaVersion: 2, currentRequest, channelId: item.channelId, scopeKey: item.scopeKey, executionProfile: item.executionProfile, accessCeiling: item.accessCeiling ?? null, participantUserId: item.participantUserId, bindingIdentity: item.authority?.bindingIdentity, authorityRevision: item.authority?.authorityRevision ?? null, configRevision: configurationRevision(this.config), contextHash: selected.snapshot?.contextHash ?? null, agentProfileId: item.binding?.agentProfileId ?? "default", runtimeRevision: this.runtimeRevision }));
		this.store.createJob({ jobId: replacementJobId, backendId: item.backendId, revision: sourceJob.revision, backendCapabilities: sourceJob.backendCapabilities, activityDetail: sourceJob.activityDetail, jobType: carriesIssueContract(this.#profileConfig(item.binding), item.authority, item.accessCeiling ?? null) ? "issue_work" : "conversation", scopeKey: item.scopeKey, softSilenceMs: sourceJob.softSilenceMs, recoveryEnvelope: replacementEnvelope, executionBinding: sourceJob.executionBinding });
		const replacement = { ...item, jobId: replacementJobId, prompt: replacementPrompt, currentRequest, sourceMessageId: null };
		this.workItems.set(replacementJobId, replacement);
		if (activeItem) this.cancelJob(jobId);
		else this.store.deleteJobRecovery(jobId);
		this.queue.push(replacement);
		this.#drain();
		return { state: "accepted", action, jobId, replacementJobId, semantics: activeItem ? "cancel_and_queue_replacement" : "terminal_retry_from_encrypted_request" };
	}

	async watchdog({ nowMs = this.now() } = {}) {
		if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("watchdog time must be a non-negative safe integer");
		const outcome = { noProgress: 0 };
		for (const job of this.store.listOperationalJobs({ nowMs })) {
			if (["completed", "failed", "cancelled", "recovery_review"].includes(job.lifecycle)) continue;
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
		this.outboundClosed = true;
		for (const controller of this.outboundControllers) controller.abort("shutdown");
		for (const controller of this.controllers.values()) controller.abort("recovery");
		for (const item of this.queue.splice(0)) {
			try { this.store.recordEvent({ jobId: item.jobId, source: "recovery", kind: "recovered", safePayload: { recoveryAction: "safe_retry" } }); } catch {}
		}
		for (const finalizeMissed of [...this.pendingAcknowledgementFinalizers]) finalizeMissed();
		await this.waitForIdle();
		await Promise.allSettled([...this.pendingOutbound]);
	}

	resumeRecovered(items, { autoRetry = false } = {}) {
		if (items.length > 0 && !this.recoveryCodec) throw new Error("recovery codec is unavailable");
		for (const item of items) {
			try {
				const payload = JSON.parse(this.recoveryCodec.open(item.envelope));
				const accessCeiling = payload.accessCeiling ?? null;
				if (payload.mode === "coordinator" || payload.mode === "coordinator_result") {
					throw new Error("coordinator recovery is withdrawn");
				}
					if (typeof payload.currentRequest !== "string" || !payload.currentRequest || payload.currentRequest.length > MAX_REQUEST_TEXT_LENGTH || !/^\d{17,20}$/.test(payload.channelId)) throw new Error("recovery payload is invalid");
					const authority = this.#recoveryAuthority(payload);
					const binding = authority.binding;
					const agentContext = this.#agentContext(binding);
					const prompt = boundRequestPrompt(payload.currentRequest, this.#profileConfig(binding), authority, agentContext.snapshot, accessCeiling, { currentIssueUrl: this.#currentIssueUrl(typeof payload.scopeKey === "string" ? payload.scopeKey : null) });
				const executionProfile = this.#executionProfile(item.backendId, authority, accessCeiling);
				const profileChanged = !sameExecutionProfile(payload.executionProfile, executionProfile);
				if (this.config.schemaVersion === 2) {
					if (!autoRetry || profileChanged || executionProfile.access !== "read-only") throw new Error("automatic recovery is not allowed for this job");
				} else throw new Error("legacy recovery requires review");
					const recovered = { jobId: item.jobId, backendId: item.backendId, prompt, currentRequest: payload.currentRequest, channelId: payload.channelId, scopeKey: typeof payload.scopeKey === "string" ? payload.scopeKey : null, participantUserId: payload.participantUserId, authority, binding, agentContext, commandOptions: this.#withBackendOptions(item.backendId, commandOptionsForProfile(executionProfile)), executionProfile };
				if (!this.#operatorResponseFinalized(item.jobId)) this.#sendOperatorResponse(recovered);
				this.workItems.set(item.jobId, recovered);
				this.queue.push(recovered);
			} catch {
				this.store.recordEvent({ jobId: item.jobId, source: "recovery", kind: "recovery_review_required", safePayload: {} });
			}
		}
		this.#drain();
	}
}
