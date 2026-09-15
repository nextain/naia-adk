"use strict";

const fs = require("fs");
const path = require("path");
const harnessSwitch = require("../../.agents/hooks/core/harness-switch.js");

/**
 * Resolve the nearest command policy, retaining refusals from every enclosing
 * project so a child project cannot broaden the public routine-work boundary.
 * Ordinary policy keys use the nearest value; refusal heads, subcommands, and
 * patterns are unioned across the chain. If any applicable policy denies the
 * unbound routine default, the merged default stays denied.
 */
function routineAllowance(projectRoot) {
	const merged = {};
	const refusals = new Set();
	const refusalFields = {
		contract_required_heads: new Map(),
		contract_required_subcommands: new Map(),
	};
	const refusalPatterns = new Set();
	const refusalMetadata = {
		contract_required_heads: null,
		contract_required_subcommands: null,
		contract_required_patterns: null,
	};
	let defaultSeen = false;
	let defaultAllowed = true;
	let found = false;
	let malformed = false;
	for (const directory of harnessSwitch.ancestorDirectories(projectRoot)) {
		const policyPath = path.join(directory, ".agents", "context", "agents-rules.json");
		if (!fs.existsSync(policyPath)) continue;
		let rules;
		let allowance;
		try {
			rules = JSON.parse(fs.readFileSync(policyPath, "utf8"));
			if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
				malformed = true;
				continue;
			}
			const workflow = rules.ai_workflow;
			if (workflow !== undefined && (!workflow || typeof workflow !== "object" || Array.isArray(workflow))) {
				malformed = true;
				continue;
			}
			const authorization = workflow?.routine_action_authorization;
			if (authorization !== undefined && (!authorization || typeof authorization !== "object" || Array.isArray(authorization))) {
				malformed = true;
				continue;
			}
			allowance = authorization?.unbound_routine_commands;
		} catch {
			// An existing policy that cannot be read is an authority-integrity
			// failure. Do not silently fall back to the routine default.
			malformed = true;
			continue;
		}
		const authorization = rules.ai_workflow?.routine_action_authorization;
		if (authorization && Object.hasOwn(authorization, "unbound_routine_commands") &&
			(!allowance || typeof allowance !== "object" || Array.isArray(allowance))) {
			malformed = true;
			continue;
		}
		if (!allowance) continue;
		if (typeof allowance.default !== "undefined" && !["allow", "deny"].includes(allowance.default)) malformed = true;
		if (Object.hasOwn(allowance, "git_refused_subcommands") && !Array.isArray(allowance.git_refused_subcommands)) malformed = true;
		for (const key of ["contract_required_heads", "contract_required_subcommands"]) {
			if (Object.hasOwn(allowance, key) && (!allowance[key] || typeof allowance[key] !== "object" || Array.isArray(allowance[key]))) malformed = true;
		}
		if (Object.hasOwn(allowance, "contract_required_patterns") &&
			(!allowance.contract_required_patterns || typeof allowance.contract_required_patterns !== "object" || Array.isArray(allowance.contract_required_patterns) ||
				(Object.hasOwn(allowance.contract_required_patterns, "patterns") && !Array.isArray(allowance.contract_required_patterns.patterns)))) malformed = true;
		found = true;
		for (const [key, value] of Object.entries(allowance)) {
			if (key === "default") {
				defaultSeen = true;
				if (value !== "allow") defaultAllowed = false;
				continue;
			}
			if (key === "git_refused_subcommands") {
				for (const item of Array.isArray(value) ? value : []) refusals.add(item);
				continue;
			}
			if (key === "contract_required_heads" || key === "contract_required_subcommands") {
				if (!refusalMetadata[key] && value && typeof value === "object" && !Array.isArray(value)) {
					refusalMetadata[key] = { ...value };
				}
				if (!value || typeof value !== "object" || Array.isArray(value)) continue;
				for (const [category, items] of Object.entries(value)) {
					if (category === "_doc" || !Array.isArray(items)) continue;
					if (!refusalFields[key].has(category)) refusalFields[key].set(category, new Set());
					for (const item of items) refusalFields[key].get(category).add(item);
				}
				continue;
			}
			if (key === "contract_required_patterns") {
				if (!refusalMetadata[key] && value && typeof value === "object" && !Array.isArray(value)) {
					refusalMetadata[key] = { ...value };
				}
				for (const item of (Array.isArray(value?.patterns) ? value.patterns : [])) refusalPatterns.add(item);
				continue;
			}
			if (!Object.hasOwn(merged, key)) merged[key] = value;
		}
	}
	if (!found && !malformed) return builtinAllowance();
	if (defaultSeen) merged.default = defaultAllowed ? "allow" : "deny";
	if (malformed) merged.default = "deny";
	for (const key of Object.keys(refusalFields)) {
		if (!refusalFields[key].size && !refusalMetadata[key]) continue;
		const field = { ...(refusalMetadata[key] || {}) };
		for (const [category, items] of refusalFields[key]) field[category] = [...items];
		merged[key] = field;
	}
	if (refusalPatterns.size || refusalMetadata.contract_required_patterns) {
		merged.contract_required_patterns = {
			...(refusalMetadata.contract_required_patterns || {}),
			patterns: [...refusalPatterns],
		};
	}
	merged.git_refused_subcommands = [...refusals];
	return merged;
}

/**
 * Normalize policy subcommand refusals while retaining the public legacy field.
 * The caller decides whether the resolved policy is Alpha or public; this
 * helper therefore has no built-in remote-operation defaults.
 */
function routineRefusedSubcommands(allowance) {
	const refused = {};
	for (const [command, values] of Object.entries(allowance?.contract_required_subcommands || {})) {
		if (command === "_doc" || !Array.isArray(values)) continue;
		refused[command] = [...new Set(values.map((value) => String(value)))];
	}
	if (Array.isArray(allowance?.git_refused_subcommands)) {
		refused.git = [...new Set([
			...(refused.git || []),
			...allowance.git_refused_subcommands.map((value) => String(value)),
		])];
	}
	return refused;
}

/**
 * Commands whose public effect is a mutation even when a policy file does not
 * enumerate that exact spelling. This is intentionally a small command-family
 * classifier, rather than a shell parser: ambiguous wrappers and shell
 * structure are rejected by the gate before this helper is consulted.
 */
function commandWords(command) {
	return String(command || "")
		.match(/"[^"]*"|'[^']*'|\S+/g)
		?.map((token) => token.replace(/^(?:"|')|(?:"|')$/g, "")) || [];
}

// Git accepts a small set of global options before its subcommand. Options
// with a separate value must consume that value before subcommand detection;
// otherwise a value such as `core.pager=cat` or `.` can hide a destructive
// subcommand from the routine classifier. This is option handling for the
// classifier only, not a general Git or shell parser.
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set([
	"-c",
	"-C",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--super-prefix",
]);

const GIT_GLOBAL_LONG_OPTIONS_WITH_VALUES = [
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--super-prefix",
];

function gitGlobalOptionHasAttachedValue(token) {
	if (/^-c.+/.test(token) || /^-C.+/.test(token)) return true;
	return GIT_GLOBAL_LONG_OPTIONS_WITH_VALUES.some((option) => token.startsWith(`${option}=`));
}

function gitCommandRest(tokens) {
	const rest = [];
	for (let index = 1; index < tokens.length; index += 1) {
		const token = String(tokens[index]);
		if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(token)) {
			// A missing value is malformed and must not be mistaken for a
			// read-only command. The caller treats the unknown result as refused.
			if (index + 1 >= tokens.length) return null;
			index += 1;
			continue;
		}
		if (gitGlobalOptionHasAttachedValue(token)) continue;
		if (token.startsWith("-")) continue;
		rest.push(token.toLowerCase());
	}
	return rest;
}

function routineMutationRefused(command) {
	const tokens = commandWords(command);
	if (tokens.length === 0) return false;
	const head = path.basename(tokens[0]).replace(/\.(exe|cmd)$/i, "").toLowerCase();
	const rest = head === "git"
		? gitCommandRest(tokens)
		: tokens.slice(1)
			.filter((token, index, all) => token !== "-C" && all[index - 1] !== "-C" && !token.startsWith("-"))
			.map((token) => token.toLowerCase());
	if (rest === null) return true;
	const sub = rest[0];

	if (head === "git") {
		if (["restore", "checkout", "config"].includes(sub)) return true;
		if (sub === "remote") return ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"].includes(rest[1]);
		if (sub === "stash") return ["drop", "clear"].includes(rest[1]);
	}
	if (head === "gh" && sub === "pr") return ["create", "merge", "comment", "close", "review", "edit", "reopen", "lock"].includes(rest[1]);
	if (head === "gh" && sub === "issue") return rest[1] === "comment";
	if (head === "glab" && sub === "mr") return ["create", "merge", "close", "comment"].includes(rest[1]);
	if (head === "az" && ((sub === "group" && rest[1] === "delete") || (sub === "vm" && ["create", "delete", "start", "stop", "restart", "update", "resize", "deallocate"].includes(rest[1])))) return true;
	if (head === "gcloud" && sub === "compute" && rest[1] === "instances") return ["create", "delete", "update", "start", "stop", "reset", "suspend", "resume"].includes(rest[2]);
	if (head === "kubectl") return ["create", "edit", "set", "drain"].includes(sub);
	if (head === "helm") return ["install", "uninstall", "upgrade", "rollback", "delete"].includes(sub);
	return false;
}

/**
 * The policy a project gets when its rules file says nothing about routine
 * commands: everything is allowed except what cannot be undone. Before this a
 * missing section meant "refuse every mutating shell command", so a project
 * that had simply never written the section was locked shut, and the only
 * way to run `npm test` there was to disable the harness. The list mirrors
 * the workspace rules file (a test keeps the two identical) so that a project
 * with the section and one without behave the same.
 */
function builtinAllowance() {
	return JSON.parse(JSON.stringify(BUILTIN_UNBOUND_ROUTINE_COMMANDS));
}

const BUILTIN_UNBOUND_ROUTINE_COMMANDS = {
	default: "allow",
	contract_required_heads: {
		destructive_filesystem: ["rm", "rmdir", "shred", "truncate", "dd", "mkfs", "mkswap", "fdisk", "parted", "wipefs"],
		privilege_and_system: ["sudo", "su", "doas", "mount", "umount", "modprobe", "insmod", "rmmod", "reboot", "shutdown", "poweroff", "halt"],
		remote_transfer: ["ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet"],
		package_publication: ["twine"],
	},
	contract_required_subcommands: {
		git: ["reset", "clean", "filter-branch", "filter-repo", "gc", "prune", "reflog"],
		gh: ["create", "delete", "transfer", "archive", "unarchive", "rename"],
		glab: ["delete"],
		npm: ["publish", "unpublish", "deprecate"],
		pnpm: ["publish", "unpublish"],
		yarn: ["publish", "owner", "tag"],
		docker: ["push", "rm", "prune"],
		kubectl: ["apply", "delete", "patch", "replace", "scale", "rollout"],
		az: ["deployment", "webapp", "functionapp", "containerapp"],
		gcloud: ["deploy", "delete", "update", "replace", "run"],
		vercel: ["deploy", "remove", "alias", "env"],
		terraform: ["apply", "destroy", "import", "state"],
		cargo: ["publish", "yank"],
	},
	git_refused_subcommands: ["push"],
	contract_required_patterns: {
		patterns: [
			"(?:^|\\s)curl\\b[^\\n]*(?:\\s-X\\s*(?:POST|PUT|PATCH|DELETE)|\\s--request\\s|\\s-d\\b|\\s--data|\\s-T\\b|\\s--upload-file|\\s-F\\b|\\s--form)",
			"(?:^|\\s)wget\\b[^\\n]*(?:--post-data|--post-file|--method\\s*=?\\s*(?:POST|PUT|DELETE))",
			"(?:^|\\s)gh\\s+api\\b[^\\n]*(?:-X\\s*(?:POST|PUT|PATCH|DELETE)|--method\\s*(?:POST|PUT|PATCH|DELETE)|\\s-f\\s|--field)",
			"(?:^|\\s)git\\s[^\\n]*(?:--force\\b|--force-with-lease\\b)",
			"(?:^|\\s)git\\s+branch\\b[^\\n]*\\s-D\\b",
			"(?:^|\\s)mv\\s+[^\\n]*\\s/(?:etc|usr|bin|sbin|var|boot|dev|proc|sys)\\b",
			"(?:^|\\s)(?:tee|dd)\\s+[^\\n]*/(?:etc|usr|bin|sbin|boot)\\b",
			"(?:^|\\s)git\\s+(?:restore|checkout)\\b",
			"(?:^|\\s)git\\s+(?:config\\s+--global|remote\\s+(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)|stash\\s+(?:drop|clear))\\b",
			"(?:^|\\s)gh\\s+(?:pr\\s+(?:merge|comment|close|review|edit|reopen|lock)|issue\\s+comment)\\b",
			"(?:^|\\s)glab\\s+mr\\s+(?:create|merge|close|comment)\\b",
			"(?:^|\\s)az\\s+(?:group\\s+delete|vm\\s+(?:create|delete|start|stop|restart|update|resize|deallocate))\\b",
			"(?:^|\\s)gcloud\\s+compute\\s+instances\\s+(?:create|delete|update|start|stop|reset|suspend|resume)\\b",
			"(?:^|\\s)kubectl\\s+(?:create|edit|set|drain)\\b",
			"(?:^|\\s)helm\\s+(?:install|uninstall|upgrade|rollback|delete)\\b",
		],
	},
};

module.exports = { BUILTIN_UNBOUND_ROUTINE_COMMANDS, builtinAllowance, routineAllowance, routineRefusedSubcommands, routineMutationRefused };
