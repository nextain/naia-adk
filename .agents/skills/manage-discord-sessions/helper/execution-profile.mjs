import { safeIdentifier } from "./sanitize.mjs";

const AUTHORIZATION_MODES = new Set(["managed", "never"]);

export function effectiveAllowedActions(config) {
	const requiresApproval = new Set(config.role.requiresApproval ?? []);
	return config.role.allowedActions.filter((action) => !requiresApproval.has(action));
}

function requestedMutation(config) {
	const actions = effectiveAllowedActions(config);
	return actions.includes("write") || actions.includes("execute");
}

function validExecutionProfile(profile) {
	return Boolean(profile)
		&& new Set(["codex", "claude"]).has(profile.backendId)
		&& AUTHORIZATION_MODES.has(profile.authorizationMode)
		&& new Set(["read-only", "workspace-write"]).has(profile.access)
		&& typeof profile.permissionProfileEpoch === "string"
		&& /^[A-Za-z0-9_.:-]{1,64}$/.test(profile.permissionProfileEpoch)
		&& !(profile.authorizationMode === "managed" && profile.access !== "read-only");
}

export function currentExecutionProfile(config, backendId) {
	if (!new Set(["codex", "claude"]).has(backendId)) throw new Error("unsupported execution backend");
	const authorizationMode = config.runtime?.approvalPolicy ?? "never";
	if (!AUTHORIZATION_MODES.has(authorizationMode)) throw new Error("unsupported execution approval policy");
	const permissionProfileEpoch = config.runtime?.permissionProfileEpoch ?? "default";
	safeIdentifier(permissionProfileEpoch, "permissionProfileEpoch");
	const access = authorizationMode === "never" && requestedMutation(config) ? "workspace-write" : "read-only";
	return { backendId, permissionProfileEpoch, authorizationMode, access };
}

export function commandOptionsForProfile(profile) {
	if (!validExecutionProfile(profile)) throw new Error("invalid execution profile");
	if (profile.backendId === "codex") return { sandbox: profile.access, approvalPolicy: "never" };
	return { permissionMode: profile.access === "workspace-write" ? "dontAsk" : "plan", settingSources: "project", approvalPolicy: "never" };
}

export function sameExecutionProfile(left, right) {
	if (!validExecutionProfile(left) || !validExecutionProfile(right)) return false;
	return left.backendId === right.backendId
		&& left.permissionProfileEpoch === right.permissionProfileEpoch
		&& left.authorizationMode === right.authorizationMode
		&& left.access === right.access;
}
