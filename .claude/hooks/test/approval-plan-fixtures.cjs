"use strict";
// Approval gate tests: fixtures.


const test = require("node:test");

const assert = require("node:assert/strict");

const crypto = require("node:crypto");

const fs = require("node:fs");

const os = require("node:os");

const path = require("node:path");

const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");

const HOOK_PATH = path.join(REPO_ROOT, ".claude/hooks/deploy-guard.js");

const SCRIPT_PATH = path.join(REPO_ROOT, ".agents/scripts/approval-plan.mjs");

const deployPlan = require("../lib/deploy-plan.js");

const { assessReadiness } = require("../lib/deploy-readiness.js");

const { classifyProdMutations } = require("../lib/deploy-command-classifier.js");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const ISSUED_APPROVAL_CODE = /\b(?:PLAN|STEP)-[0-9A-F]{64}\b/;

function makeWorkspace(t) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sample-approval-plan-gate-test-"));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const root = path.join(tmp, "workspace");
	const stateDir = path.join(tmp, "state");
	const transcriptPath = path.join(tmp, "transcript.jsonl");
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(transcriptPath, "");

	// Copy executor files into workspace so reviewInputManifest(planFile, root) binds to them
	for (const rel of deployPlan.REVIEW_EXECUTOR_FILES) {
		const src = path.join(REPO_ROOT, rel);
		const dst = path.join(root, rel);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(src, dst);
	}
	return { tmp, root, stateDir, transcriptPath };
}

// Test-only child entrypoint: all Discord reads are supplied by this mock fetch.
function approvedRunner(root, tmp, planFile, argv = ["review", planFile, "--author", "muse"]) {
 const cli = path.join(root, ".agents/scripts/approval-plan.mjs");
 const runner = path.join(tmp, "run-approved.mjs");
 fs.writeFileSync(runner, `import {runApprovedApprovalPlan} from ${JSON.stringify(require("node:url").pathToFileURL(cli).href)};\n` +
  `const {createRequire} = await import('node:module'); const req = createRequire(import.meta.url);\n` +
  `const pin = req(${JSON.stringify(path.join(root, ".claude/hooks/lib/gate-config-pin.js"))});\n` +
  `const root = ${JSON.stringify(root)}, plan = ${JSON.stringify(planFile)};\n` +
  `const id='123456789012345678', channel='234567890123456789', message='345678901234567890';\n` +
  `const code=pin.approvalCode(pin.snapshotGateConfig(root).hash);\n` +
  `await runApprovedApprovalPlan({root, approverId:id, token:'test-only', refs:[{code,channelId:channel,messageId:message}], fetchImpl:async()=>({ok:true,json:async()=>({id:message,channel_id:channel,author:{id},content:code})})}, ${JSON.stringify(argv)});\n`);
 return runner;
}

function writeGateConfig(root, extra = {}) {
	const cfgPath = path.join(root, "config", "deploy-gate.json");
	fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
	const cfg = {
		schema: "deploy-gate/v1",
		services: {
			"azure:containerapp:sample-web-prod": {
				label: "샘플 웹 운영 앱",
				requireDeployGate: false,
				allowOps: true,
				allowRollback: true,
				commandMustContain: ["sample-web-prod"],
			},
		},
		...extra,
	};
	fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
	return cfgPath;
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
	const step1Cmd = `bash ${scriptRel} prod`;
	const rollbackCmd = "az containerapp revision activate -n sample-web-prod -g sample-rg --revision sample-web-prod--prev";

	const plan = {
		schema: "deploy-plan/v1",
		author_model: "muse",
		approval_mode: "preapprove_steps",
		planId: "sample-web-rollout-01",
		createdAt: new Date().toISOString(),
		services: ["azure:containerapp:sample-web-prod"],
		what_why: "샘플 웹 서비스를 v1 이미지로 갱신하여 기능 개선을 반영합니다.",
		architecture_fit: {
			original_request: "샘플 웹 서비스 기능 개선을 공통 배포 게이트 절차에 맞춰 운영 반영 요청",
			parent_structure: "naia-adk 승인 계획 게이트 및 azure 컨테이너 앱 공통 배포 계층",
			acceptance_rationale: "기존 공통 승인 게이트와 리비전 배포 절차를 그대로 확장해 단일 호스트 수동 패치를 만들지 않음",
		},
		changes: ["컨테이너 이미지 sample/web:v1 반영"],
		changes: ["컨테이너 이미지 sample/web:v1 반영"],
		scenario: [
			{
				id: "s1",
				title: "v1 이미지 배포",
				commands: [step1Cmd],
				files: { [scriptRel]: scriptSha },
				success_check: "헬스체크 200 응답 확인",
				on_failure: "r1 단계로 이전 리비전을 즉시 활성화하고 보고",
			},
			{
				id: "r1",
				branch: "rollback",
				title: "이전 리비전으로 복귀",
				commands: [rollbackCmd],
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
	return { planFile, gatesDir, plan, scriptRel, scriptAbs, step1Cmd, rollbackCmd };
}

function writePassingReviewReceipt(root, planFile, options = {}) {
	const gatesDir = path.dirname(planFile);
	const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
	const planSha = sha256(fs.readFileSync(planFile));
	let roItems;
	if (Array.isArray(options.readOnlyScripts)) roItems = options.readOnlyScripts;
	else if (options.bindReadOnlyScripts) {
		const b = deployPlan.planReadOnlyScriptsBinding(plan, root);
		assert.equal(b.ok, true, b.why);
		roItems = b.items;
	}
	const roOpt = Array.isArray(roItems) ? { readOnlyScripts: roItems } : null;
	const prompt = deployPlan.reviewPrompt(plan, planSha, root, roOpt);
	const promptSha = sha256(prompt);
	const manifestSha = deployPlan.reviewInputManifest(planFile, root, roOpt);

	const fail = options.fail || [];
	const bodyLines = [
		fail.length ? "판정: FAIL" : "판정: PASS",
		...deployPlan.CRITERIA.map(([id]) => (fail.includes(id) ? `${id}: FAIL — 차단 지적 있음` : `${id}: PASS — 계획서 및 고정 스크립트 확인 통과`)),
		...(options.extra || []),
		`참고 지적: 0${options.bodyMarker || ""}`,
		`남은 지적: ${options.open ?? 0}`,
		"",
	];
	const body = bodyLines.join("\n");
	const stdoutSha = sha256(body);
	const finalText = `${body}review-run: target_sha256=${planSha} prompt_sha256=${promptSha} stdout_sha256=${stdoutSha}\n`;
	const reviewer = options.reviewer || "argon";
	const resultRel = `deploy-plan-review-${reviewer}.md`;
	fs.writeFileSync(path.join(gatesDir, resultRel), finalText);

	// 옛 모양(rotation 칸 없음) 기록은 차례 도입 시각 앞선 것만 받으므로 그 앞 시각으로 쓴다.
	const legacyEnd = Date.parse(deployPlan.LEGACY_REVIEW_CUTOFF) - 60_000;
	const startedAt = options.startedAt || new Date(legacyEnd - 2000).toISOString();
	const endedAt = new Date(legacyEnd).toISOString();
	const reviewerCfg = deployPlan.reviewModelsFor(root)[reviewer];
	const reviewRecord = {
		plan_sha256: planSha,
		plan: path.relative(root, planFile),
		author_model: plan.author_model,
		prompt_sha256: promptSha,
		...(Array.isArray(roItems) ? { read_only_scripts: roItems } : {}),
		reviewedAt: endedAt,
		reviewers: [
			{
				model: reviewerCfg.model,
				effort: reviewerCfg.effort,
				result: resultRel,
				result_sha256: sha256(finalText),
				target_sha256: planSha,
				receipt: {
					model: reviewerCfg.model,
					effort: reviewerCfg.effort,
					started_at: startedAt,
					ended_at: endedAt,
					exit_code: 0,
					prompt_sha256: promptSha,
					stdout_sha256: stdoutSha,
					input_manifest_sha256: manifestSha,
					isolation: "bwrap-ro-bind",
				},
			},
		],
	};
	fs.writeFileSync(path.join(gatesDir, deployPlan.REVIEW_FILE), JSON.stringify(reviewRecord, null, 2));
	return { planSha, promptSha, manifestSha };
}

function appendHumanTurn(transcriptPath, text) {
	const entry = {
		type: "user",
		timestamp: new Date(Date.now() + 1000).toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text }],
		},
	};
	fs.appendFileSync(transcriptPath, JSON.stringify(entry) + "\n");
}

function runDeployGuardHook(command, { cwd, root, stateDir, transcriptPath, sessionId = "sess-test-1" }) {
	const payload = JSON.stringify({
		tool_name: "Bash",
		tool_input: { command },
		cwd,
		session_id: sessionId,
		transcript_path: transcriptPath,
	});
	const res = spawnSync(process.execPath, [HOOK_PATH], {
		cwd,
		input: payload,
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: cwd,
			DEPLOY_READINESS_ROOT: root,
			DEPLOY_APPROVAL_STATE_DIR: stateDir,
			DEPLOY_AUDIT_PATH: path.join(stateDir, "audit.jsonl"),
		},
	});
	assert.equal(res.status, 0, `deploy-guard exited ${res.status}: ${res.stderr}`);
	return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

// 계획 고정 대본(적대 리뷰 B1): 대본 본문은 분류기가 다 읽을 수 없으므로 ops 로 받지 않는다.
// 준비 기록 없는 계획 승인(kind plan)으로만 돌고, 대본·files 지문은 계획 결합이 대조한다.
const { verifiedPlanBinding } = require("../lib/deploy-readiness.js");

const PIN_SERVICE = "azure:vm:sample-vm";

const PIN_OPS_WHY = /계획 고정 대본은 ops 로 받지 않음/;

function gitRun(root, args) {
	const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

function populatePlanRepo(repoRoot, options = {}) {
	if (options.gitMode === "worktree") {
		const realGitDir = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-gitdir`);
		fs.mkdirSync(realGitDir, { recursive: true });
		fs.mkdirSync(repoRoot, { recursive: true });
		fs.writeFileSync(path.join(repoRoot, ".git"), `gitdir: ${realGitDir}\n`);
	} else if (options.gitMode !== "none") {
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
	} else {
		fs.mkdirSync(repoRoot, { recursive: true });
	}
	for (const rel of deployPlan.REVIEW_EXECUTOR_FILES) {
		const dst = path.join(repoRoot, rel);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(path.join(REPO_ROOT, rel), dst);
	}
	if (options.foreignMarker) {
		fs.appendFileSync(path.join(repoRoot, ".agents/scripts/approval-plan.mjs"), `\n// ${options.foreignMarker}\n`);
	}
}

module.exports = {
	test,
	assert,
	crypto,
	fs,
	os,
	path,
	spawnSync,
	REPO_ROOT,
	HOOK_PATH,
	SCRIPT_PATH,
	deployPlan,
	assessReadiness,
	classifyProdMutations,
	sha256,
	ISSUED_APPROVAL_CODE,
	makeWorkspace,
	approvedRunner,
	writeGateConfig,
	createValidPlan,
	writePassingReviewReceipt,
	appendHumanTurn,
	runDeployGuardHook,
	verifiedPlanBinding,
	PIN_SERVICE,
	PIN_OPS_WHY,
	gitRun,
	populatePlanRepo,
};
