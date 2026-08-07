import { safeIdentifier } from "./sanitize.mjs";
import { createHash } from "node:crypto";

const AUTHORIZATION_MODES = new Set(["managed", "never"]);

function digest(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function discordBindingIdentity(binding) {
	return digest({
		kind: binding.kind,
		guildId: binding.guildId ?? null,
		channelId: binding.channelId ?? null,
		threadId: binding.threadId ?? null,
		userId: binding.userId ?? null,
		allowedUserIds: [...binding.allowedUserIds].sort(),
		respondWhen: binding.respondWhen,
		canStartConversation: binding.canStartConversation === true,
		operatorActions: binding.operatorActions === true,
		historyVisibility: binding.historyVisibility ?? "shared",
	});
}

export function configurationRevision(config) {
	return digest({
		backend: config.backend.selected,
		model: config.backend.profiles?.[config.backend.selected]?.model ?? null,
		costProfile: config.backend.profiles?.[config.backend.selected]?.costProfile ?? null,
		reasoningEffort: config.backend.profiles?.[config.backend.selected]?.reasoningEffort ?? null,
		persona: config.persona,
		roleName: config.role.name,
		approvalPolicy: config.runtime?.approvalPolicy ?? null,
		autoRetry: config.recovery?.autoRetry === true,
		networkAccess: config.runtime?.networkAccess === true,
		credentialProfiles: [...(config.runtime?.credentialProfiles ?? [])].sort(),
	});
}

export function durableExecutionBinding({ config, instance = "default", agentContextSnapshot, participantUserId, binding, executionProfile }) {
	if (config?.schemaVersion !== 2 || agentContextSnapshot?.schemaVersion !== 1 || executionProfile?.access !== "read-only") throw new Error("canary execution binding requires schema v2 read-only execution");
	safeIdentifier(instance, "instance");
	safeIdentifier(agentContextSnapshot.agentId, "agentId");
	if (!/^\d{17,20}$/.test(participantUserId ?? "") || /^0+$/.test(participantUserId)) throw new Error("participantUserId must be a Discord snowflake");
	const participantProfile = config.discord.participantProfiles?.[participantUserId];
	if (!participantProfile || !binding?.allowedUserIds?.includes(participantUserId)) throw new Error("canary participant binding is unavailable");
	const bindingIdentity = discordBindingIdentity(binding);
	const effectiveActions = effectiveAllowedActions(config, { binding, participantProfile, isOperator: config.discord.operatorUserIds.includes(participantUserId) && binding.operatorActions === true });
	const authorityRevision = participantAuthorityRevision({
		workspaceIdentity: `${agentContextSnapshot.agentId}\0${agentContextSnapshot.workspaceRoot}`,
		bindingIdentity,
		participantUserId,
		participantProfile,
		effectiveActions,
		permissionProfileEpoch: config.runtime?.permissionProfileEpoch ?? "default",
	});
	if (executionProfile.authorityRevision !== authorityRevision || executionProfile.contextHash !== agentContextSnapshot.contextHash) throw new Error("execution profile is not bound to current host authority");
	return Object.freeze({
		schemaVersion: 1,
		configSchemaVersion: 2,
		instance,
		agentId: agentContextSnapshot.agentId,
		workspaceIdentity: digest({ agentId: agentContextSnapshot.agentId, workspaceRoot: agentContextSnapshot.workspaceRoot }),
		contextHash: agentContextSnapshot.contextHash,
		participantUserId,
		bindingIdentity,
		authorityRevision,
		access: "read-only",
		configRevision: configurationRevision(config),
	});
}

export function validateDurableExecutionBinding(value) {
	const keys = "access,agentId,authorityRevision,bindingIdentity,configRevision,configSchemaVersion,contextHash,instance,participantUserId,schemaVersion,workspaceIdentity";
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys
		|| value.schemaVersion !== 1 || value.configSchemaVersion !== 2 || value.access !== "read-only"
		|| !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.instance ?? "") || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.agentId ?? "")
		|| !/^\d{17,20}$/.test(value.participantUserId ?? "") || /^0+$/.test(value.participantUserId)
		|| [value.workspaceIdentity, value.contextHash, value.bindingIdentity, value.authorityRevision, value.configRevision].some((item) => !/^[a-f0-9]{64}$/.test(item ?? ""))) throw new Error("durable execution binding is invalid");
	return Object.freeze({ ...value });
}

export function recomputeDurableExecutionBinding({ config, instance = "default", agentContextSnapshot, storedBinding }) {
	const expected = validateDurableExecutionBinding(storedBinding);
	const binding = config?.discord?.bindings?.find((candidate) => discordBindingIdentity(candidate) === expected.bindingIdentity && candidate.allowedUserIds.includes(expected.participantUserId));
	const participantProfile = config?.discord?.participantProfiles?.[expected.participantUserId];
	if (!binding || !participantProfile) throw new Error("stored canary participant binding is no longer current");
	const effectiveActions = effectiveAllowedActions(config, { binding, participantProfile, isOperator: config.discord.operatorUserIds.includes(expected.participantUserId) && binding.operatorActions === true });
	const authorityRevision = participantAuthorityRevision({
		workspaceIdentity: `${agentContextSnapshot.agentId}\0${agentContextSnapshot.workspaceRoot}`,
		bindingIdentity: expected.bindingIdentity,
		participantUserId: expected.participantUserId,
		participantProfile,
		effectiveActions,
		permissionProfileEpoch: config.runtime?.permissionProfileEpoch ?? "default",
	});
	const authority = { binding, participantProfile, isOperator: config.discord.operatorUserIds.includes(expected.participantUserId) && binding.operatorActions === true, authorityRevision, contextHash: agentContextSnapshot.contextHash };
	const executionProfile = currentExecutionProfile(config, config.backend.selected, authority);
	return durableExecutionBinding({ config, instance, agentContextSnapshot, participantUserId: expected.participantUserId, binding, executionProfile });
}

export function effectiveAllowedActions(config, authority = null) {
	const requiresApproval = new Set(config.role.requiresApproval ?? []);
	const globalActions = config.role.allowedActions.filter((action) => !requiresApproval.has(action));
	if (!authority) {
		if (config.schemaVersion === 2) throw new Error("schema v2 execution requires participant authority");
		return globalActions;
	}
	const participantActions = authority.participantProfile?.allowedActions;
	if (config.schemaVersion === 2 && !Array.isArray(participantActions)) throw new Error("participant profile is required for schema v2 execution");
	const allowed = new Set(participantActions ?? globalActions);
	const operatorMutation = authority.isOperator === true && authority.binding?.operatorActions === true;
	const mutationBundle = allowed.has("write") && allowed.has("execute")
		&& globalActions.includes("write") && globalActions.includes("execute")
		&& operatorMutation;
	return globalActions.filter((action) => allowed.has(action) && (mutationBundle || (action !== "write" && action !== "execute")));
}

function requestedMutation(config, authority) {
	const actions = effectiveAllowedActions(config, authority);
	return actions.includes("write") || actions.includes("execute");
}

function optionalDigest(value, label) {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
	return value;
}

export function participantAuthorityRevision({ workspaceIdentity, bindingIdentity, participantUserId, participantProfile, effectiveActions, permissionProfileEpoch }) {
	for (const [value, label] of [[workspaceIdentity, "workspaceIdentity"], [bindingIdentity, "bindingIdentity"], [participantUserId, "participantUserId"], [permissionProfileEpoch, "permissionProfileEpoch"]]) {
		if (typeof value !== "string" || !value) throw new Error(`${label} is required for participant authority revision`);
	}
	if (!/^\d{17,20}$/.test(participantUserId) || /^0+$/.test(participantUserId)) throw new Error("participantUserId must be a Discord snowflake");
	if (!participantProfile || typeof participantProfile.label !== "string" || typeof participantProfile.relationship !== "string") throw new Error("participantProfile is required for participant authority revision");
	if (!Array.isArray(participantProfile.allowedActions) || !Array.isArray(effectiveActions)) throw new Error("effectiveActions is required for participant authority revision");
	const canonical = JSON.stringify({
		workspaceIdentity,
		bindingIdentity,
		participantUserId,
		participantProfile: { label: participantProfile.label, relationship: participantProfile.relationship, allowedActions: [...participantProfile.allowedActions].sort() },
		effectiveActions: [...effectiveActions].sort(),
		permissionProfileEpoch,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

function validExecutionProfile(profile) {
	return Boolean(profile)
		&& new Set(["codex", "claude", "opencode"]).has(profile.backendId)
		&& AUTHORIZATION_MODES.has(profile.authorizationMode)
		&& new Set(["read-only", "workspace-write"]).has(profile.access)
		&& typeof profile.permissionProfileEpoch === "string"
		&& /^[A-Za-z0-9_.:-]{1,64}$/.test(profile.permissionProfileEpoch)
		&& (profile.authorityRevision === undefined || /^[a-f0-9]{64}$/.test(profile.authorityRevision))
		&& (profile.contextHash === undefined || /^[a-f0-9]{64}$/.test(profile.contextHash))
		&& !(profile.authorizationMode === "managed" && profile.access !== "read-only");
}

export function currentExecutionProfile(config, backendId, authority = null) {
	if (!new Set(["codex", "claude", "opencode"]).has(backendId)) throw new Error("unsupported execution backend");
	const authorizationMode = config.runtime?.approvalPolicy ?? "never";
	if (!AUTHORIZATION_MODES.has(authorizationMode)) throw new Error("unsupported execution approval policy");
	const permissionProfileEpoch = config.runtime?.permissionProfileEpoch ?? "default";
	safeIdentifier(permissionProfileEpoch, "permissionProfileEpoch");
	const access = authorizationMode === "never" && requestedMutation(config, authority) ? "workspace-write" : "read-only";
	const profile = { backendId, permissionProfileEpoch, authorizationMode, access };
	const authorityRevision = optionalDigest(authority?.authorityRevision, "authorityRevision");
	const contextHash = optionalDigest(authority?.contextHash, "contextHash");
	if (authorityRevision) profile.authorityRevision = authorityRevision;
	if (contextHash) profile.contextHash = contextHash;
	return profile;
}

export function commandOptionsForProfile(profile) {
	if (!validExecutionProfile(profile)) throw new Error("invalid execution profile");
	if (profile.backendId === "codex") return { sandbox: profile.access, approvalPolicy: "never" };
	if (profile.backendId === "opencode") return { auto: profile.access === "workspace-write", approvalPolicy: "never" };
	return { permissionMode: profile.access === "workspace-write" ? "bypassPermissions" : "plan", approvalPolicy: "never" };
}

export function sameExecutionProfile(left, right) {
	if (!validExecutionProfile(left) || !validExecutionProfile(right)) return false;
	return left.backendId === right.backendId
		&& left.permissionProfileEpoch === right.permissionProfileEpoch
		&& left.authorizationMode === right.authorizationMode
		&& left.access === right.access
		&& left.authorityRevision === right.authorityRevision
		&& left.contextHash === right.contextHash;
}
