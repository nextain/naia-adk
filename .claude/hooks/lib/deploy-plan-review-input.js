"use strict";
// Plan gate responsibility: review-input.
const {planCommandEntries}=require("./deploy-plan-commands.js");
const { commandHash } = require("./deploy-human-approval.js");
const path = require("path");
const fs = require("fs");
const { reviewProfileBinding, registeredReviewProfiles, gateConfigView: gateConfigContext, withReviewProfile } = require("./deploy-plan-context.js");
const { canonicalReadOnlyBinding } = require("./deploy-plan-readonly-policy.js");
const { requiresArchitectureFit, CRITERIA, BLOCKING_KINDS, ADVISORY_EXAMPLES } = require("./deploy-plan-schema.js");
const { pinnedFilesText, targetPins } = require("./deploy-plan-targets.js");
const { resolveRepoRoot, readPlanSnapshot, sha256, ROOT } = require("./deploy-plan-common.js");
const { reviewModelsFor, canonicalReviewModels } = require("./deploy-plan-review-policy.js");
const { planReadOnlyScriptsBinding } = require("./deploy-plan-readonly-binding.js");

function reviewPrompt(plan, sha, root, opts = null) {
	const profile = reviewProfileBinding(opts?.planFile, root);
	const roItems = opts && Array.isArray(opts.readOnlyScripts) ? canonicalReadOnlyBinding(opts.readOnlyScripts) : [];
	const roLines = roItems.length
		? [
			"",
			"읽기 전용 무코드 바인딩(readOnlyScripts, 리뷰 당시 확정 목록 — 이 외의 항목·변경·추가는 사람 승인 코드 필요):",
			...roItems.map((x) => `- service=${x.service} path=${x.path} sha256=${x.sha256} script_sha256=${x.script_sha256}`),
		]
		: [];
	const requireArchFit = requiresArchitectureFit(plan);
	const activeCriteria = requireArchFit ? CRITERIA : CRITERIA.filter(([id]) => id !== "architecture_fit");
	const activeBlockingKinds = requireArchFit ? BLOCKING_KINDS : BLOCKING_KINDS.filter((k) => !k.startsWith("구조이탈:"));
	return [
		"당신은 운영 배포 계획서(승인 보고 양식)의 적대적 검수자입니다. 이 계획을 승인하면 승인자가 결과에 책임을 집니다.",
		"계획서를 깨뜨릴 방법을 찾으십시오. 아래 기준마다 PASS 또는 FAIL 을 판정하고, FAIL 이면 구체적 지적(어느 칸, 무엇이 왜 틀림, 고칠 방향)을 적으십시오.",
		"추측으로 PASS 하지 마십시오. 계획서에 적힌 것만 근거로 삼고, 적히지 않은 안전장치는 없는 것으로 봅니다. 다만 없는 장치를 새로 더하라는 요구는 차단 지적이 아니라 참고 지적입니다.",
		"",
		"지적 분류(판정은 이 분류를 따릅니다):",
		`- 차단 지적으로 셀 수 있는 것은 다음 ${requireArchFit ? "여섯" : "다섯"} 가지뿐입니다:`,
		...activeBlockingKinds.map((k) => `  - ${k}`),
		`- 차단 지적이 아닌 것(참고로만 남김): 계획에 없는 새 장치를 더하라는 요구. 예: ${ADVISORY_EXAMPLES}.`,
		"- 되돌리기는 \"사람이 실행하는 이전 판 복귀 한 단계와 걸리는 시간\"이 적혀 있고 그 명령이 실제로 보존된 이전 판으로 돌아가면 rollback 기준을 충족합니다.",
		"- incident.actions 가 비어 있는 것([])은 incident_safety 위반이 아닙니다.",
		"- 새 장치가 없어서 생기는 위험이 계획서(risks·impact·residual_risks 등)에 적히지 않았거나 축소돼 있으면 그것은 \"위험숨김\" 차단 지적입니다. 적혀 있으면 장치 추가 요구는 참고입니다.",
		"- 기준 판정은 차단 지적만으로 정합니다. 참고 지적만 있는 기준은 PASS 입니다.",
		"",
		"기준:",
		...activeCriteria.map(([id, text]) => `- ${id}: ${text}`),
		"",
		"출력 형식(정확히):",
		"첫 줄: 판정: PASS 또는 판정: FAIL (기준 하나라도 FAIL 이면 FAIL)",
		...activeCriteria.map(([id]) => `${id}: PASS|FAIL — 한 줄 근거`),
		`지적 목록: 한 줄에 하나, "<번호>. [차단:<분류>] <기준 id> — 내용" 또는 "<번호>. [참고] <기준 id> — 내용". 분류는 ${requireArchFit ? "불일치·되돌리기·비밀·위험숨김·선조치악화·구조이탈" : "불일치·되돌리기·비밀·위험숨김·선조치악화"} 중 하나`,
		"참고 지적: <참고 지적 수>",
		"마지막 줄: 남은 지적: <차단 지적 수>",
		"",
		`계획서 sha256: ${sha}`,
		"계획서 원문:",
		"```json",
		JSON.stringify(plan, null, 2),
		"```",
		"",
		"명령별 정규화 sha256(훅이 이 값으로 계획 안/밖을 가립니다):",
		...(plan.scenario || []).flatMap((s) => (s.commands || []).map((c) => `- ${s.id}: ${commandHash(c)}`)),
		...((plan.incident && plan.incident.actions) || []).flatMap((a) => (a.commands || []).map((c) => `- 장애 ${a.id}: ${commandHash(c)}`)),
		"",
		...(profile ? [`Review gate: ${profile.id}. Registered policy and plan scope: ${profile.scope_sha256}`] : []),
		...(profile?.policy === "strict-defaults" ? ["Review policy: strict-defaults. Use the built-in reviewers. This gate grants no read-only command exceptions."] : []),
		...pinnedFilesText(plan, root),
		...roLines,
	].join("\n");
}

/** 리뷰 입력 고정 목록(계획서·핀·실행기)의 내용 해시. 전후 대조와 영수증 결박에 쓴다. */
const REVIEW_EXECUTOR_FILES = [
	".agents/scripts/approval-plan.mjs",
	".claude/hooks/lib/deploy-human-approval.js",
	".claude/hooks/lib/gate-config-pin.js",
	"scripts/lib/pid-lock.cjs",
	"scripts/lib/registered-git-identity.cjs",
	".claude/hooks/lib/deploy-plan-common.js",
	".claude/hooks/lib/deploy-plan-discord.js",
	".claude/hooks/lib/deploy-plan-readonly-policy.js",
	".claude/hooks/lib/deploy-plan-context.js",
	".claude/hooks/lib/deploy-plan-review-policy.js",
	".claude/hooks/lib/deploy-plan-schema.js",
	".claude/hooks/lib/deploy-plan-commands.js",
	".claude/hooks/lib/deploy-plan-targets.js",
	".claude/hooks/lib/deploy-plan-readonly-binding.js",
	".claude/hooks/lib/deploy-plan-review-input.js",
	".claude/hooks/lib/deploy-plan-review-results.js",
	".claude/hooks/lib/deploy-plan-approval-state.js",
	".claude/hooks/lib/deploy-plan-human-confirmation.js",
	".claude/hooks/lib/deploy-plan-evidence.js",
	".claude/hooks/lib/deploy-plan-flow.js",
	".claude/hooks/lib/deploy-plan-admission.js",
	".claude/hooks/lib/deploy-plan-review-lock.js",
	".claude/hooks/lib/deploy-plan.js",
	".claude/hooks/lib/deploy-readiness-io.js",
	".claude/hooks/lib/deploy-readiness-ops.js",
	".claude/hooks/lib/deploy-readiness-policy.js",
	".claude/hooks/lib/deploy-readiness-evidence.js",
	".claude/hooks/lib/deploy-readiness-script-binding.js",
	".claude/hooks/lib/deploy-readiness-plan-binding.js",
	".claude/hooks/lib/deploy-readiness-assessment.js",
	".claude/hooks/lib/deploy-readiness-planning.js",
	".claude/hooks/lib/deploy-readiness.js",
	".claude/hooks/lib/git-command-parser.js",
	".claude/hooks/lib/effective-argv.js",
	".claude/hooks/lib/deploy-command-classifier.js",
	".agents/hooks/core/delegation-contract.js",
	".agents/hooks/core/hook-project-root.js",
	".agents/hooks/core/subagent-failure-receipt.js",
	".agents/hooks/core/session-contract.js",
	".agents/harness/session-baseline.cjs",
	".agents/hooks/core/harness-core.js",
	".agents/hooks/policies/edit.js",
	".agents/hooks/policies/bash.js",
	".agents/hooks/policies/bash-git.cjs",
	".agents/hooks/policies/bash-external.cjs",
	".agents/hooks/policies/bash-deploy.cjs",
	".agents/hooks/policies/deploy-policy-roots.cjs",
	".agents/hooks/policies/bash-artifact-context.cjs",
	".agents/hooks/policies/bash-artifact-wrappers.cjs",
	".agents/hooks/policies/bash-artifact-scripts.cjs",
	".agents/hooks/policies/bash-artifact.cjs",
	".agents/scripts/approval-plan-files.cjs",
	".agents/scripts/approval-plan-snapshot.cjs",
	".agents/scripts/approval-plan-reviewer.cjs",
	".agents/scripts/approval-plan-cli.cjs",
	".agents/scripts/registered-gate-runtime.cjs",
	".agents/scripts/registered-gate-loader.cjs",
	".agents/scripts/registered-gate-environment.cjs",
	".claude/hooks/lib/hook-watchdog.js",
	".claude/hooks/_claude-bash-guard.js"
];

/**
 * 계획서 소속 저장소 root 기준으로 항목을 읽는다. root 미지정 시 planFile에서 역산.
 * 핀 실물이 계획서 want와 다르면 problems에 적는다(호출자는 digest 대신 무효 처리).
 */
function reviewInputEntries(planFile, root, opts = null) {
	const base = root ? path.resolve(root) : resolveRepoRoot(path.dirname(path.resolve(planFile)));
	const snapshot = readPlanSnapshot(planFile);
	if (!snapshot) throw new Error("계획서를 읽지 못함");
	const { plan, sha: planSha256 } = snapshot;
	const entries = [{ file: "\0plan", sha256: planSha256 }];
	const problems = [];
	const seen = new Set(["\0plan"]);
	const profile = reviewProfileBinding(planFile, base);
	if (profile) entries.push({ file: "\0gate_review", sha256: profile.scope_sha256 });
	let resolvedModels = null;
	try { resolvedModels = reviewModelsFor(base); }
	catch (error) { problems.push(`review_models 설정을 읽지 못함: ${error.message}`); }
	if (resolvedModels) {
		seen.add("\0review_models");
		entries.push({ file: "\0review_models", sha256: sha256(JSON.stringify(canonicalReviewModels(resolvedModels))) });
	}
	if (opts && Array.isArray(opts.readOnlyScripts)) {
		const canonicalRo = canonicalReadOnlyBinding(opts.readOnlyScripts);
		if (canonicalRo.length) {
			seen.add("\0read_only_scripts");
			entries.push({ file: "\0read_only_scripts", sha256: sha256(JSON.stringify(canonicalRo)) });
		}
	}
	const immutablePins = new Map();
	let targets = new Map();
	try { targets = targetPins(plan, base); } catch (e) { problems.push(String(e.message)); }
	for (const {entry} of planCommandEntries(plan)) {
		if (!entry || !entry.files || typeof entry.files !== "object" || Array.isArray(entry.files)) continue;
		for (const [file, want] of Object.entries(entry.files)) {
			const target = targets.get(path.resolve(base, file));
			const expected = String(want).toLowerCase();
			if (target) {
				if (expected !== target.before && expected !== target.after) problems.push(`${entry.id}: target pin mismatch: ${file}`);
				continue;
			}
			const key = path.normalize(file);
			const previous = immutablePins.get(key);
			if (previous && previous.expected !== expected) problems.push(`${entry.id}: conflicting immutable pin: ${file}`);
			immutablePins.set(key, { id: entry.id, file, expected });
		}
	}
	for (const { id, file, expected } of immutablePins.values()) {
		if (seen.has(file)) continue;
		seen.add(file);
		let actual;
		try { actual = sha256(fs.readFileSync(path.resolve(base, file))); } catch { problems.push(`${id}: 고정 파일을 읽지 못함: ${file}`); continue; }
		if (actual !== expected) { problems.push(`${id}: 고정 파일 sha256 불일치: ${file}`); continue; }
		entries.push({ file, sha256: actual });
	}
	for (const target of targets.values()) entries.push({ file: target.path, before: target.before, after: target.after });
	for (const rel of REVIEW_EXECUTOR_FILES) {
		try { entries.push({ file: rel, sha256: sha256(fs.readFileSync(path.join(ROOT, rel))) }); }
		catch { problems.push(`실행기를 읽지 못함: ${rel}`); }
	}
	entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
	return { base, planSha256, entries, problems, digest: problems.length ? null : sha256(JSON.stringify(entries)) };
}

function reviewInputManifest(planFile, root, opts = null) {
	const profiles = registeredReviewProfiles(root || resolveRepoRoot(path.dirname(path.resolve(planFile))));
	if (profiles.length && !gateConfigContext.getStore().selected) {
		const base = root || resolveRepoRoot(path.dirname(path.resolve(planFile)));
		const plan = readPlanSnapshot(planFile)?.plan;
		const manifests = profiles.map(p => withReviewProfile(base, p.id, () => {
			const ro = planReadOnlyScriptsBinding(plan, base);
			if (!ro.ok) throw new Error(ro.why);
			return [p.id, reviewInputManifest(planFile, base, { readOnlyScripts: ro.items })];
		}));
		return sha256(JSON.stringify(["gate-reviews/v1", manifests]));
	}
	const r = reviewInputEntries(planFile, root, opts);
	if (r.problems.length) throw new Error(r.problems[0]);
	return r.digest;
}

module.exports = {
	reviewPrompt,
	REVIEW_EXECUTOR_FILES,
	reviewInputEntries,
	reviewInputManifest,
};
