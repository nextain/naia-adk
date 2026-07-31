import { resolve } from "node:path";

const INSTANCE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function normalizeMessengerInstance(value = "default") {
	const instance = String(value || "default");
	if (!INSTANCE_PATTERN.test(instance)) throw new Error("messenger instance must be a lowercase identifier");
	return instance;
}

export function messengerInstancePaths(adkRoot, value = "default") {
	const root = resolve(adkRoot);
	const instance = normalizeMessengerInstance(value);
	const instanceSuffix = instance === "default" ? "" : `/instances/${instance}`;
	const keySuffix = instance === "default" ? "" : `-${instance}`;
	return {
		root,
		instance,
		configPath: resolve(root, `naia-settings/messenger-sessions${instanceSuffix}/config.json`),
		stateDirectory: resolve(root, `naia-settings/.sessions/messenger-sessions${instanceSuffix}`),
		databasePath: resolve(root, `naia-settings/.sessions/messenger-sessions${instanceSuffix}/runtime.sqlite3`),
		runtimeRoot: resolve(root, `naia-settings/.sessions/messenger-sessions${instanceSuffix}/runtime`),
		lockPath: resolve(root, `naia-settings/.sessions/messenger-sessions${instanceSuffix}/service.lock`),
		recoveryKeyPath: resolve(root, `naia-settings/.keys/messenger-sessions/session-recovery-key${keySuffix}`),
		credentialsDirectory: resolve(root, "naia-settings/.keys/messenger-sessions"),
	};
}
