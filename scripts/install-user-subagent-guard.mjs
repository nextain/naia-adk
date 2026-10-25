#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MATCHER = "Agent|Task|Workflow";
const COMPACT_WINDOW_KEY = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const DEFAULT_COMPACT_WINDOW = "200000";
const DEFAULT_POLICY = {
	allowedModels: ["haiku", "sonnet"],
	requireExplicitModel: true,
	requireBrief: true,
	overrideFile: "allow-upper-subagent-until",
	maxOverrideHours: 24,
};
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_HOOK = path.resolve(SCRIPT_DIR, "../.claude/hooks/subagent-model-guard.cjs");

function shellQuote(value) {
	return `'${String(value).replace(/'/gu, "'\\''")}'`;
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseArgs(argv) {
	const options = {
		mode: "check",
		home: os.homedir(),
		compactWindow: DEFAULT_COMPACT_WINDOW,
		defaultModel: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--check") options.mode = "check";
		else if (arg === "--apply") options.mode = "apply";
		else if (arg === "--home" || arg === "--compact-window" || arg === "--default-model") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			index += 1;
			if (arg === "--home") options.home = path.resolve(value);
			else if (arg === "--compact-window") {
				if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
					throw new Error("--compact-window must be a positive integer");
				}
				options.compactWindow = value;
			} else {
				options.defaultModel = value;
			}
		} else if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else {
			throw new Error(`unknown option: ${arg}`);
		}
	}
	options.home = path.resolve(options.home);
	return options;
}

function pathsFor(home) {
	const configDir = path.join(home, ".claude");
	return {
		configDir,
		hook: path.join(configDir, "hooks", "subagent-model-guard.cjs"),
		policy: path.join(configDir, "subagent-model-policy.json"),
		settings: path.join(configDir, "settings.json"),
	};
}

function readSettings(settingsPath) {
	if (!fs.existsSync(settingsPath)) return { exists: false, raw: null, value: {}, mode: 0o600 };
	const raw = fs.readFileSync(settingsPath, "utf8");
	const value = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("settings.json must contain a JSON object");
	}
	return { exists: true, raw, value, mode: fs.statSync(settingsPath).mode & 0o777 };
}

function commandReferencesHook(command, hookPath) {
	if (typeof command !== "string") return false;
	const absolute = path.resolve(hookPath);
	const hasShellToken = (token) => new RegExp(
		`(?:^|[\\s;|&])${escapeRegExp(token)}(?=$|[\\s;|&])`,
		"u",
	).test(command);
	if (hasShellToken(shellQuote(absolute)) || hasShellToken(`"${absolute}"`)) return true;
	const reference = new RegExp(`(?:^|[\\s"'])${escapeRegExp(absolute)}(?=$|[\\s"';])`, "u");
	return reference.test(command);
}

function canonicalHook(nodePath, hookPath) {
	return {
		type: "command",
		command: `${shellQuote(nodePath)} ${shellQuote(hookPath)}`,
		timeout: 10,
	};
}

function canonicalEntry(nodePath, hookPath) {
	return { matcher: MATCHER, hooks: [canonicalHook(nodePath, hookPath)] };
}

function isTargetHook(hook, hookPath) {
	return hook && typeof hook === "object" && hook.type === "command" && commandReferencesHook(hook.command, hookPath);
}

function upsertHook(preToolUse, nodePath, hookPath) {
	const canonical = canonicalHook(nodePath, hookPath);
	let inserted = false;
	const output = [];
	for (const entry of preToolUse) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Array.isArray(entry.hooks)) {
			output.push(entry);
			continue;
		}
		const hasTarget = entry.hooks.some((hook) => isTargetHook(hook, hookPath));
		if (!hasTarget) {
			output.push(entry);
			continue;
		}
		let segment = [];
		const flushSegment = () => {
			if (segment.length) output.push({ ...entry, hooks: segment });
			segment = [];
		};
		for (const hook of entry.hooks) {
			if (!isTargetHook(hook, hookPath)) {
				segment.push(hook);
				continue;
			}
			flushSegment();
			if (!inserted) {
				output.push({ ...entry, matcher: MATCHER, hooks: [canonical] });
				inserted = true;
			}
		}
		flushSegment();
	}
	if (!inserted) output.push(canonicalEntry(nodePath, hookPath));
	return output;
}

function prepareSettings(settingsValue, nodePath, hookPath, compactWindow, defaultModel) {
	const settings = JSON.parse(JSON.stringify(settingsValue));
	if (settings.hooks === undefined) settings.hooks = {};
	if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
		throw new Error("settings.hooks must be a JSON object");
	}
	if (settings.hooks.PreToolUse === undefined) settings.hooks.PreToolUse = [];
	if (!Array.isArray(settings.hooks.PreToolUse)) throw new Error("settings.hooks.PreToolUse must be an array");
	settings.hooks.PreToolUse = upsertHook(settings.hooks.PreToolUse, nodePath, hookPath);

	if (settings.env === undefined) settings.env = {};
	if (!settings.env || typeof settings.env !== "object" || Array.isArray(settings.env)) {
		throw new Error("settings.env must be a JSON object");
	}
	if (!Object.hasOwn(settings.env, COMPACT_WINDOW_KEY)) settings.env[COMPACT_WINDOW_KEY] = compactWindow;
	if (defaultModel !== undefined) settings.model = defaultModel;
	return settings;
}

function registeredHook(settings, hookPath) {
	const entries = settings?.hooks?.PreToolUse;
	if (!Array.isArray(entries)) return { registered: false, count: 0 };
	let count = 0;
	let canonical = false;
	for (const entry of entries) {
		if (!Array.isArray(entry?.hooks)) continue;
		for (const hook of entry.hooks) {
			if (!isTargetHook(hook, hookPath)) continue;
			count += 1;
			if (entry.matcher === MATCHER && hook.timeout === 10) canonical = true;
		}
	}
	return { registered: canonical, count };
}

function snapshot(options) {
	const paths = pathsFor(options.home);
	const settingsData = readSettings(paths.settings);
	const settings = settingsData.value;
	const registration = registeredHook(settings, paths.hook);
	let policyExists = false;
	try { policyExists = fs.statSync(paths.policy).isFile(); } catch { policyExists = false; }
	let hookExists = false;
	let hookSameContent = false;
	try {
		hookExists = fs.statSync(paths.hook).isFile();
		hookSameContent = hookExists && Buffer.compare(fs.readFileSync(paths.hook), fs.readFileSync(SOURCE_HOOK)) === 0;
	} catch { /* report absent or unreadable as not matching */ }
	const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? settings.env : {};
	return {
		mode: options.mode,
		home: options.home,
		hook: { exists: hookExists, sameContent: hookSameContent },
		registered: registration.registered,
		registrationCount: registration.count,
		policy: { exists: policyExists },
		compactWindow: Object.hasOwn(env, COMPACT_WINDOW_KEY) ? env[COMPACT_WINDOW_KEY] : null,
		defaultModel: Object.hasOwn(settings, "model") ? settings.model : null,
		envKeys: Object.keys(env).sort(),
	};
}

function timestampLabel(now = new Date()) {
	return now.toISOString().replace(/[-:.]/gu, "");
}

function uniqueBackupPath(filePath, stamp) {
	const base = `${filePath}.bak-${stamp}`;
	if (!fs.existsSync(base)) return base;
	for (let index = 1; ; index += 1) {
		const candidate = `${base}-${index}`;
		if (!fs.existsSync(candidate)) return candidate;
	}
}

function backupFile(filePath, stamp, backups) {
	const backup = uniqueBackupPath(filePath, stamp);
	fs.copyFileSync(filePath, backup, fs.constants.COPYFILE_EXCL);
	try { fs.chmodSync(backup, fs.statSync(filePath).mode & 0o777); } catch { /* backup remains recoverable */ }
	backups.push(backup);
	return backup;
}

function writeAtomic(filePath, contents, mode) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	let descriptor;
	try {
		descriptor = fs.openSync(temporary, "wx", mode);
		fs.writeFileSync(descriptor, contents);
		fs.fchmodSync(descriptor, mode);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, filePath);
	} catch (error) {
		if (descriptor !== undefined) {
			try { fs.closeSync(descriptor); } catch { /* best effort */ }
		}
		try { fs.unlinkSync(temporary); } catch { /* best effort */ }
		throw error;
	}
}

function apply(options) {
	const paths = pathsFor(options.home);
	const settingsData = readSettings(paths.settings);
	const settings = prepareSettings(settingsData.value, process.execPath, paths.hook, options.compactWindow, options.defaultModel);
	const settingsChanged = JSON.stringify(settings) !== JSON.stringify(settingsData.value);
	const changed = [];
	const backups = [];
	const stamp = timestampLabel();

	const hookContents = fs.readFileSync(SOURCE_HOOK);
	let hookMatches = false;
	try { hookMatches = Buffer.compare(fs.readFileSync(paths.hook), hookContents) === 0; } catch { /* absent */ }
	if (!hookMatches) {
		fs.mkdirSync(path.dirname(paths.hook), { recursive: true });
		let mode = 0o600;
		try {
			mode = fs.statSync(paths.hook).mode & 0o777;
			backupFile(paths.hook, stamp, backups);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		writeAtomic(paths.hook, hookContents, mode);
		changed.push("hook");
	}

	if (!fs.existsSync(paths.policy)) {
		fs.mkdirSync(paths.configDir, { recursive: true });
		const policyContents = `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`;
		const descriptor = fs.openSync(paths.policy, "wx", 0o600);
		try {
			fs.writeFileSync(descriptor, policyContents);
			fs.fchmodSync(descriptor, 0o600);
		} finally {
			fs.closeSync(descriptor);
		}
		changed.push("policy");
	}

	if (settingsChanged) {
		fs.mkdirSync(paths.configDir, { recursive: true });
		if (settingsData.exists) backupFile(paths.settings, stamp, backups);
		writeAtomic(paths.settings, `${JSON.stringify(settings, null, 2)}\n`, settingsData.mode);
		changed.push("settings");
	}
	return { ...snapshot(options), changed, backups };
}

function printHelp() {
	console.log("Usage: node scripts/install-user-subagent-guard.mjs [--check|--apply] [--home <folder>] [--compact-window <positive integer>] [--default-model <name>]");
}

function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) return printHelp();
		const result = options.mode === "apply" ? apply(options) : snapshot(options);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ error: error.message || "installer failed" })}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { apply, parseArgs, snapshot };
