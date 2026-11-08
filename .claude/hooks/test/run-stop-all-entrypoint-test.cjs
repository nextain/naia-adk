require("../../../scripts/test-signal-safety.cjs");
"use strict";
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

function makeWorkspace(t) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-plan-gate-test-"));
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

function writePassingReviewReceipt(root, planFile) {
	const gatesDir = path.dirname(planFile);
	const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
	const planSha = sha256(fs.readFileSync(planFile));
	const prompt = deployPlan.reviewPrompt(plan, planSha, root);
	const promptSha = sha256(prompt);
	const manifestSha = deployPlan.reviewInputManifest(planFile, root);

	const bodyLines = [
		"판정: PASS",
		...deployPlan.CRITERIA.map(([id]) => `${id}: PASS — 계획서 및 고정 스크립트 확인 통과`),
		"참고 지적: 0",
		"남은 지적: 0",
		"",
	];
	const body = bodyLines.join("\n");
	const stdoutSha = sha256(body);
	const finalText = `${body}review-run: target_sha256=${planSha} prompt_sha256=${promptSha} stdout_sha256=${stdoutSha}\n`;
	const resultRel = "deploy-plan-review-argon.md";
	fs.writeFileSync(path.join(gatesDir, resultRel), finalText);

	const startedAt = new Date(Date.now() - 2000).toISOString();
	const endedAt = new Date().toISOString();
	const reviewRecord = {
		plan_sha256: planSha,
		plan: path.relative(root, planFile),
		author_model: "muse",
		prompt_sha256: promptSha,
		reviewedAt: endedAt,
		reviewers: [
			{
				model: deployPlan.REVIEW_MODELS.argon.model,
				effort: deployPlan.REVIEW_MODELS.argon.effort,
				result: resultRel,
				result_sha256: sha256(finalText),
				target_sha256: planSha,
				receipt: {
					model: deployPlan.REVIEW_MODELS.argon.model,
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


const lock=require('../lib/stop-all-lock.js');
for(const mode of ['plan','deploy'])for(const locked of [false,true])for(const id of ['s0','r1','r2'])test(`actual hook ${mode} locked=${locked} ${id}`,t=>{
 const f=makeWorkspace(t), {root,stateDir,transcriptPath}=f;
 const script=path.join(root,'rollout.sh');fs.writeFileSync(script,'#!/bin/bash\n# mocked operational script; never executed\n');
 const services=['systemd:sample-runtime'];
 writeGateConfig(root,{plannedScripts:{enabled:true,roots:[root],services,systemdUserUnits:[]},services:{[services[0]]:{allowCustomCommands:true}}});
 const {planFile}=createValidPlan(root);const plan=JSON.parse(fs.readFileSync(planFile));plan.services=services;
 plan.scenario=['s0','r1','r2'].map(x=>({id:x,...(x[0]==='r'?{branch:'rollback'}:{}),title:'fixture step',commands:[`bash ${script} ${x}`],files:{[script]:sha256(fs.readFileSync(script))},success_check:'fixture state verified',on_failure:'return to original state'}));
 plan.rollback.step_ids=['r1','r2'];fs.writeFileSync(planFile,JSON.stringify(plan));writePassingReviewReceipt(root,planFile);
 if(mode==='deploy')fs.writeFileSync(path.join(path.dirname(planFile),'deploy.json'),JSON.stringify({createdAt:new Date().toISOString(),services,kind:'ops',reason:'fixture operations only'}));
 const preload=path.join(root,'mock-lock.cjs');fs.writeFileSync(preload,`require(${JSON.stringify(path.join(REPO_ROOT,'.claude/hooks/lib/stop-all-lock.js'))}).stopAllLocked=()=>${locked};`);
 const prior=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${prior||''} --require=${preload}`;t.after(()=>{if(prior===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=prior});
 const decision=runDeployGuardHook(plan.scenario.find(x=>x.id===id).commands[0],{cwd:root,root,stateDir,transcriptPath});
 console.log(JSON.stringify({mode,locked,id,reason:decision?.reason?.split('\n')[0]}));
 assert.equal(decision?.decision,'block');assert.match(decision.reason,locked?/모두 멈춤 잠금/:/전체 계획 승인이 아직 없습니다/);
});

test('approval reviewer refuses symlink executors before command dispatch',t=>{
 const {root}=makeWorkspace(t),leaf=path.join(root,'.claude/hooks/lib/stop-all-lock.js'),saved=leaf+'.original';fs.renameSync(leaf,saved);fs.symlinkSync(saved,leaf);
 const source=fs.readFileSync(SCRIPT_PATH,'utf8');
 const begin=source.indexOf('const pinnedExecutors =');const end=source.indexOf('for (const { requested, filename }',begin);
 assert.throws(()=>require('node:vm').runInNewContext(source.slice(begin,end),{PINNED_CJS_EXECUTORS:['.claude/hooks/lib/stop-all-lock.js'],ROOT:root,path,fs,die:message=>{throw Error(message)}}),/심볼릭 링크/);

});
