"use strict";
// Approval gate tests: readonly-fixtures.
const { makeWorkspace, fs, path, gitRun, sha256, writePassingReviewReceipt } = require("./approval-plan-fixtures.cjs");

function setupReadOnlyOpsWorkspace(t, {
	scriptRel = ".agents/progress/sample-ro-work/gates/ops/ro-check.sh",
	scriptBody = "#!/usr/bin/env bash\nset -euo pipefail\ndocker inspect sample-app >/dev/null\ndf -h / | tail -1\n",
	service = "azure:vm:sample-vm",
	commandKind = "az",
	customCommand = null,
	configServices = null,
	readOnlyScripts = null,
	commitConfig = true,
	commitScript = true,
	bindReadOnlyScripts = true,
	kind = "ops",
	candidate = undefined,
	withReview = true,
	reviewFail = [],
	planExtras = {},
	pinFiles = true,
} = {}) {
	const { tmp, root, stateDir, transcriptPath } = makeWorkspace(t);
	fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
	gitRun(root, ["init"]);
	gitRun(root, ["config", "user.email", "test@example.com"]);
	gitRun(root, ["config", "user.name", "Tester"]);

	const scriptAbs = path.join(root, scriptRel);
	fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
	fs.writeFileSync(scriptAbs, scriptBody);
	const scriptSha = sha256(fs.readFileSync(scriptAbs));

	const cfgPath = path.join(root, "config", "deploy-gate.json");
	fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
	const cfg = {
		schema: "deploy-gate/v1",
		services: configServices || {
			[service]: { label: "샘플 VM", allowOps: true },
		},
		readOnlyScripts: readOnlyScripts !== null
			? readOnlyScripts
			: [{ sha256: scriptSha, path: scriptRel, service, note: "샘플 읽기 점검" }],
	};
	fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
	if (commitScript) gitRun(root, ["add", scriptRel]);
	if (commitConfig) gitRun(root, ["add", "config/deploy-gate.json"]);
	if (commitScript || commitConfig) gitRun(root, ["commit", "-m", "commit initial readOnly setup"]);

	const workDir = path.join(root, ".agents", "progress", "sample-ro-work");
	const gatesDir = path.join(workDir, "gates");
	fs.mkdirSync(gatesDir, { recursive: true });

	const command = customCommand || (commandKind === "az"
		? `az vm run-command invoke --resource-group sample-rg --name sample-vm --command-id RunShellScript --scripts @${scriptRel} --query 'value[0].message' --output tsv`
		: `${commandKind === "sh" ? "sh" : "bash"} ${scriptRel}`);

	const plan = {
		schema: "deploy-plan/v1",
		author_model: "muse",
		planId: "sample-ro-work",
		createdAt: new Date().toISOString(),
		services: [service],
		what_why: "샘플 운영 VM 상태 읽기 점검",
		architecture_fit: {
			original_request: "운영 VM 상태를 읽기 전용 계약 범위 안에서 안전하게 점검 요청",
			parent_structure: "naia-adk readOnlyScripts 무코드 읽기 전용 검증 계층 및 승인 게이트",
			acceptance_rationale: "기존 승인 계획 게이트의 readOnlyScripts 표준 계층을 확장해 임의 일회성 명령을 막음",
		},
		changes: ["변경 없음(읽기 전용 상태 확인)"],
		scenario: [
			{
				id: "s1",
				title: "VM 상태 읽기 확인",
				commands: [command],
				...(pinFiles ? { files: { [scriptRel]: scriptSha } } : {}),
				success_check: "종료 코드 0 및 상태 출력 확인",
				on_failure: "멈추고 보고",
			},
		],
		risks: { items: ["단순 조회 부하"], worst_case: "조회 시간 초과" },
		irreversible: ["없음: 읽기 전용 확인"],
		disconnect_safety: "끊겨도 상태 변화 없음",
		rerun_safety: { lock: "읽기 전용 조회", run_dir: ".agents/progress/sample-ro-work", no_latest_pick: "대본 경로·sha 고정" },
		success_verification: "출력 상태 요약 확인",
		rollback: { method: "읽기 전용 점검이라 되돌릴 것이 없음", duration: "0분", step_ids: [] },
		residual_risks: ["조회 명령 응답 지연 가능"],
		incident: { criteria: ["원격 명령 실행 오류"], actions: [] },
		...planExtras,
	};
	const planFile = path.join(gatesDir, "deploy-plan.json");
	fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
	fs.writeFileSync(path.join(gatesDir, "deploy.json"), JSON.stringify({
		services: [service],
		kind,
		...(candidate ? { candidate } : {}),
		reason: "샘플 VM 상태 읽기 확인",
		createdAt: new Date().toISOString(),
	}, null, 2));

	if (withReview) {
		writePassingReviewReceipt(root, planFile, { fail: reviewFail, bindReadOnlyScripts });
	}
	const readAudit = () => {
		const auditFile = path.join(stateDir, "audit.jsonl");
		if (!fs.existsSync(auditFile)) return [];
		return fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	};
	return { tmp, root, stateDir, transcriptPath, cfgPath, scriptRel, scriptAbs, scriptSha, gatesDir, planFile, command, readAudit };
}

module.exports = {
	setupReadOnlyOpsWorkspace,
};
