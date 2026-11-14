const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lead-write-guard-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const put = (file, text = "x\n") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// 픽스처: 복사한 훅(ADK 루트가 픽스처가 되도록), 역할 폴더, 저장소 둘, 저장소 밖 작업 폴더.
const adk = path.join(scratch, "adk");
const hookDir = path.join(adk, ".claude/hooks");
for (const f of ["lead-write-guard.js", "tool-names.js", "lib/effective-argv.js", "lib/git-command-parser.js", "lib/lead-guard.js"]) put(path.join(hookDir, f), fs.readFileSync(path.join(__dirname, f), "utf8"));
fs.mkdirSync(path.join(adk, ".git"));
const role = path.join(scratch, "role");
put(path.join(role, ".naia-role.json"), JSON.stringify({ role: "minho", lead_guard: { enabled: true, protect: [path.join(scratch, "kit")] } }));
const plainRole = path.join(scratch, "plain-role"); // 켜지 않은 역할 폴더
put(path.join(plainRole, ".naia-role.json"), JSON.stringify({ role: "other" }));
const repo = path.join(scratch, "repo");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
put(path.join(repo, "src/app.js"), "a\n");
put(path.join(repo, "docs/common/minho/report.md"), "r\n");
const work = path.join(scratch, "work/job");
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.join(scratch, "kit"), { recursive: true });
fs.symlinkSync(path.join(repo, "src"), path.join(work, "link-to-src"));
fs.symlinkSync(path.join(repo, "src/app.js"), path.join(work, "link-to-app.js"));
const fakeClaude = path.join(scratch, "bin/claude");
// HOOK_ENV_PROJECT 는 훅 프로세스의 환경만 바꾼다(조상 claude 의 시작 환경 /proc/<pid>/environ 은 그대로).
put(fakeClaude, '#!/bin/sh\n[ -n "$HOOK_ENV_PROJECT" ] && export CLAUDE_PROJECT_DIR="$HOOK_ENV_PROJECT"\nnode "$HOOK" < "$INPUT"\n');
fs.chmodSync(fakeClaude, 0o755);

let seq = 0;
// 가짜 claude(sh 스크립트)가 훅의 부모가 되어, 훅은 실제처럼 조상 프로세스에서 claude 와 -p 를 읽는다.
function run(payload, { headless = false, projectDir = role, env = {}, cwd = role } = {}) {
	const input = path.join(scratch, `in-${++seq}.json`);
	fs.writeFileSync(input, JSON.stringify({ session_id: "s1", cwd, ...payload }));
	const r = spawnSync(fakeClaude, headless ? ["-p", "일"] : [], {
		cwd, encoding: "utf8",
		env: { ...process.env, HOOK: path.join(hookDir, "lead-write-guard.js"), INPUT: input, CLAUDE_PROJECT_DIR: projectDir, ...env },
	});
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const bash = (command, o) => run({ tool_name: "Bash", tool_input: { command } }, o);
const edit = (tool, file, o) => run({ tool_name: tool, tool_input: { file_path: file, content: "x", old_string: "a", new_string: "b" } }, o);
const blocked = (r) => assert.equal(r && r.decision, "block", JSON.stringify(r));
const passed = (r) => assert.equal(r, null, JSON.stringify(r));

test("3층: Edit·Write·NotebookEdit 로 저장소 코드 쓰기는 막히고, 안내문에 지시서와 한 줄 예시가 있다", () => {
	const r = edit("Edit", path.join(repo, "src/app.js"));
	blocked(r);
	assert.match(r.reason, /지시서/);
	assert.match(r.reason, /claude -p/);
	blocked(edit("Write", path.join(repo, "src/new.js")));
	blocked(run({ tool_name: "NotebookEdit", tool_input: { notebook_path: path.join(repo, "n.ipynb") } }));
	blocked(run({ tool_name: "apply_patch", tool_input: { input: `*** Begin Patch\n*** Update File: ${path.join(repo, "src/app.js")}\n*** End Patch` } }));
});

test("3층: 셸 쓰기(sed -i, cat >, tee, python, cd 접두, cp, git apply)가 막힌다", () => {
	const app = path.join(repo, "src/app.js");
	blocked(bash(`sed -i 's/a/b/' ${app}`));
	blocked(bash(`cat > ${app} <<'E'\nhello\nE`));
	blocked(bash(`echo hi | tee ${app}`));
	blocked(bash(`echo hi >> ${app}`));
	blocked(bash(`python3 -c "open('${app}','w').write('x')"`));
	blocked(bash(`node -e "require('fs').writeFileSync('${app}','x')"`));
	blocked(bash(`cd ${repo}/src && echo hi > app.js`));
	blocked(bash(`cd ${repo} && sed -i 's/a/b/' src/app.js`));
	blocked(bash(`cp ${work}/x ${app}`));
	blocked(bash(`rm ${app}`));
	blocked(bash(`mv ${app} ${work}/gone.js`));
	blocked(bash(`bash -c "echo hi > ${app}"`));
	blocked(bash(`cd ${repo} && git restore src/app.js`));
});

test("3층: 심볼릭 링크를 거쳐도 실제 경로로 막는다", () => {
	blocked(bash(`echo hi > ${path.join(work, "link-to-app.js")}`));
	blocked(bash(`echo hi > ${path.join(work, "link-to-src/new.js")}`));
	blocked(edit("Write", path.join(work, "link-to-src/new2.js")));
});

test("3층: 허용 경로는 통과한다(지시서·결과, 임시 파일, 진행 기록, 역할 문서, 읽기·git 상태)", () => {
	passed(edit("Write", path.join(work, "prompt.md")));
	passed(bash(`cat > ${work}/prompt.md <<'E'\n지시\nE`));
	passed(bash(`echo ok > ${work}/result.md`));
	passed(bash(`echo ok > /tmp/discord-body-${process.pid}.txt`));
	passed(edit("Write", path.join(adk, ".agents/progress/lead/log.md")));
	passed(edit("Write", path.join(repo, "docs/common/minho/report.md")));
	passed(bash(`cd ${repo} && git status && cat src/app.js && grep -n a src/app.js`));
	passed(bash(`cd ${repo} && git commit -m x`));
	passed(bash(`sed -n 1,5p ${repo}/src/app.js`));
	passed(bash(`claude -p "일" > ${work}/out.log 2>&1 &`));
});

test("자기 보호: 역할 표지·예외 기록·훅 등록·protect 경로는 3층이 못 바꾼다", () => {
	blocked(edit("Edit", path.join(role, ".naia-role.json")));
	blocked(bash(`sed -i 's/true/false/' ${role}/.naia-role.json`));
	blocked(bash(`echo '{}' > ${adk}/.agents/lead-guard/exception.json`));
	blocked(edit("Write", path.join(adk, ".agents/lead-guard/exception.json")));
	blocked(edit("Write", path.join(os.homedir(), ".claude/settings.json")));
	blocked(edit("Write", path.join(scratch, "kit/liveness.py")));
	blocked(bash(`node ${adk}/scripts/lead-guard-exception.mjs open --scope /a/b/c`));
	passed(bash(`node ${adk}/scripts/lead-guard-exception.mjs status`));
});

test("2층 일꾼은 막히지 않는다: 헤드리스 claude -p, 서브에이전트, 표지 없는 세션, 켜지 않은 역할", () => {
	const o = { headless: true };
	passed(edit("Write", path.join(repo, "src/app.js"), o));
	passed(bash(`sed -i 's/a/b/' ${repo}/src/app.js`, o));
	passed(run({ tool_name: "Edit", agent_id: "sub1", tool_input: { file_path: path.join(repo, "src/app.js") } }));
	passed(edit("Write", path.join(repo, "src/app.js"), { projectDir: repo, cwd: repo }));
	passed(edit("Write", path.join(repo, "src/app.js"), { projectDir: plainRole, cwd: plainRole }));
});

test("역할 위장: 환경 변수만 바꿔도, 명령 앞에 변수를 붙여도 풀리지 않는다", () => {
	const app = path.join(repo, "src/app.js");
	const spoof = { NAIA_ROLE: "worker", ADK_SESSION_ROLE: "worker", NAIA_LEAD_GUARD: "off", LEAD_ROLE_GUARD_DISABLED: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-cli", HOOK_ENV_PROJECT: repo };
	blocked(edit("Write", app, { env: spoof, projectDir: role }));
	blocked(bash(`NAIA_ROLE=worker ADK_SESSION_ROLE=worker echo hi > ${app}`));
	blocked(bash(`export NAIA_ROLE=worker; env -u NAIA_ROLE sh -c 'echo hi > ${app}'`));
	// 실제 환경(CLAUDE_PROJECT_DIR)이 바뀌어도 조상 claude 가 띄운 폴더가 정한다: 가짜 claude 는 role 에서 떴다.
	blocked(bash(`echo hi > ${app}`, { env: { HOOK_ENV_PROJECT: repo }, projectDir: role }));
});

test("비상 길: 대표님이 연 예외 기록 하나만 범위 안 쓰기를 허용하고, 감사 기록에 남으며, 만료·불량은 무효", () => {
	const ex = path.join(adk, ".agents/lead-guard/exception.json");
	const audit = path.join(adk, ".agents/lead-guard/audit.jsonl");
	const target = path.join(repo, "src/hotfix.js");
	const rec = (over = {}) => ({ id: "EX-1", approved_by: "대표님", approval_ref: "11/14 대표님 긴급 허락 원문", reason: "긴급", scope: [path.join(repo, "src")], created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString(), ...over });
	blocked(edit("Write", target));
	put(ex, JSON.stringify(rec()));
	passed(edit("Write", target));
	passed(bash(`echo hi > ${target}`));
	blocked(edit("Write", path.join(repo, "other/x.js"))); // 범위 밖
	blocked(edit("Write", path.join(role, ".naia-role.json"))); // 자기 보호는 예외로도 안 풀림
	assert.match(fs.readFileSync(audit, "utf8"), /"event":"exception-used"[^\n]*"exception_id":"EX-1"/);
	assert.match(fs.readFileSync(audit, "utf8"), /"event":"block"/);
	put(ex, JSON.stringify(rec({ expires_at: new Date(Date.now() - 1000).toISOString() })));
	blocked(edit("Write", target));
	put(ex, JSON.stringify(rec({ expires_at: new Date(Date.now() + 30 * 3600e3).toISOString() }))); // 8시간 상한
	blocked(edit("Write", target));
	put(ex, JSON.stringify(rec({ approval_ref: "" })));
	blocked(edit("Write", target));
	put(ex, JSON.stringify(rec({ scope: ["/"] })));
	blocked(edit("Write", target));
	fs.rmSync(ex);
	blocked(edit("Write", target));
});

test("예외 대본: 일꾼·사람 자리에서는 열리고 기록과 감사가 남고, 3층 세션에서는 거부된다", () => {
	fs.mkdirSync(path.join(adk, "scripts"), { recursive: true });
	fs.copyFileSync(path.join(__dirname, "../../scripts/lead-guard-exception.mjs"), path.join(adk, "scripts/lead-guard-exception.mjs"));
	const args = ["open", "--scope", path.join(repo, "src"), "--ttl-min", "30", "--approved-by", "대표님", "--approval-ref", "11/14 대표님 긴급 허락 원문", "--reason", "긴급"];
	const script = path.join(adk, "scripts/lead-guard-exception.mjs");
	const human = spawnSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
	assert.equal(human.status, 0, human.stderr);
	assert.match(fs.readFileSync(path.join(adk, ".agents/lead-guard/audit.jsonl"), "utf8"), /"event":"exception-open"/);
	passed(edit("Write", path.join(repo, "src/viaexc.js")));
	assert.equal(spawnSync("node", [script, "close"], { encoding: "utf8" }).status, 0);
	blocked(edit("Write", path.join(repo, "src/viaexc.js")));
	// 3층 세션 안(조상이 role 에서 뜬 claude)에서 돌리면 거부
	const wrapper = path.join(scratch, "bin2/claude");
	put(wrapper, `#!/bin/sh\nnode "${script}" "$@"\n`);
	fs.chmodSync(wrapper, 0o755);
	const denied = spawnSync(wrapper, args, { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: role } });
	assert.notEqual(denied.status, 0);
	assert.match(denied.stderr, /3층 세션/);
	assert.equal(fs.existsSync(path.join(adk, ".agents/lead-guard/exception.json")), false);
	// 3층이 일꾼(claude -p)을 띄워 대신 열게 하는 길: 조상에 3층 claude 가 있으면 거부
	const inner = path.join(scratch, "bin3/claude");
	put(inner, `#!/bin/sh\nnode "${script}" "$@"\n`);
	fs.chmodSync(inner, 0o755);
	const outer = path.join(scratch, "bin4/claude");
	put(outer, `#!/bin/sh\n"${inner}" -p x "$@"\n`);
	fs.chmodSync(outer, 0o755);
	const viaWorker = spawnSync(outer, args, { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: role } });
	assert.notEqual(viaWorker.status, 0, viaWorker.stdout);
	assert.equal(fs.existsSync(path.join(adk, ".agents/lead-guard/exception.json")), false);
});

test("훅이 깨져도 통과한다(기본 허용): 잘못된 입력", () => {
	const r = spawnSync(fakeClaude, [], { encoding: "utf8", env: { ...process.env, HOOK: path.join(hookDir, "lead-write-guard.js"), INPUT: "/dev/null", CLAUDE_PROJECT_DIR: role } });
	assert.equal(r.status, 0);
	assert.equal(r.stdout.trim(), "");
});
