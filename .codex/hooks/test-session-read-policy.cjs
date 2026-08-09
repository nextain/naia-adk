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
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}

console.log("session read policy: PASS");
