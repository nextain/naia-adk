const fs = require("node:fs");
const path = require("node:path");
const sessionContract = require("../../.agents/hooks/core/session-contract.js");

const SAFE_READ_COMMANDS = [
	/^(?:get-content|gc|get-childitem|gci|dir|ls|get-item|gi|get-filehash|test-path|resolve-path)\b/i,
	/^(?:select-string|select-object|sort-object|where-object|measure-object)\b/i,
	/^(?:rg|grep|egrep|fgrep|cat|head|tail|wc|pwd|stat|readlink|realpath|basename|dirname|file|nl|tac|cut|sort|uniq|comm|column|tr|diff|du|df|tree|which|type|env|date|hostname|uname|xxd|od|strings|sha1sum|sha256sum|md5sum|cksum|jq|yq|fd|fdfind|ripgrep)\b/i,
	// Shell no-ops that carry no effect of their own. `|| true` is how a search
	// is kept from failing a script, and `echo` reports what was found; treating
	// them as mutations made an ordinary investigation read as a write.
	/^(?:true|false|:|echo)\b/i,
	/^git\s+(?:status|diff|log|show|remote|ls-files|check-ignore|rev-parse)\b/i,
	/^git\s+branch(?:\s+(?:--show-current|--list|-l|--all|-a|--remotes|-r|-v|-vv))*\s*$/i,
	/^git\s+submodule\s+status\b/i,
	// find writes only through -delete/-exec-style actions; without them it lists.
	/^find\b(?![\s\S]*(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprintf|fprint0)\b)/i,
	// sed writes only with -i or a w command; without them it streams to stdout.
	/^sed\b(?![\s\S]*(?:^|\s)-[A-Za-z]*i\b)(?![\s\S]*\bw\s)/i,
	/^awk\b/i,
];

// These forms must never be rescued by an exact allowed_shell_commands match.
const NESTED_RUNTIME = /(?:^|[\s;&|()])(?:claude(?:-code)?|codex(?:-cli)?|gemini(?:-cli)?|opencode(?:-ai)?|open-code)(?=\s|$|["'])|@(?:anthropic-ai\/claude-code|google\/gemini-cli|openai\/codex(?:-cli)?|opencode-ai)(?=\s|$|["'])/i;
const DYNAMIC_SHELL = [
	/\$\(|`/,
	// A plain variable reference hides nothing: the command head is still
	// visible, and the head is what the policy judges.
	/(?:^|[;&|]\s*)[A-Za-z_][A-Za-z0-9_]*\s*=/,
	/\b(?:eval|xargs)\b/i,
	/\b(?:sh|bash|zsh|dash|ksh|fish)\s+-[A-Za-z]*c\b/i,
	/\b(?:node|nodejs|bun|deno|python(?:3)?|perl|ruby|php|pwsh|powershell)\s+(?:-[A-Za-z]*e|-[A-Za-z]*c|--eval|--execute|--command|-[A-Za-z]*Command)\b/i,
	/(?<![-\w])printf\b/i,
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

function trustedPowerShellReadBatch(command) {
	const source = String(command || "").trim();
	if (!source || /[><`]|\$\(|\b(?:set-content|add-content|out-file|tee|new-item|remove-item|move-item|copy-item|rename-item|invoke-expression)\b/i.test(source)) return false;
	const match = source.match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*@\(([^)]*)\)\s*;\s*foreach\s*\(\s*\$([A-Za-z_][A-Za-z0-9_]*)\s+in\s+\$\1\s*\)\s*\{([\s\S]*)\}\s*$/i);
	if (!match) return false;
	const entries = match[2].split(",").map((value) => value.trim()).filter(Boolean);
	if (entries.length === 0 || entries.some((value) => !/^(?:'[^']+'|"[^"]+")$/.test(value))) return false;
	const iterator = match[3].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const body = match[4].trim();
	const read = new RegExp(`^(?:Write-Output\\s+(?:'[^']*'|"[^"]*")\\s*;\\s*)?Get-Content\\s+(?=[^;]*-(?:LiteralPath|Path)\\s+\\$${iterator}(?:\\s|$))[^;{}]+(?:\\s*;)?$`, "i");
	return read.test(body);
}

/**
 * Split on statement separators that are actually separators. Splitting the raw
 * string breaks any command whose *argument* contains a pipe — `rg 'a|b' file`
 * became two statements, the second of which matched nothing, so a plain search
 * was refused as a mutation.
 */
function splitStatements(source) {
	const statements = [];
	let current = "";
	let quote = null;
	for (const character of String(source || "")) {
		if (quote) { current += character; if (character === quote) quote = null; continue; }
		if (character === '"' || character === "'") { quote = character; current += character; continue; }
		// && and || join statements; a chain of reads is still a read.
		if (character === ";" || character === "|" || character === "&") { statements.push(current); current = ""; continue; }
		current += character;
	}
	statements.push(current);
	return statements.map((statement) => statement.trim()).filter(Boolean);
}

/** Discarding stderr is not a write; every other redirection still is. */
function withoutStderrRedirection(source) {
	return String(source || "").replace(/\s*2>\s*(?:&1|\/dev\/null)/g, " ");
}

const OUTPUT_FLAG_TOOLS = /^(?:curl|wget|git|sort|tar|ffmpeg|openssl|gzip|gunzip|zip|unzip|xz|pandoc|convert|cp|install)$/i;

/**
 * `-o` writes a file for some tools and means something else for others: it is
 * find's OR operator and grep's only-matching. Judging it globally refused
 * ordinary searches.
 */
function writesThroughOutputFlag(statement) {
	const tokens = shellTokens(statement);
	if (!tokens.length) return false;
	const head = String(tokens[0]).split(/[\\/]/).pop().replace(/\.(exe|cmd)$/i, "");
	if (!OUTPUT_FLAG_TOOLS.test(head)) return false;
	return tokens.slice(1).some((token) => /^(?:-o|-O|--output(?:=.*)?|--output-document(?:=.*)?)$/i.test(token));
}

function readOnlyShell(command, cwd = process.cwd()) {
	const source = String(command || "").trim();
	if (!source) return true;
	if (trustedPowerShellReadBatch(source)) return true;
	const inspected = withoutStderrRedirection(source);
	if (
		/[><`]/.test(inspected) ||
		/\$\(/.test(inspected) ||

		/\brg\b[^;|\n]*(?:^|\s)--pre(?:=|\s|$)/i.test(source) ||
		/\b(?:set-content|add-content|out-file|tee|new-item|remove-item|move-item|copy-item|rename-item)\b/i.test(source) ||
		/\bgit\s+branch\b[^;\n]*(?:\s-(?:d|D|m|M|c|C|f)\b|--delete\b|--move\b|--copy\b|--force\b|--set-upstream-to\b|--unset-upstream\b)/i.test(source) ||
		/\bgit\s+remote\s+(?:add|remove|rm|rename|set-head|set-branches|set-url|prune|update)\b/i.test(source)
	) return false;
	const statements = splitStatements(inspected);
	return statements.length > 0 && statements.every((statement) => {
		if (writesThroughOutputFlag(statement)) return false;
		if (trustedSessionParserCommand(statement, cwd)) return true;
		const normalized = normalizedGitReadStatement(statement);
		return SAFE_READ_COMMANDS.some((pattern) => pattern.test(normalized));
	});
}

function explicitlyScopedRead(command, cwd) {
	const source = String(command || "").trim();

	// 선행 cd 갈래는 readOnlyShell 관문보다 먼저 본다. `cd` 자체는 읽기 명령으로
	// 분류되지 않아서, 합쳐 놓은 문장 전체를 먼저 재면 이 형태가 늘 탈락한다.
	const statements = splitStatements(source).map((value) => value.trim()).filter(Boolean);
	if (statements.length > 1) {
		const [first, ...rest] = statements;
		const enter = first.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/i);
		const target = enter ? (enter[1] || enter[2] || enter[3]) : null;
		if (target && (path.posix.isAbsolute(target) || path.win32.isAbsolute(target))) {
			// 같은 위치를 셸이 여러 표기로 부른다. Git Bash 의 `/d/alpha-adk`,
			// PowerShell 의 `D:\alpha-adk`, 그리고 posix 경로가 모두 같은 곳이다.
			// 표기를 하나로 눕힌 뒤 비교한다.
			const flatten = (value) => String(value)
				.replace(/\\/g, "/")
				.replace(/^\/([a-zA-Z])\//, (match, drive) => `${drive.toLowerCase()}:/`)
				.replace(/^([a-zA-Z]):\//, (match, drive) => `${drive.toLowerCase()}:/`)
				.replace(/\/+$/, "")
				.toLowerCase();
			const governed = flatten(cwd || ".");
			const entered = flatten(target);
			const inside = entered === governed || entered.startsWith(`${governed}/`) || governed.startsWith(`${entered}/`);
			if (inside && rest.every((statement) => readOnlyShell(statement, cwd))) return true;
		}
	}

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

/**
 * Asking a model CLI what it can do is not running it. `opencode models`,
 * `codex --version` and friends start no nested session, so refusing them
 * blocked capability checks the profiles legitimately need.
 */
const RUNTIME_INTROSPECTION = /^\s*(?:claude(?:-code)?|codex(?:-cli)?|gemini(?:-cli)?|opencode(?:-ai)?|open-code)\s+(?:models?|model|--version|-v|--help|-h|help|list|whoami|auth\s+status|config\s+(?:get|list|show))\b[^;&|]*$/i;

function runtimeIntrospectionCommand(command) {
	return RUNTIME_INTROSPECTION.test(String(command || ""));
}

const RUNTIME_BINARY = /^(?:codex|claude|opencode|gemini)(?:-(?:code|cli|ai))?(?:\.exe)?$/i;
const RUNTIME_PACKAGE = /@(?:anthropic-ai\/claude-code|google\/gemini-cli|openai\/codex(?:-cli)?|opencode-ai)\b/i;

/**
 * Whether this command *launches* a model runtime.
 *
 * Matching the name anywhere in the string refused ordinary work whenever a
 * path happened to contain it: `ls -la ~/.config/opencode` and a ripgrep over
 * that directory were both read as nested launches. Only the executable
 * position decides, with quotes and directories stripped first so that
 * `co''dex exec` and `/usr/bin/codex` are still caught, and package
 * specifiers are matched anywhere because that is how npx runs them.
 */
function nestedModelRuntimeCommand(command) {
	if (runtimeIntrospectionCommand(command)) return false;
	const source = String(command || "").trim();
	if (!source) return false;
	const dequoted = source.replace(/\\(.)/gs, "$1").replace(/["']/g, "");
	if (RUNTIME_PACKAGE.test(source) || RUNTIME_PACKAGE.test(dequoted)) return true;
	for (const statement of splitStatements(dequoted)) {
		const tokens = shellTokens(statement);
		const head = tokens[0];
		if (!head) continue;
		const binary = String(head).split(/[\\/]/).pop();
		if (RUNTIME_BINARY.test(binary)) return true;
		// `bash -c "opencode run"` launches it just as directly; look inside.
		if (/^(?:sh|bash|zsh|dash|ksh|fish)$/i.test(binary)) {
			const flag = tokens.findIndex((token, index) => index > 0 && /^-[A-Za-z]*c$/.test(token));
			if (flag > 0 && tokens[flag + 1] && nestedModelRuntimeCommand(tokens.slice(flag + 1).join(" "))) return true;
		}
	}
	return false;
}

function executableReadCommand(command) {
	return /\brg\b[^;|\n]*(?:^|\s)--pre(?:=|\s|$)/i.test(String(command || ""));
}

module.exports = {
	runtimeIntrospectionCommand,
	splitStatements,
	withoutStderrRedirection,
	executableReadCommand,
	explicitlyScopedRead,
	nestedModelRuntimeCommand,
	normalizedGitReadStatement,
	readOnlyShell,
	requestedWorkdirIssue,
	shellTokens,
	trustedSessionParserCommand,
	trustedPowerShellReadBatch,
	unsafeShellCommand,
};
