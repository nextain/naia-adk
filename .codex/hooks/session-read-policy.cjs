const fs = require("node:fs");
const path = require("node:path");
const sessionContract = require("../../.agents/hooks/core/session-contract.js");

const SAFE_READ_COMMANDS = [
	/^(?:get-content|gc|get-childitem|gci|dir|ls|get-item|gi|get-filehash|test-path|resolve-path)\b/i,
	/^(?:select-string|select-object|sort-object|where-object|measure-object)\b/i,
	/^(?:rg|grep|cat|head|tail|wc|pwd|stat|readlink)\b/i,
	/^git\s+(?:status|diff|log|show|remote|ls-files|check-ignore|rev-parse)\b/i,
	/^git\s+branch(?:\s+(?:--show-current|--list|-l|--all|-a|--remotes|-r|-v|-vv))*\s*$/i,
	/^git\s+submodule\s+status\b/i,
];

// These forms must never be rescued by an exact allowed_shell_commands match.
const NESTED_RUNTIME = /(?:^|[\s;&|()])(?:claude(?:-code)?|codex(?:-cli)?|gemini(?:-cli)?|opencode(?:-ai)?|open-code)(?=\s|$|["'])|@(?:anthropic-ai\/claude-code|google\/gemini-cli|openai\/codex(?:-cli)?|opencode-ai)(?=\s|$|["'])/i;
const DYNAMIC_SHELL = [
	/\$\(|`/,
	/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/,
	/(?:^|[;&|]\s*)[A-Za-z_][A-Za-z0-9_]*\s*=/,
	/\b(?:eval|xargs)\b/i,
	/\b(?:sh|bash|zsh|dash|ksh|fish)\s+-[A-Za-z]*c\b/i,
	/\b(?:node|nodejs|bun|deno|python(?:3)?|perl|ruby|php|pwsh|powershell)\s+(?:-[A-Za-z]*e|-[A-Za-z]*c|--eval|--execute|--command|-[A-Za-z]*Command)\b/i,
	/\bprintf\b/i,
	/\\(?:[0-7]{1,3}|x[0-9a-f]{2})/i,
];

function shellTokens(source) {
	const tokens = String(source || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
	return tokens.map((token) => token.replace(/^(?:"|')|(?:"|')$/g, ""));
}

function normalizedGitReadStatement(statement) {
	const scoped = String(statement || "").match(/^git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)+([\s\S]+)$/i);
	return scoped ? `git ${scoped[1]}` : statement;
}

function trustedSessionParserCommand(command, cwd) {
	const tokens = shellTokens(command);
	if (tokens.length < 2 || !/^node(?:\.exe)?$/i.test(tokens[0])) return false;
	const projectRoot = sessionContract.findProjectRoot(cwd);
	if (!projectRoot) return false;
	const expected = path.join(projectRoot, ".agents", "skills", "session-resume", "parse-session.js");
	let script = path.resolve(cwd, tokens[1]);
	try { script = fs.realpathSync(script); } catch { return false; }
	let canonicalExpected = expected;
	try { canonicalExpected = fs.realpathSync(expected); } catch { return false; }
	if (script !== canonicalExpected) return false;

	let targetCount = 0;
	for (let index = 2; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--list") continue;
		if (token === "--out") return false;
		if (["--tool", "--cwd", "--last"].includes(token)) {
			const value = tokens[++index];
			if (!value || value.startsWith("--")) return false;
			if (token === "--tool" && !["auto", "claude", "codex", "opencode"].includes(value)) return false;
			if (token === "--last" && !/^[1-9][0-9]*$/.test(value)) return false;
			continue;
		}
		if (token.startsWith("--") || ++targetCount > 1) return false;
	}
	return targetCount === 1 || tokens.includes("--list");
}

function readOnlyShell(command, cwd = process.cwd()) {
	const source = String(command || "").trim();
	if (!source) return true;
	if (
		/[><`]/.test(source) ||
		/\$\(/.test(source) ||
		/&&|\|\|/.test(source) ||
		/(?:^|\s)(?:--output(?:=|\s)|-o(?:\s|$))/i.test(source) ||
		/\brg\b[^;|\n]*(?:^|\s)--pre(?:=|\s|$)/i.test(source) ||
		/\b(?:set-content|add-content|out-file|tee|new-item|remove-item|move-item|copy-item|rename-item)\b/i.test(source) ||
		/\bgit\s+branch\b[^;\n]*(?:\s-(?:d|D|m|M|c|C|f)\b|--delete\b|--move\b|--copy\b|--force\b|--set-upstream-to\b|--unset-upstream\b)/i.test(source) ||
		/\bgit\s+remote\s+(?:add|remove|rm|rename|set-head|set-branches|set-url|prune|update)\b/i.test(source)
	) return false;
	const statements = source
		.split(";")
		.flatMap((statement) => statement.split("|"))
		.map((statement) => statement.trim())
		.filter(Boolean);
	return statements.length > 0 && statements.every((statement) => {
		if (trustedSessionParserCommand(statement, cwd)) return true;
		const normalized = normalizedGitReadStatement(statement);
		return SAFE_READ_COMMANDS.some((pattern) => pattern.test(normalized));
	});
}

function explicitlyScopedRead(command, cwd) {
	const source = String(command || "").trim();
	if (!readOnlyShell(source, cwd)) return false;
	if (/^git\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+/i.test(source)) return true;

	// A host may ignore the requested tool workdir. Native PowerShell reads can
	// still be trusted when the command itself pins its source with an absolute
	// -Path/-LiteralPath value. Keep this deliberately narrower than
	// readOnlyShell: positional or relative paths must not rescue a mismatch.
	if (/[;&\r\n]/.test(source)) return false;
	const firstStatement = source.split("|", 1)[0].trim();
	const tokens = shellTokens(firstStatement);
	if (!/^(?:get-content|get-childitem|get-item|get-filehash|test-path|resolve-path)$/i.test(tokens[0] || "")) return false;
	const pathFlag = tokens.findIndex((token) => /^(?:-literalpath|-path)$/i.test(token));
	if (pathFlag < 0 || pathFlag + 1 >= tokens.length) return false;
	const target = tokens[pathFlag + 1];
	return path.posix.isAbsolute(target) || path.win32.isAbsolute(target);
}

function requestedWorkdirIssue(toolInput, cwd) {
	if (!Object.hasOwn(toolInput || {}, "workdir")) return null;
	if (typeof toolInput.workdir !== "string" || !toolInput.workdir.trim()) return "invalid";
	let requested;
	let actual = path.resolve(cwd);
	try {
		requested = fs.realpathSync(path.resolve(cwd, toolInput.workdir));
		actual = fs.realpathSync(actual);
		if (!fs.statSync(requested).isDirectory()) return "invalid";
	} catch {
		return "invalid";
	}
	return requested === actual ? null : "mismatch";
}

function unsafeShellCommand(command) {
	const source = String(command || "").trim();
	return NESTED_RUNTIME.test(source) || DYNAMIC_SHELL.some((pattern) => pattern.test(source));
}

function nestedModelRuntimeCommand(command) {
	const source = String(command || "").trim();
	if (!source) return false;
	const dequoted = source.replace(/\\(.)/gs, "$1").replace(/["']/g, "");
	const provider = /(?:^|[\s"'=;|&\\/])(?:codex|claude|opencode|gemini)(?:\.exe)?(?=$|[\s"';|&])/iu;
	return provider.test(source) || provider.test(dequoted);
}

function executableReadCommand(command) {
	return /\brg\b[^;|\n]*(?:^|\s)--pre(?:=|\s|$)/i.test(String(command || ""));
}

module.exports = {
	executableReadCommand,
	explicitlyScopedRead,
	nestedModelRuntimeCommand,
	normalizedGitReadStatement,
	readOnlyShell,
	requestedWorkdirIssue,
	shellTokens,
	trustedSessionParserCommand,
	unsafeShellCommand,
};
