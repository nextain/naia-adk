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
		// review 는 차례를 고른 뒤 리뷰어를 띄우므로 reviewedAt 은 영수증 시작보다 앞선다
		reviewedAt: new Date(Date.now() - 3000).toISOString(),
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
	// 신호로 끝난 실행(null)은 한도로 보지 않는다(관문 skipped exit_code 기준과 같음)
	assert.equal(deployPlan.isLimitFailure(null, "rate limit exceeded"), false);
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
			assert.ok(deployPlan.reviewProblems(gatesDir, planSha, root).problems.some((p) => p.includes("허용되지 않은 모델")), `${author} 차례 밖 리뷰어`);
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

test("관문이 reviewedAt 을 영수증 시작 시각과 대조한다(고정 리뷰어 피하기 막음)", (t) => {
	const { root } = makeWorkspace(t);
	const now = Date.now();
	const file = path.join(root, ".claude/deploy/config.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ planReview: { reviewer: "codex", until: new Date(now + 3600 * 1000).toISOString(), reason: "승인자 결정" } }));
	const { planFile, gatesDir } = createValidPlan(root, { author_model: "muse" });
	const ok = (reviewer, extra) => deployPlan.reviewProblems(gatesDir, writeRotationReceipt(root, planFile, reviewer, extra).planSha, root);
	assert.equal(ok("codex").ok, true, "고정 리뷰어 영수증");
	assert.equal(ok("argon").ok, false, "고정 기한 안 argon");
	// reviewedAt 을 고정 기한 뒤로 옮기면 영수증 시작보다 늦어 막힌다
	const moved = ok("argon", { reviewedAt: new Date(now + 2 * 3600 * 1000).toISOString() });
	assert.ok(moved.problems.some((p) => p.includes("reviewedAt 이 리뷰어 영수증 시작 시각과 맞지 않음")), moved.problems.join("; "));
	// 시각이 없거나 영수증보다 너무 이르면 막는다
	assert.ok(ok("codex", { reviewedAt: undefined }).problems.some((p) => p.includes("reviewedAt(UTC ISO 시각)")));
	assert.ok(ok("codex", { reviewedAt: new Date(now - 3 * 3600 * 1000).toISOString() }).problems.some((p) => p.includes("시작 전 90분 안")));
});

test("관문이 차례 도입 뒤 옛 모양 기록(rotation 칸 없음)을 막는다", (t) => {
	const { root } = makeWorkspace(t);
	const file = path.join(root, ".claude/deploy/config.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ planReview: { reviewer: "codex", until: new Date(Date.now() + 3600 * 1000).toISOString(), reason: "승인자 결정" } }));
	const { planFile, gatesDir } = createValidPlan(root, { author_model: "muse" });
	const cutoff = Date.parse(deployPlan.LEGACY_REVIEW_CUTOFF);
	// 차례 기록에서 rotation·skipped 칸을 지우고 시각을 옮긴 기록(고정 codex 대신 argon)
	const legacy = (at) => {
		const { planSha } = writeRotationReceipt(root, planFile, "argon");
		const recFile = path.join(gatesDir, deployPlan.REVIEW_FILE);
		const rec = JSON.parse(fs.readFileSync(recFile, "utf8"));
		delete rec.rotation;
		delete rec.skipped;
		rec.reviewedAt = new Date(at).toISOString();
		rec.reviewers[0].receipt.started_at = new Date(at - 1000).toISOString();
		fs.writeFileSync(recFile, JSON.stringify(rec, null, 2));
		return deployPlan.reviewProblems(gatesDir, planSha, root);
	};
	const after = legacy(cutoff + 3600 * 1000);
	assert.ok(after.problems.some((p) => p.includes("옛 모양 리뷰 기록")), after.problems.join("; "));
	assert.equal(legacy(cutoff - 3600 * 1000).ok, true, "차례 도입 전 옛 기록은 그대로 받음");
});

// 회차 시험용 가짜 codex: 요청문(마지막 인자)을 prompt-<n>.txt 로 남기고, body.txt 를 리뷰 본문으로 낸다. 실행 횟수는 runs 파일 줄 수.
function writeRoundBins(tmp) {
	const binDir = path.join(tmp, "bin"), fakeHome = path.join(tmp, "home");
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
	fs.writeFileSync(path.join(binDir, "bwrap"), '#!/bin/sh\nwhile [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
	const runs = path.join(tmp, "runs"), bodyFile = path.join(tmp, "body.txt");
	fs.writeFileSync(path.join(binDir, "fake-codex"), `#!/bin/sh\n[ "$1" = exec ] || exit 19\nfor a; do last="$a"; done\necho run >> "${runs}"\nn=$(wc -l < "${runs}" | tr -d ' ')\nprintf '%s' "$last" > "${tmp}/prompt-$n.txt"\nprintf 'codex\\n'\ncat "${bodyFile}"\nprintf 'tokens used\\n'\n`, { mode: 0o755 });
	const review = (root, planFile, body) => {
		fs.writeFileSync(bodyFile, `${body}\n`);
		return spawnSync(process.execPath, [path.join(root, ".agents/scripts/approval-plan.mjs"), "review", planFile, "--author", "argon"], {
			cwd: root, encoding: "utf8", timeout: 30000,
			env: { ...process.env, HOME: fakeHome, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, APPROVAL_PLAN_CODEX_BIN: path.join(binDir, "fake-codex"), DEPLOY_APPROVAL_STATE_DIR: path.join(tmp, "state") },
		});
	};
	const runCount = () => (fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").trim().split("\n").length : 0);
	return { review, runCount, prompt: (n) => fs.readFileSync(path.join(tmp, `prompt-${n}.txt`), "utf8") };
}
const ROUND_FINDING = "1. [차단:되돌리기] rollback — r1 이 교체된 컨테이너를 시작할 수 있음";
const failBody = () => ["판정: FAIL", ...deployPlan.CRITERIA.map(([id]) => `${id}: ${id === "rollback" ? "FAIL" : "PASS"}`), ROUND_FINDING, "참고 지적: 0", "남은 지적: 1"].join("\n");
const passBody = () => ["판정: PASS", ...deployPlan.CRITERIA.map(([id]) => `${id}: PASS`), "참고 지적: 0", "남은 지적: 0"].join("\n");

test("회차 기억: 직전 회차 판정·차단 지적이 요청문에 들어가고, 회차 영수증은 쌓이며 관문이 같은 요청문을 다시 만든다", (t) => {
	const { root, tmp } = makeWorkspace(t);
	const { planFile, gatesDir } = createValidPlan(root, { author_model: "argon" });
	assert.equal(spawnSync("git", ["init", "-q", root], { encoding: "utf8" }).status, 0);
	const bins = writeRoundBins(tmp);
	const first = bins.review(root, planFile, failBody());
	assert.equal(first.status, 1, `${first.stdout}\n${first.stderr}`);
	assert.doesNotMatch(bins.prompt(1), /직전 회차 리뷰/);
	const round1 = path.join(gatesDir, "review-rounds", "round-001.json");
	const round1Bytes = fs.readFileSync(round1);
	assert.equal(JSON.parse(round1Bytes).outcome.verdict, "FAIL");
	// 계획서 한 칸을 고치고 다시 리뷰한다
	const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
	plan.rollback.duration = "2분";
	fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
	const second = bins.review(root, planFile, passBody());
	assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
	const prompt = bins.prompt(2);
	assert.match(prompt, /직전 회차 리뷰\(회차 1, .*판정 FAIL/);
	assert.match(prompt, /- rollback: FAIL/);
	assert.match(prompt, /- correctness: PASS/);
	assert.ok(prompt.includes(`- ${ROUND_FINDING}`), "직전 차단 지적이 요청문에 있어야 함");
	assert.match(prompt, /직전 회차 뒤 바뀐 칸: rollback/);
	assert.ok(prompt.includes("규칙: 바뀌지 않은 부분에서 이전에 PASS 한 기준을 FAIL 로 바꾸려면 이전 판정이 틀린 이유를 적을 것. 새 차단은 이번에 바뀐 부분에서 찾을 것."));
	// 회차 영수증은 덮어쓰지 않고 쌓인다. 최신 판 이름(deploy-plan-review.json)은 그대로 쓴다.
	assert.deepEqual(fs.readFileSync(round1), round1Bytes);
	assert.equal(JSON.parse(fs.readFileSync(path.join(gatesDir, "review-rounds", "round-002.json"), "utf8")).outcome.verdict, "PASS");
	const record = JSON.parse(fs.readFileSync(path.join(gatesDir, deployPlan.REVIEW_FILE), "utf8"));
	assert.equal(record.prior_round.file, "review-rounds/round-001.json");
	const planSha = sha256(fs.readFileSync(planFile));
	const ok = deployPlan.reviewProblems(gatesDir, planSha, root);
	assert.equal(ok.ok, true, ok.problems.join("; "));
	// 직전 회차 파일을 바꾸면 관문이 막는다
	fs.writeFileSync(round1, round1Bytes.toString("utf8").replace("교체된", "바뀐"));
	assert.ok(deployPlan.reviewProblems(gatesDir, planSha, root).problems.some((p) => p.includes("prior_round")));
});

test("회차 상한: 같은 계획서가 연속 3회 FAIL 이면 4회차는 리뷰 없이 사람 판정 요청을 내고 0 아닌 코드로 끝난다", (t) => {
	const { root, tmp } = makeWorkspace(t);
	const { planFile, gatesDir } = createValidPlan(root, { author_model: "argon" });
	assert.equal(spawnSync("git", ["init", "-q", root], { encoding: "utf8" }).status, 0);
	const bins = writeRoundBins(tmp);
	for (let i = 1; i <= 3; i++) assert.equal(bins.review(root, planFile, failBody()).status, 1, `회차 ${i}`);
	assert.equal(bins.runCount(), 3);
	const fourth = bins.review(root, planFile, passBody());
	assert.equal(fourth.status, 4, `${fourth.stdout}\n${fourth.stderr}`);
	assert.equal(bins.runCount(), 3, "4회차 리뷰어를 실행하면 안 됨");
	assert.match(fourth.stderr, /사람 판정 요청: .*연속 3회 FAIL/);
	assert.ok(fourth.stderr.includes(`- ${ROUND_FINDING}`), fourth.stderr);
	assert.match(fourth.stderr, /risk_acceptance/);
	assert.equal(deployPlan.roundFiles(gatesDir).length, 3);
});

test("회차 도입 전 리뷰 기록은 첫 회차로 옮겨 직전 회차로 쓴다", (t) => {
	const { root, tmp } = makeWorkspace(t);
	const { planFile, gatesDir } = createValidPlan(root, { author_model: "argon" });
	assert.equal(spawnSync("git", ["init", "-q", root], { encoding: "utf8" }).status, 0);
	writeRotationReceipt(root, planFile, "codex");
	const bins = writeRoundBins(tmp);
	assert.equal(bins.review(root, planFile, passBody()).status, 0);
	const legacy = JSON.parse(fs.readFileSync(path.join(gatesDir, "review-rounds", "round-001.json"), "utf8"));
	assert.equal(legacy.legacy, true);
	assert.equal(legacy.outcome.verdict, "PASS");
	assert.match(bins.prompt(1), /직전 회차 리뷰\(회차 1, .*판정 PASS/);
	assert.equal(deployPlan.roundFiles(gatesDir).length, 2);
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
