"use strict";
/**
 * 운영 변경 준비 기록 및 인스턴스 결합 규칙 확인 (deploy-guard 가 1회용 코드를 내기 전에 부른다).
 *
 * 공통 뼈대 규칙:
 * - 인스턴스 설정 파일(config/deploy-gate.json + 선택 plugin 모듈)에서 허용 운영 서비스 목록과
 *   서비스별 결합 규칙을 읽는다. 설정이 없거나 등록되지 않은 운영 서비스는 기본으로 막는다("알 수 없는 운영 명령은 막음").
 * - 단계 명령 바이트 대조: 실행 명령이 승인된 계획서 단계의 commands 원문과 바이트 단위로 정확히 일치해야 한다.
 * - 고정 파일 sha256 대조: 단계의 files 에 적힌 모든 파일의 실제 디스크 해시가 일치해야 한다.
 * - 배포 준비 기록(.agents/progress/<작업>/gates/deploy.json)이 있거나 config/deploy-gate.json 의
 *   requireReadiness 가 true 이면 kind(feature | ops | rollback), 후보 커밋/태그, ET/코드/시험 검수 영수증을 함께 검증한다.
 */
const { VERSION_CHANGE, CONFIG_ONLY, INNER_OPAQUE, innerProblem, opsAzProblem, opsProblem } = require("./deploy-readiness-ops.js");
const { tryCanonicalTargetPath, canonicalTargetPath, hasDeployPlanMarker, findPolicyRootForPath, inspectDeployPolicyErrors, deployGateConfigPath, loadDeployGateConfig, loadDeployGatePlugin, matchServiceRule } = require("./deploy-readiness-policy.js");
const { findReadiness, openCriticalDefects, executedBefore, commandBinding } = require("./deploy-readiness-evidence.js");
const { verifiedPlanBinding } = require("./deploy-readiness-plan-binding.js");
const { assessReadiness } = require("./deploy-readiness-assessment.js");

const TEMPLATE = {
	services: ["azure:containerapp:my-app-prod"],
	kind: "feature | ops | rollback",
	candidate: "<올릴 커밋 해시 또는 이미지 태그. 명령 글자에 들어가야 함(배포 스크립트면 그 저장소 HEAD)>",
	currentProd: "<운영 서비스 조회로 확인한 지금 운영 태그>",
	repo: "projects/my-app",
	et: [".agents/progress/<작업>/et/<receipt>.json  (모양: {\"kind\":\"et\",\"candidate\":…,\"scenarios\":[{\"id\":…,\"verdict\":\"pass\"}]})"],
	testGate: ".agents/progress/<작업>/gates/test.json (stage test, ET 를 돌리지 않은 검수자)",
	codeGate: ".agents/progress/<작업>/gates/code.json",
	uiGate: "(권장) .agents/progress/<작업>/gates/ui.json — 없으면 안내에 '화면 검수 없음'이 찍힘",
	reason: "(ops 일 때) 무엇을 왜 하는지 한 줄. ops 는 설정만 바꾸는 명령(환경 변수·복제 수·재시작·리비전 끄기)에만",
	rollbackEvidence: "(rollback 이고 감사 기록에 없을 때) 이전 리비전 목록 출력 파일",
	createdAt: "<ISO 시각>",
};

const { inspectPlanPreparation } = require("./deploy-readiness-planning.js");

module.exports = {
	inspectPlanPreparation,
	assessReadiness,
	verifiedPlanBinding,
	findReadiness,
	openCriticalDefects,
	executedBefore,
	commandBinding,
	loadDeployGateConfig,
	loadDeployGatePlugin,
	matchServiceRule,
	deployGateConfigPath,
	tryCanonicalTargetPath,
	canonicalTargetPath,
	hasDeployPlanMarker,
	findPolicyRootForPath,
	inspectDeployPolicyErrors,
	VERSION_CHANGE,
	CONFIG_ONLY,
	INNER_OPAQUE,
	innerProblem,
	opsAzProblem,
	opsProblem,
	TEMPLATE,
};
