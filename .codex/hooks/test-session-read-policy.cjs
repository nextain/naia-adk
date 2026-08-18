const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const policy = require("./session-read-policy.cjs");
const contractCore = require("../../.agents/hooks/core/session-contract.js");

const repositoryRoot = contractCore.findProjectRoot(__dirname);

for (const command of [
	"git branch new-name",
	"git branch -f main HEAD~1",
	"git branch --delete topic",
	"git checkout -b topic",
	"git diff --output=changed.patch",
	"git show HEAD:README.md -o copy.md",
	"rg --pre 'sh -c touch /tmp/escaped' needle file",
]) assert.equal(policy.readOnlyShell(command, repositoryRoot), false, command);

for (const command of [
	"git status --short",
	"git -C projects/naia-adk status --short",
	"git -C \"projects/naia adk\" log -1",
	"git diff --stat",
	"git log -1",
	"git show HEAD:README.md",
	"git rev-parse --show-toplevel",
	"git branch --show-current",
	"Get-Content AGENTS.md",
]) assert.equal(policy.readOnlyShell(command, repositoryRoot), true, command);

assert.equal(
	policy.readOnlyShell("$paths = @('.agents/context/agents-rules.json','.agents/context/project-index.yaml'); foreach ($p in $paths) { Get-Content -LiteralPath $p -Raw }", repositoryRoot),
	true,
	"a literal-path Get-Content batch must remain available to unbound sessions",
);
for (const command of [
	"$paths = @('.agents/context/agents-rules.json'); foreach ($p in $paths) { Set-Content -LiteralPath $p changed }",
	"$paths = @($(Get-ChildItem)); foreach ($p in $paths) { Get-Content -LiteralPath $p -Raw }",
	"$paths = @('.agents/context/agents-rules.json'); foreach ($p in $paths) { Invoke-Expression $p }",
]) assert.equal(policy.readOnlyShell(command, repositoryRoot), false, command);

assert.equal(
	policy.readOnlyShell("node .agents/skills/session-resume/parse-session.js --list", repositoryRoot),
	true,
	"the repository-owned session parser may write only its default temporary digest",
);
assert.equal(
	policy.readOnlyShell("node .agents/skills/session-resume/parse-session.js session-id --out product.txt", repositoryRoot),
	false,
	"the trusted parser cannot select a caller-controlled output path",
);
assert.equal(
	policy.readOnlyShell("node arbitrary-parser.js session-id", repositoryRoot),
	false,
	"arbitrary Node remains mutating",
);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "session-read-policy-"));
try {
	const nested = path.join(fixture, "nested");
	fs.mkdirSync(nested);
	assert.equal(policy.requestedWorkdirIssue({}, fixture), null);
	assert.equal(policy.requestedWorkdirIssue({ workdir: "." }, fixture), null);
	assert.equal(policy.requestedWorkdirIssue({ workdir: nested }, fixture), "mismatch");
	assert.equal(policy.requestedWorkdirIssue({ workdir: "missing" }, fixture), "invalid");
	assert.equal(policy.explicitlyScopedRead(`git -C "${nested}" status --short`, fixture), true);
	assert.equal(policy.explicitlyScopedRead("git status --short", fixture), false);
	assert.equal(policy.explicitlyScopedRead("Get-Content -Raw -LiteralPath 'D:\\alpha-adk\\AGENTS.md'", fixture), true);
	assert.equal(policy.explicitlyScopedRead("Get-ChildItem -LiteralPath 'D:\\alpha-adk\\.agents' -Force | Select-Object Name,Length", fixture), true);
	assert.equal(policy.explicitlyScopedRead("Get-Item -Path '\\\\server\\share\\item.txt'", fixture), true);
	assert.equal(policy.explicitlyScopedRead("Get-Content -LiteralPath AGENTS.md", fixture), false);
	assert.equal(policy.explicitlyScopedRead("gc -LiteralPath 'D:\\alpha-adk\\AGENTS.md'", fixture), false);
	assert.equal(policy.explicitlyScopedRead("Get-Content -LiteralPath 'D:\\alpha-adk\\AGENTS.md'; Get-Content local.txt", fixture), false);
	assert.equal(policy.explicitlyScopedRead("Get-Content -LiteralPath 'D:\\alpha-adk\\AGENTS.md' & Set-Content local.txt changed", fixture), false);
	assert.equal(policy.explicitlyScopedRead("Get-Content -LiteralPath 'D:\\alpha-adk\\AGENTS.md'\nSet-Content local.txt changed", fixture), false);
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}

console.log("session read policy: PASS");

// Investigation commands that enforcement refused in practice on 2026-08-18,
// each for a different reason: a pipe inside a quoted pattern was treated as a
// statement separator, jq/sed/find were absent from the read vocabulary, and
// discarding stderr counted as a redirection.
for (const command of [
	"rg -n 'record_id|midi_pitch' manifest.json",
	"jq '.records[] | {record_id}' manifest.json",
	"sed -n '1,220p' contract.json",
	"find projects -type f -iname '*.wav' 2>/dev/null | tail -30",
	"find . -name '*.json' -printf '%p\\n'",
	"sort names.txt | uniq -c | head",
	"du -sh data 2>/dev/null",
	"sha256sum audio.wav",
]) assert.equal(policy.readOnlyShell(command, repositoryRoot), true, command);

// The widened vocabulary must not rescue the writing forms of the same tools.
for (const command of [
	"sed -i 's/a/b/' file.json",
	"find . -name '*.tmp' -delete",
	"find . -exec rm {} ;",
	"jq . in.json > out.json",
	"sort names.txt -o names.txt",
	"cat template > rendered.md",
]) assert.equal(policy.readOnlyShell(command, repositoryRoot), false, command);

// Quote-aware splitting must still see real separators outside quotes.
assert.deepEqual(policy.splitStatements("rg 'a|b' f | head -3"), ["rg 'a|b' f", "head -3"]);
assert.deepEqual(policy.splitStatements("cat a; rm b"), ["cat a", "rm b"]);
assert.equal(policy.readOnlyShell("rg 'a|b' f | rm -rf x", repositoryRoot), false);


// The runtime check used to match the name anywhere in the string, so any path
// containing it was read as a launch: inspecting ~/.config/opencode, or grepping
// that directory, was refused as a nested runtime.
for (const command of [
	"ls -la /var/home/luke/.config/opencode",
	"rg -l 'deepseek' /var/home/luke/.config/opencode | head -80",
	"cat ~/.codex/config.toml",
	"find . -path '*/claude/*' -name '*.json'",
]) assert.equal(policy.nestedModelRuntimeCommand(command), false, `path mention is not a launch: ${command}`);

// The executable position, however it is spelled, still is.
for (const command of [
	"opencode run task", "codex exec task", "claude -p hi", "/usr/bin/codex exec task",
	"opencode-ai run", "echo hi | codex exec x", "bash -c 'opencode run task'",
	"npx @anthropic-ai/claude-code --help", "npx @openai/codex-cli",
]) assert.equal(policy.nestedModelRuntimeCommand(command), true, `launch stays refused: ${command}`);

// Asking what a runtime can do starts no session.
for (const command of ["opencode models azure", "codex --version", "claude --help", "opencode auth status"]) {
	assert.equal(policy.nestedModelRuntimeCommand(command), false, `introspection allowed: ${command}`);
}
assert.equal(policy.nestedModelRuntimeCommand("opencode models && codex exec x"), true,
	"introspection does not carry a launch joined onto it");
