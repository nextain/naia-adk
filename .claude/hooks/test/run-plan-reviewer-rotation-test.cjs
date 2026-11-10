"use strict";
// 차례 리뷰어(rotation) 관문 시험: 작성자 다음 모델이 먼저 리뷰하고, 한도 실패 때만 넘어간다.
// 실행: node .claude/hooks/test/run-plan-reviewer-rotation-test.cjs (CI 에도 등록됨)
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const deployPlan = require("../lib/deploy-plan.js");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function makeWorkspace(t) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reviewer-rotation-test-"));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const root = path.join(tmp, "workspace");
	const stateDir = path.join(tmp, "state");
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	for (const rel of deployPlan.REVIEW_EXECUTOR_FILES) {
		const src = path.join(REPO_ROOT, rel);
		const dst = path.join(root, rel);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(src, dst);
	}
	return { tmp, root, stateDir };
}

function createValidPlan(root, overrides = {}) {
	const gatesDir = path.join(root, ".agents", "progress", "sample-work", "gates");
	fs.mkdirSync(gatesDir, { recursive: true });
	const scriptRel = "scripts/rollout.sh";
	const scriptAbs = path.join(root, scriptRel);
	fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
	if (!fs.existsSync(scriptAbs)) {
		fs.writeFileSync(scriptAbs, "#!/usr/bin/env bash\naz containerapp update -n sample-web-prod -g sample-rg --image sample/web:v1\n");
	}
	const scriptSha = sha256(fs.readFileSync(scriptAbs));
	const plan = {
		schema: "deploy-plan/v1",
		author_model: "muse",
		approval_mode: "preapprove_steps",
		planId: "sample-web-rollout-01",
		createdAt: new Date().toISOString(),
		services: ["azure:containerapp:sample-web-prod"],
		what_why: "샘플 웹 서비스를 v1 이미지로 갱신하여 기능 개선을 반영합니다.",
		changes: ["컨테이너 이미지 sample/web:v1 반영"],
		scenario: [
			{
				id: "s1",
				title: "v1 이미지 배포",
				commands: [`bash ${scriptRel} prod`],
				files: { [scriptRel]: scriptSha },
				success_check: "헬스체크 200 응답 확인",
				on_failure: "r1 단계로 이전 리비전을 즉시 활성화하고 보고",
			},
			{
				id: "r1",
				branch: "rollback",
				title: "이전 리비전으로 복귀",
				commands: ["az containerapp revision activate -n sample-web-prod -g sample-rg --revision sample-web-prod--prev"],
				success_check: "이전 리비전 트래픽 100% 및 헬스 200 확인",
				on_failure: "트래픽 차단 후 즉시 운영팀에 보고",
			},
		],
		risks: {
			items: ["신규 리비전 기동 지연 가능성"],
			worst_case: "신규 리비전 응답 실패로 최대 2분간 오류 발생",
		},
		irreversible: ["없음: 컨테이너 이미지 교체만 수행하며 스키마 변경 없음"],
		disconnect_safety: "터미널이 끊겨도 az containerapp revision list 로 상태를 확인하고 r1 명령으로 수동 복귀 가능",
		rerun_safety: {
			lock: "동일 리비전 이름 고정으로 중복 실행 방지",
			run_dir: ".agents/progress/sample-work 고유 폴더 사용",
			no_latest_pick: "명시적 이미지 태그 sample/web:v1 지정",
		},
		success_verification: "운영 헬스 엔드포인트 200 및 주요 화면 응답 확인",
		rollback: {
			method: "r1 단계의 az containerapp revision activate 명령으로 이전 리비전 복귀",
			duration: "1분",
			step_ids: ["r1"],
		},
		residual_risks: ["전환 순간 열린 연결 일부 재시도 발생 가능"],
		incident: {
			criteria: ["5xx 응답 비율 5% 초과 또는 헬스체크 3회 연속 실패"],
			actions: [],
		},
		...overrides,
	};
	const planFile = path.join(gatesDir, "deploy-plan.json");
	fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
	return { planFile, gatesDir, plan };
}

// 차례 기록(rotation:true) 영수증을 손으로 적는다. 리뷰어 1명만 둔다.
function writeRotationReceipt(root, planFile, reviewer, extra = {}) {
	const gatesDir = path.dirname(planFile);
	const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
	const planSha = sha256(fs.readFileSync(planFile));
	const prompt = deployPlan.reviewPrompt(plan, planSha, root);
	const promptSha = sha256(prompt);
	const manifestSha = deployPlan.reviewInputManifest(planFile, root);
	const body = ["판정: PASS", ...deployPlan.CRITERIA.map(([id]) => `${id}: PASS`), "참고 지적: 0", "남은 지적: 0", ""].join("\n");
	const stdoutSha = sha256(body);
	const finalText = `${body}review-run: target_sha256=${planSha} prompt_sha256=${promptSha} stdout_sha256=${stdoutSha}\n`;
	const resultRel = `deploy-plan-review-${reviewer}.md`;
	fs.writeFileSync(path.join(gatesDir, resultRel), finalText);
	const endedAt = new Date().toISOString();
	const record = {
		plan_sha256: planSha,
		plan: path.relative(root, planFile),
		author_model: plan.author_model,
		prompt_sha256: promptSha,
		rotation: true,
		skipped: [],
		reviewers: [
			{
				model: deployPlan.REVIEW_MODELS[reviewer].model,
				effort: deployPlan.REVIEW_MODELS[reviewer].effort,
				result: resultRel,
				result_sha256: sha256(finalText),
				target_sha256: planSha,
				receipt: {
					model: deployPlan.REVIEW_MODELS[reviewer].model,
					started_at: new Date(Date.now() - 2000).toISOString(),
					ended_at: endedAt,
					exit_code: 0,
					prompt_sha256: promptSha,
					stdout_sha256: stdoutSha,
					input_manifest_sha256: manifestSha,
					isolation: "snapshot-only",
				},
			},
		],
		reviewedAt: endedAt,
		...extra,
	};
	fs.writeFileSync(path.join(gatesDir, deployPlan.REVIEW_FILE), JSON.stringify(record, null, 2));
	return { planSha, promptSha, manifestSha };
}

test("차례: 작성자 다음 모델이 먼저, 나머지가 다음", (t) => {
	const { root } = makeWorkspace(t);
	assert.deepEqual(deployPlan.rotationOrder("argon"), ["codex", "muse"]);
	assert.deepEqual(deployPlan.rotationOrder("codex"), ["muse", "argon"]);
	assert.deepEqual(deployPlan.rotationOrder("muse"), ["argon", "codex"]);
	assert.deepEqual(deployPlan.rotationOrder("sol"), []);
	// 고정 설정이 없으면 차례만 쓴다
	assert.deepEqual(deployPlan.orderedReviewers("muse", root), ["argon", "codex"]);
	assert.deepEqual(deployPlan.orderedReviewers("argon", root), ["codex", "muse"]);
	assert.deepEqual(deployPlan.orderedReviewers("codex", root), ["muse", "argon"]);
	// 작성자 자신은 절대 리뷰하지 않는다
	for (const author of deployPlan.ROTATION) {
		assert.ok(!deployPlan.orderedReviewers(author, root).includes(author), author);
	}
});

test("고정 planReview: 유효하면 먼저 쓰고, 지났거나 없으면 차례만 쓴다", (t) => {
	const { root } = makeWorkspace(t);
	const now = Date.now();
	const file = path.join(root, ".claude/deploy/config.json");
	const set = (planReview) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(planReview === undefined ? {} : { planReview })); };
	set({ reviewer: "codex", until: new Date(now + 60000).toISOString(), reason: "승인자 결정" });
	assert.deepEqual(deployPlan.orderedReviewers("muse", root, now), ["codex", "argon"]);
	set({ reviewer: "muse", until: new Date(now + 60000).toISOString(), reason: "승인자 결정" });
	assert.deepEqual(deployPlan.orderedReviewers("argon", root, now), ["muse", "codex"]);
	// 기한이 지났으면 차례만 쓴다
	set({ reviewer: "codex", until: new Date(now - 60000).toISOString(), reason: "승인자 결정" });
	assert.deepEqual(deployPlan.orderedReviewers("muse", root, now), ["argon", "codex"]);
	// until 이 없으면 차례만 쓴다
	set({ reviewer: "codex", reason: "승인자 결정" });
	assert.deepEqual(deployPlan.orderedReviewers("muse", root, now), ["argon", "codex"]);
	// 작성자 자신을 고정했으면 차례만 쓴다
	set({ reviewer: "muse", until: new Date(now + 60000).toISOString(), reason: "승인자 결정" });
	assert.deepEqual(deployPlan.orderedReviewers("muse", root, now), ["argon", "codex"]);
	// 형식이 틀리면 던진다: 차례 밖 리뷰어, 읽을 수 없는 until, 객체 아님
	set({ reviewer: "sol", until: new Date(now + 60000).toISOString(), reason: "승인자 결정" });
	assert.throws(() => deployPlan.orderedReviewers("muse", root, now), /reviewer/);
	set({ reviewer: "codxe", until: "not-a-date" });
	assert.throws(() => deployPlan.orderedReviewers("muse", root, now), /reviewer/);
	set({ reviewer: "codex", until: "not-a-date" });
	assert.throws(() => deployPlan.orderedReviewers("muse", root, now), /until/);
	set("codex");
	assert.throws(() => deployPlan.orderedReviewers("muse", root, now), /형식/);
	// 설정 JSON 깨짐은 예전처럼 던진다
	fs.writeFileSync(file, "{");
	assert.throws(() => deployPlan.orderedReviewers("muse", root, now));
});

test("한도 판별식: 종료 코드가 0이 아니고 출력이 맞을 때만 참", () => {
	assert.equal(deployPlan.isLimitFailure(1, "Error: rate limit exceeded"), true);
	assert.equal(deployPlan.isLimitFailure(1, "quota exceeded for project"), true);
	assert.equal(deployPlan.isLimitFailure(1, "429 too many requests"), true);
	assert.equal(deployPlan.isLimitFailure(1, "RESOURCE_EXHAUSTED: try again"), true);
	assert.equal(deployPlan.isLimitFailure(1, "usage limit reached"), true);
	assert.equal(deployPlan.isLimitFailure(1, "capacity exhausted"), true);
	assert.equal(deployPlan.isLimitFailure(0, "rate limit exceeded"), false);
	assert.equal(deployPlan.isLimitFailure(1, "boom: something broke"), false);
	assert.equal(deployPlan.isLimitFailure(1, ""), false);
});

function writeFakeBins(tmp, { argonBody, argonStderr = "", argonStatus = 0, codexBody, codexStatus = 0, withMarker = false }) {
	const binDir = path.join(tmp, "bin");
	const fakeHome = path.join(tmp, "home");
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
	fs.mkdirSync(path.join(fakeHome, ".gemini"), { recursive: true });
	const bwrap = path.join(binDir, "bwrap");
	fs.writeFileSync(bwrap, '#!/bin/sh\nwhile [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
	const marker = path.join(tmp, "codex-ran");
	const passBody = ["판정: PASS", ...deployPlan.CRITERIA.map(([id]) => `${id}: PASS`), "참고 지적: 0", "남은 지적: 0"].join("\n");
	const argon = path.join(binDir, "fake-agy");
	fs.writeFileSync(argon, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "${argonBody}"\nprintf '%s\\n' "${argonStderr}" >&2\nexit ${argonStatus}\n`, { mode: 0o755 });
	const codex = path.join(binDir, "fake-codex");
	fs.writeFileSync(codex, `#!/bin/sh\n${withMarker ? `: > "${marker}"\n` : ""}[ "$1" = exec ] || exit 19\n[ -z "$(cat)" ] || exit 20\nprintf 'codex\\n'\ncat <<'REVIEW_EOF'\n${codexBody ?? passBody}\nREVIEW_EOF\nprintf 'tokens used\\n'\nexit ${codexStatus}\n`, { mode: 0o755 });
	return { binDir, fakeHome, marker };
}

test("한도 실패에서 다음 차례로 넘어간다 (가짜 실행 파일)", (t) => {
	const { root, tmp, stateDir } = makeWorkspace(t);
	const { planFile, gatesDir } = createValidPlan(root);
	assert.equal(spawnSync("git", ["init", "-q", root], { encoding: "utf8" }).status, 0);
	const { binDir, fakeHome } = writeFakeBins(tmp, { argonBody: "", argonStderr: "Error: request hit rate limit, retry later", argonStatus: 1 });
	const run = spawnSync(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), "review", planFile, "--author", "muse"], {
		cwd: root, encoding: "utf8", timeout: 30000,
		env: { ...process.env, HOME: fakeHome, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, APPROVAL_PLAN_ARGON_BIN: path.join(binDir, "fake-agy"), APPROVAL_PLAN_CODEX_BIN: path.join(binDir, "fake-codex"), DEPLOY_APPROVAL_STATE_DIR: stateDir },
	});
	assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
	const record = JSON.parse(fs.readFileSync(path.join(gatesDir, deployPlan.REVIEW_FILE), "utf8"));
	assert.equal(record.rotation, true);
	assert.equal(record.skipped.length, 1);
	assert.equal(record.skipped[0].id, "argon");
	assert.equal(record.skipped[0].reason, "limit");
	assert.equal(record.skipped[0].exit_code, 1);
	assert.equal(record.reviewers.length, 1);
	assert.equal(record.reviewers[0].id, "codex");
	assert.match(fs.readFileSync(path.join(gatesDir, record.reviewers[0].result), "utf8"), /review-run: .*\n$/);
	const planSha = sha256(fs.readFileSync(planFile));
	assert.equal(deployPlan.reviewProblems(gatesDir, planSha, root).ok, true);
});

test("한도가 아닌 실패에서는 넘어가지 않는다", (t) => {
	const { root, tmp, stateDir } = makeWorkspace(t);
	const { planFile, gatesDir } = createValidPlan(root);
	assert.equal(spawnSync("git", ["init", "-q", root], { encoding: "utf8" }).status, 0);
	const { binDir, fakeHome, marker } = writeFakeBins(tmp, { argonBody: "boom: reviewer crashed", argonStatus: 2, withMarker: true });
	const run = spawnSync(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), "review", planFile, "--author", "muse"], {
		cwd: root, encoding: "utf8", timeout: 30000,
		env: { ...process.env, HOME: fakeHome, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, APPROVAL_PLAN_ARGON_BIN: path.join(binDir, "fake-agy"), APPROVAL_PLAN_CODEX_BIN: path.join(binDir, "fake-codex"), DEPLOY_APPROVAL_STATE_DIR: stateDir },
	});
	assert.notEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
	assert.equal(fs.existsSync(marker), false, "다음 차례 리뷰어를 실행하면 안 됨");
	const record = JSON.parse(fs.readFileSync(path.join(gatesDir, deployPlan.REVIEW_FILE), "utf8"));
	assert.equal(record.rotation, true);
	assert.deepEqual(record.skipped, []);
	assert.equal(record.reviewers.length, 1);
	assert.equal(record.reviewers[0].id, "argon");
	assert.ok(record.reviewers[0].execution_error, "실행 실패가 기록에 남아야 함");
});

test("관문이 차례 영수증을 받는다 (작성자 셋 전부)", (t) => {
	for (const author of ["argon", "codex", "muse"]) {
		const { root } = makeWorkspace(t);
		const reviewer = deployPlan.rotationOrder(author)[0];
		const { planFile, gatesDir } = createValidPlan(root, { author_model: author });
		assert.ok(!deployPlan.formProblems(JSON.parse(fs.readFileSync(planFile, "utf8"))).some((p) => p.includes("author_model")), author);
		const { planSha } = writeRotationReceipt(root, planFile, reviewer);
		const result = deployPlan.reviewProblems(gatesDir, planSha, root);
		assert.equal(result.ok, true, `${author}→${reviewer}: ${result.problems.join("; ")}`);
	}
});

// 기록의 첫 리뷰어를 다른 모델로 통째로 바꾼다(id·model·effort·receipt.model 함께). 바꾼 규칙 하나만 걸리게 하려고.
function swapReviewer(file, id) {
	const record = JSON.parse(fs.readFileSync(file, "utf8"));
	const r = record.reviewers[0];
	r.id = id;
	r.model = deployPlan.REVIEW_MODELS[id].model;
	r.effort = deployPlan.REVIEW_MODELS[id].effort;
	r.receipt.model = r.model;
	fs.writeFileSync(file, JSON.stringify(record));
}

test("관문이 같은 모델·차례 밖 리뷰어·새 모양 2인 영수증을 막는다", (t) => {
	for (const author of ["argon", "codex", "muse"]) {
		const { root } = makeWorkspace(t);
		const { planFile, gatesDir } = createValidPlan(root, { author_model: author });
		const file = path.join(gatesDir, deployPlan.REVIEW_FILE);
		const [good, other] = deployPlan.rotationOrder(author);
		// 같은 모델이 리뷰하면 막는다(id·강도까지 맞춘 자기 리뷰)
		{
			const { planSha } = writeRotationReceipt(root, planFile, good);
			swapReviewer(file, author);
			// 차례 대조도 함께 막으므로, 이 규칙 자체가 살아 있는지 지적 문구로 본다
			assert.ok(deployPlan.reviewProblems(gatesDir, planSha, root).problems.some((p) => p.includes("작성자와 같은 모델이 리뷰함")), `${author} 스스로 리뷰`);
		}
		// 차례 밖 모델(sol)이 리뷰하면 막는다
		{
			const { planSha } = writeRotationReceipt(root, planFile, good);
			swapReviewer(file, "sol");
			assert.equal(deployPlan.reviewProblems(gatesDir, planSha, root).ok, false, `${author} 차례 밖 리뷰어`);
		}
		// 새 모양에 서로 다른 유효 리뷰어 2명이면 막는다
		{
			writeRotationReceipt(root, planFile, other);
			const second = JSON.parse(fs.readFileSync(file, "utf8")).reviewers[0];
			const { planSha } = writeRotationReceipt(root, planFile, good);
			const record = JSON.parse(fs.readFileSync(file, "utf8"));
			record.reviewers.push(second);
			fs.writeFileSync(file, JSON.stringify(record));
			assert.ok(deployPlan.reviewProblems(gatesDir, planSha, root).problems.some((p) => p.includes("리뷰어 1명의 기록이 필요함")), `${author} 새 모양 2인`);
		}
	}
});

test("관문이 차례와 skipped 를 대조한다", (t) => {
	for (const author of ["argon", "codex", "muse"]) {
		const { root } = makeWorkspace(t);
		const { planFile, gatesDir } = createValidPlan(root, { author_model: author });
		const file = path.join(gatesDir, deployPlan.REVIEW_FILE);
		const [first, second] = deployPlan.rotationOrder(author);
		const limit = (id, extra = {}) => ({ id, reason: "limit", exit_code: 1, ended_at: new Date().toISOString(), ...extra });
		const check = (reviewer, skipped) => {
			const { planSha } = writeRotationReceipt(root, planFile, reviewer, { skipped });
			return deployPlan.reviewProblems(gatesDir, planSha, root).ok;
		};
		assert.equal(check(second, [limit(first)]), true, `${author} 한도 기록 뒤 둘째`);
		assert.equal(check(second, []), false, `${author} 한도 기록 없이 둘째`);
		assert.equal(check(second, [limit(second)]), false, `${author} 리뷰어 자신을 skipped`);
		assert.equal(check(second, [limit(first), limit(first)]), false, `${author} skipped 중복`);
		{
			const { planSha } = writeRotationReceipt(root, planFile, second, { skipped: [limit(first), limit(first)] });
			assert.ok(deployPlan.reviewProblems(gatesDir, planSha, root).problems.some((p) => p.includes("skipped 는 최대 1개")), `${author} skipped 2개 규칙`);
		}
		assert.equal(check(second, [limit(first, { exit_code: 0 })]), false, `${author} 종료 0 skipped`);
		assert.equal(check(first, [limit(first)]), false, `${author} 건너뛴 후보가 리뷰`);
		const { planSha } = writeRotationReceipt(root, planFile, first);
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		delete record.skipped;
		fs.writeFileSync(file, JSON.stringify(record));
		assert.equal(deployPlan.reviewProblems(gatesDir, planSha, root).ok, false, `${author} skipped 없음`);
	}
});

test("리뷰 본문의 한도 낱말로는 넘어가지 않는다", (t) => {
	const { root, tmp, stateDir } = makeWorkspace(t);
	const { planFile } = createValidPlan(root);
	assert.equal(spawnSync("git", ["init", "-q", root], { encoding: "utf8" }).status, 0);
	const { binDir, fakeHome, marker } = writeFakeBins(tmp, { argonBody: "판정: FAIL; 계획의 quota 설정이 틀림 429 rate limit", argonStatus: 1, withMarker: true });
	const run = spawnSync(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), "review", planFile, "--author", "muse"], {
		cwd: root, encoding: "utf8", timeout: 30000,
		env: { ...process.env, HOME: fakeHome, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, APPROVAL_PLAN_ARGON_BIN: path.join(binDir, "fake-agy"), APPROVAL_PLAN_CODEX_BIN: path.join(binDir, "fake-codex"), DEPLOY_APPROVAL_STATE_DIR: stateDir },
	});
	assert.notEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
	assert.equal(fs.existsSync(marker), false, "본문 낱말로 다음 리뷰어를 실행하면 안 됨");
});
