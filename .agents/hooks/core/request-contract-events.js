"use strict";
module.exports = function createRequestContractModule(api) {
const {
	fs, path, CLASSIFICATIONS, REQUIRED_CLIENT_EVENTS, CONTROL_INPUT_NAMES, sha256, opaqueId, canonicalJson,
	readJson, requiredJson, optionalJson, readUnitState, writeUnitState, loadConfig, governed, controlInputPath,
	processIdentity, withUnitLock, withRepositoryLock, assertUnitMutable, findUnit, addSessionBinding, git, appendQuarantine,
	createGenesisUnlocked, adoptQuarantine, verifySourceChain, appendSource, contractDigest, verifyScopeHistory, planningSeal, captureWorkspaceOccurrences,
	evaluateCompletion, evaluatePreCompact, evaluatePostCompact,
} = api;
function safeShellWords(command) {
	if (typeof command !== "string" || !command.trim() || /[\r\n;|&<>`$(){}]/.test(command)) return null;
	const words = [];
	let word = "";
	let quote = null;
	let escaped = false;
	let active = false;
	for (const char of command) {
		if (escaped) {
			word += char;
			escaped = false;
			active = true;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			active = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			else word += char;
			active = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			active = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (active) words.push(word);
			word = "";
			active = false;
			continue;
		}
		word += char;
		active = true;
	}
	if (escaped || quote) return null;
	if (active) words.push(word);
	return words;
}

function exactFlagMap(words) {
	const out = new Map();
	for (let index = 0; index < words.length; index += 2) {
		const flag = words[index];
		const value = words[index + 1];
		if (!/^--[a-z-]+$/.test(flag || "") || value == null || value.startsWith("--") || out.has(flag)) return null;
		out.set(flag, value);
	}
	return out;
}

function trustedNodeWord(word, cwd) {
	try {
		const expected = fs.realpathSync(process.execPath);
		if (path.isAbsolute(word)) return fs.realpathSync(word) === expected;
		if (word.includes("/")) return fs.realpathSync(path.resolve(cwd, word)) === expected;
		if (word !== "node") return false;
		const searchPath = process.env.PATH || process.env.Path || "";
		const extensions = process.platform === "win32"
			? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
			: [""];
		for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
			for (const extension of extensions) {
				const candidate = path.join(directory.replace(/^"|"$/g, ""), `${word}${extension.toLowerCase()}`);
				if (!fs.existsSync(candidate)) continue;
				return fs.realpathSync(candidate) === expected;
			}
		}
		return false;
	} catch {
		return false;
	}
}

function exactScriptWord(word, expected, cwd) {
	try {
		return fs.realpathSync(path.resolve(cwd, word)) === fs.realpathSync(expected);
	} catch {
		return false;
	}
}

function governedControlCommand(event, cwd, unit) {
	if (!unit || event.toolName !== "Bash") return false;
	const words = safeShellWords(event.toolInput && event.toolInput.command);
	if (!words || words.length < 3 || !trustedNodeWord(words[0], cwd)) return false;
	const operatorScript = path.join(cwd, "scripts", "request-contract.cjs");
	if (exactScriptWord(words[1], operatorScript, cwd)) {
		const command = words[2];
		const flags = exactFlagMap(words.slice(3));
		if (!flags) return false;
		const only = (...names) => flags.size === names.length && names.every((name) => flags.has(name));
		if (command === "status") return flags.size === 0 || (only("--unit") && flags.get("--unit") === unit.id);
		if (command === "compact") return flags.size === 0;
		if (command === "join-session") {
			const required = ["--unit", "--client", "--session"];
			const optional = "--client-version";
			if (![required.length, required.length + 1].includes(flags.size) || required.some((name) => !flags.has(name))) return false;
			if (flags.size === required.length + 1 && !flags.has(optional)) return false;
			return flags.get("--unit") === unit.id && ["claude", "codex"].includes(flags.get("--client")) && Boolean(flags.get("--session"));
		}
		if (command === "authority-challenge") return only("--unit", "--file") && flags.get("--unit") === unit.id && path.resolve(cwd, flags.get("--file")) === controlInputPath(unit, "authority");
		if (command === "bind") return only("--unit", "--file") && flags.get("--unit") === unit.id && path.resolve(cwd, flags.get("--file")) === controlInputPath(unit, "contract");
		if (command === "resume") return only("--unit", "--file") && flags.get("--unit") === unit.id && path.resolve(cwd, flags.get("--file")) === controlInputPath(unit, "resume");
		if (command === "review-challenge") return only("--unit", "--writer-session") && flags.get("--unit") === unit.id && flags.get("--writer-session") === event.sessionId;
		return false;
	}
	const reviewScript = path.join(cwd, "scripts", "request-contract-review-runner.cjs");
	if (!exactScriptWord(words[1], reviewScript, cwd)) return false;
	const flags = exactFlagMap(words.slice(2));
	const required = ["--cwd", "--unit", "--writer-session", "--reviewer", "--reviewer-attestor", "--runner-attestor"];
	if (!flags || flags.size !== required.length || required.some((name) => !flags.has(name))) return false;
	if (path.resolve(cwd, flags.get("--cwd")) !== cwd || flags.get("--unit") !== unit.id || flags.get("--writer-session") !== event.sessionId) return false;
	const config = loadConfig(cwd);
	try {
		const reviewerDigest = sha256(fs.readFileSync(path.resolve(cwd, flags.get("--reviewer"))));
		const reviewerAttestorDigest = sha256(fs.readFileSync(path.resolve(cwd, flags.get("--reviewer-attestor"))));
		const runnerAttestorDigest = sha256(fs.readFileSync(path.resolve(cwd, flags.get("--runner-attestor"))));
		return config.review_runner.allowed_reviewer_digests.includes(reviewerDigest)
			&& config.reviewer.allowed_attestor_digests.includes(reviewerAttestorDigest)
			&& config.review_runner.allowed_attestor_digests.includes(runnerAttestorDigest);
	} catch {
		return false;
	}
}

function governedApplyPatchControlInput(event, cwd, unit) {
	if (!unit || event.toolName !== "apply_patch") return false;
	const patch = event.toolInput && event.toolInput.command;
	if (typeof patch !== "string" || patch.includes("\0")) return false;
	const lines = patch.replace(/\r\n/g, "\n").split("\n");
	while (lines.at(-1) === "") lines.pop();
	if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return false;
	const sections = [];
	for (let index = 1; index < lines.length - 1; index++) {
		const line = lines[index];
		const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
		if (header) sections.push({ operation: header[1], file: header[2] });
		else if (line.startsWith("*** Move to:") || line === "*** Begin Patch" || line === "*** End Patch") return false;
	}
	if (sections.length !== 1 || !["Add", "Update"].includes(sections[0].operation)) return false;
	const candidate = sections[0].file;
	if (!candidate || path.isAbsolute(candidate)) return false;
	const absolute = path.resolve(cwd, candidate);
	return Object.keys(CONTROL_INPUT_NAMES).some((kind) => absolute === controlInputPath(unit, kind));
}

function governedControlInput(event, cwd, unit) {
	if (governedApplyPatchControlInput(event, cwd, unit)) return true;
	if (!unit || !["Write", "Edit"].includes(event.toolName)) return false;
	const candidate = event.toolInput && (event.toolInput.file_path || event.toolInput.path);
	if (!candidate) return false;
	const absolute = path.resolve(cwd, candidate);
	return Object.keys(CONTROL_INPUT_NAMES).some((kind) => absolute === controlInputPath(unit, kind));
}

function governedControlEvent(event, cwd, unit) {
	return governedControlCommand(event, cwd, unit) || governedControlInput(event, cwd, unit);
}

function configuredShellTools(config = null) {
	const configured = config && config.release && Array.isArray(config.release.shell_tools)
		? config.release.shell_tools
		: [];
	return [...new Set(["Bash", "shell_command", ...configured])];
}

function isShellTool(event, config = null) {
	const toolName = String(event.toolName || "");
	return configuredShellTools(config).includes(toolName)
		|| toolName === "exec_command"
		|| /(?:^|[.:/])(?:exec_command|shell_command)$/u.test(toolName);
}

function mutationFromEvent(event, cwd = null, unit = null, config = null) {
	if (cwd && governedControlEvent(event, cwd, unit)) return false;
	const tool = String(event.toolName || "");
	if (["Edit", "Write", "NotebookEdit", "apply_patch"].includes(tool)) return true;
	if (isShellTool(event, config)) return true;
	return false;
}

function releaseCommandFromEvent(event, config = null) {
	if (!isShellTool(event, config)) return false;
	const command = String(event.toolInput && event.toolInput.command || "");
	const segments = command.split(/[\r\n;&|]+/).map((part) => part.trim()).filter(Boolean);
	const builtins = [
		/(?:^|[\s"'])(?:(?:[A-Za-z]:\\|\/)[^\s"']*[\\/])?git(?:\.exe)?(?:\s+(?:-C|--git-dir|--work-tree)\s+\S+|\s+--[^\s=]+(?:=\S+)?)*\s+(?:push|merge)\b/i,
		/(?:^|[\s"'])gh(?:\.exe)?\s+(?:pr\s+merge|release\s+create|issue\s+close)\b/i,
		/(?:^|[\s"'])(?:npm|pnpm|yarn)(?:\.cmd|\.exe)?\s+(?:run\s+)?(?:publish|deploy)\b/i,
		/(?:^|[\s"'])docker(?:\.exe)?\s+(?:push|compose\s+up)\b/i,
		/(?:^|[\s"'])az(?:\.cmd|\.exe)?\s+(?:[^\r\n;&|]+\s+)?(?:deploy(?:ment)?|up)\b/i,
		/(?:^|[\s"'])kubectl(?:\.exe)?\s+(?:apply|create|delete|patch|replace|rollout)\b/i,
		/(?:^|[\s"'])helm(?:\.exe)?\s+(?:install|upgrade|uninstall)\b/i,
		/(?:^|[\s"'])terraform(?:\.exe)?\s+(?:apply|destroy|import)\b/i,
		/(?:^|[\s"'])gcloud(?:\.cmd|\.exe)?\s+[^\r\n;&|]*\bdeploy\b/i,
		/(?:^|[\s"'])aws(?:\.cmd|\.exe)?\s+[^\r\n;&|]*(?:deploy|update|create|delete|put-)\b/i,
		/(?:^|[\s"'])vercel(?:\.cmd|\.exe)?\b[^\r\n;&|]*\s--prod\b/i,
		/(?:^|[\s"'])(?:scp|rsync)(?:\.exe)?\s+/i,
	];
	const custom = config && config.release ? config.release.command_patterns.map((pattern) => new RegExp(pattern, "i")) : [];
	return segments.some((segment) => {
		if (/^(?:echo|printf|write-output|select-string|grep|rg)\b/i.test(segment)) return false;
		return [...builtins, ...custom].some((pattern) => pattern.test(segment));
	});
}

function mutationLeaseId(event) {
	const nativeId = String(event.toolUseId || "");
	return nativeId || `session:${event.client || "unknown"}:${event.sessionId || "unbound"}`;
}

function semanticVersion(...args) { return api.semanticVersion(...args); }
function clientVersionSupported(...args) { return api.clientVersionSupported(...args); }
function clientRegistrySupports(...args) { return api.clientRegistrySupports(...args); }
function assertSupportedClient(...args) { return api.assertSupportedClient(...args); }
function handleEvent(...args) { return api.handleEvent(...args); }
function canonicalParityProjection(...args) { return api.canonicalParityProjection(...args); }


	return {
		safeShellWords,
		exactFlagMap,
		trustedNodeWord,
		exactScriptWord,
		governedControlCommand,
		governedApplyPatchControlInput,
		governedControlInput,
		governedControlEvent,
		configuredShellTools,
		isShellTool,
		mutationFromEvent,
		releaseCommandFromEvent,
		mutationLeaseId,
		semanticVersion,
		clientVersionSupported,
		clientRegistrySupports,
		assertSupportedClient,
		handleEvent,
		canonicalParityProjection,
	};
};
