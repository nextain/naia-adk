"use strict";
// node .agents/hooks/core/remote-identity.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const core = require("./remote-identity.js");

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// A fake workspace: index says projects/naia-comm is PRIVATE nextain/naia-comm.
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "remote-identity-"));
fs.mkdirSync(path.join(ws, ".agents", "context"), { recursive: true });
fs.mkdirSync(path.join(ws, ".agents", "work"), { recursive: true });
fs.writeFileSync(path.join(ws, ".agents", "context", "project-index.yaml"), `version: "2.0"
workspace:
  repo: nextain/alpha-adk
submodules:
  naia-comm:
    path: ./projects/naia-comm
    repo: nextain/naia-comm
    visibility: private
    status: active
  naia-shell:
    path: ./projects/naia-shell
    repo: nextain/naia-shell
    visibility: public
`);
fs.writeFileSync(path.join(ws, ".agents", "context", "agents-rules.json"), JSON.stringify({ local_projects: {}, submodules: {} }));

function makeRepo(rel, remote) {
	const dir = path.join(ws, rel);
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	if (remote) git(dir, "remote", "add", "origin", remote);
	return dir;
}
const visibility = { "nextain/naia-comm": "PRIVATE", "nextain/naia-comm-public": "PUBLIC", "nextain/naia-shell": "PUBLIC" };
const deps = { ghQuery: (slug) => visibility[slug] || "" };

// 1. The incident: public clone sitting at the private catalogued path.
const wrong = makeRepo("projects/naia-comm", "https://github.com/nextain/naia-comm-public.git");
let r = core.evaluate({ command: "git push origin main", cwd: wrong, deps });
assert.ok(r && r.decision === "block", "push from mis-cloned private path must block");
assert.match(r.reason, /nextain\/naia-comm-public/);
assert.match(r.reason, /Index .* says: nextain\/naia-comm/);

// 1b. the same, invoked from the workspace root with -C
r = core.evaluate({ command: "git -C projects/naia-comm push origin feat/x", cwd: ws, deps });
assert.ok(r && r.decision === "block", "-C form must block too");

// 1c. and via cd
r = core.evaluate({ command: "cd projects/naia-comm && git push", cwd: ws, deps });
assert.ok(r && r.decision === "block", "cd form must block too");

// 2. Rewiring the remote at a catalogued path to a different repo is blocked at remote-add time.
fs.rmSync(wrong, { recursive: true, force: true });
const fresh = makeRepo("projects/naia-comm", null);
r = core.evaluate({ command: "git -C projects/naia-comm remote add origin https://github.com/nextain/naia-comm-public.git", cwd: ws, deps });
assert.ok(r && r.decision === "block", "remote add of a different repo at catalogued path must block");
r = core.evaluate({ command: "git -C projects/naia-comm remote add origin git@github.com:nextain/naia-comm.git", cwd: ws, deps });
assert.strictEqual(r, null, "remote add of the catalogued repo is allowed");

// 3. Correct private clone pushing to its private remote: allowed.
git(fresh, "remote", "add", "origin", "https://github.com/nextain/naia-comm.git");
r = core.evaluate({ command: "git push -u origin main", cwd: fresh, deps });
assert.strictEqual(r, null, "correct private push is routine");

// 4. Catalogued public repo pushing to its public remote: allowed (routine).
const shell = makeRepo("projects/naia-shell", "https://github.com/nextain/naia-shell.git");
r = core.evaluate({ command: "git push origin qa/linux-native-candidate", cwd: shell, deps });
assert.strictEqual(r, null, "catalogued public repo push is routine");

// 5. Uncatalogued checkout (worktree, tmp clone) pushing to a public remote: allowed by default.
const wt = makeRepo(".worktrees/naia-shell-582", "https://github.com/nextain/naia-shell.git");
r = core.evaluate({ command: "git push origin HEAD", cwd: wt, deps });
assert.strictEqual(r, null, "uncatalogued checkout is default-allow");

// 6. Clone of a different repo INTO a catalogued path is blocked.
fs.rmSync(fresh, { recursive: true, force: true });
r = core.evaluate({ command: "git clone https://github.com/nextain/naia-comm-public.git projects/naia-comm", cwd: ws, deps });
assert.ok(r && r.decision === "block", "cloning the wrong repo into a catalogued path must block");
r = core.evaluate({ command: "git clone https://github.com/nextain/naia-comm.git projects/naia-comm", cwd: ws, deps });
assert.strictEqual(r, null, "cloning the catalogued repo is allowed");

// 7. Visibility escalation: index private, remote reported PUBLIC, same slug (index drift).
fs.writeFileSync(path.join(ws, ".agents", "context", "project-index.yaml"), `submodules:
  naia-x:
    path: ./projects/naia-x
    repo: nextain/naia-comm-public
    visibility: private
`);
const x = makeRepo("projects/naia-x", "https://github.com/nextain/naia-comm-public.git");
r = core.evaluate({ command: "git push origin main", cwd: x, deps });
assert.ok(r && /catalogued as PRIVATE but the remote is PUBLIC/.test(r.reason), "private index + public remote must block");

// 8. gh repo create --public needs an approval record; with a valid one it passes once.
r = core.evaluate({ command: "gh repo create nextain/brand-new --public --source=.", cwd: ws, deps });
assert.ok(r && /needs a recorded approval/.test(r.reason));
fs.writeFileSync(path.join(ws, core.APPROVAL_RELATIVE), JSON.stringify({
	operation: "create_public", repo: "nextain/brand-new", reason: "test", approved_by: "luke",
	expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
}));
r = core.evaluate({ command: "gh repo create nextain/brand-new --public --source=.", cwd: ws, deps });
assert.strictEqual(r, null, "approved public creation passes");
r = core.evaluate({ command: "gh repo create nextain/brand-new --public --source=.", cwd: ws, deps });
assert.ok(r && /already used/.test(r.reason), "approval is single-use");
r = core.evaluate({ command: "gh repo create nextain/brand-new --private", cwd: ws, deps });
assert.strictEqual(r, null, "private creation is routine");
r = core.evaluate({ command: "gh repo edit nextain/naia-comm --visibility public --accept-visibility-change-consequences", cwd: ws, deps });
assert.ok(r && /needs a recorded approval/.test(r.reason), "exposing a repo needs approval");

// 9. Noise: non-git commands and echo are ignored quickly.
assert.strictEqual(core.evaluate({ command: "ls -la && grep -rn push src", cwd: ws, deps }), null);
assert.strictEqual(core.evaluate({ command: "echo 'git push origin main'", cwd: ws, deps }), null);

// 10b. heredoc bodies are not commands: a commit message or a written file may mention public actions
assert.strictEqual(core.evaluate({ command: "git commit -F - <<'EOF'\nfeat: gate gh repo create --public and git push origin main\nEOF\necho done", cwd: ws, deps }), null);
assert.strictEqual(core.evaluate({ command: "cat > notes.md <<EOF\ngit remote add origin https://github.com/nextain/naia-comm-public.git\nEOF", cwd: ws, deps }), null);
assert.ok(core.evaluate({ command: "cat > x <<EOF\nnothing\nEOF\ngh repo create nextain/after-heredoc --public", cwd: ws, deps }), "a real command after the heredoc is still seen");

// 10. slug parsing
assert.strictEqual(core.slugFromRemote("git@github.com:Nextain/Naia-Comm.git"), "nextain/naia-comm");
assert.strictEqual(core.slugFromRemote("https://github.com/nextain/naia-comm-public"), "nextain/naia-comm-public");
assert.strictEqual(core.slugFromRemote("origin"), null);
assert.strictEqual(core.slugFromRemote("../other"), null);

fs.rmSync(ws, { recursive: true, force: true });
console.log("remote-identity: 10 groups PASS");
