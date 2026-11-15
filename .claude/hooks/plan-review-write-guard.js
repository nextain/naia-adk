#!/usr/bin/env node
"use strict";
/**
 * 계획 리뷰 중 저장소 쓰기 막기 관문 (PreToolUse)
 *
 * `approval-plan.mjs review` 가 도는 동안 대상 인스턴스 저장소 뿌리의
 * `.agents/state/plan-review.lock` 이 살아 있으면(pid 생존 + 시한 내)
 * 그 저장소 안을 바꾸는 파일 변이 도구(Write/Edit/NotebookEdit/MultiEdit/apply_patch)와
 * 쓰기 셸 명령을 막는다.
 *
 * - 읽기 도구와 읽기 전용 셸 명령은 막지 않는다.
 * - 리뷰 실행기 자신(PID 계보)과 리뷰 기록 쓰기(gates/ 아래 리뷰 기록)는 통과한다.
 * - 죽은 PID 잠금·시한이 지난 잠금은 무시하고 한 줄 알림(additionalContext)을 낸다.
 * - 관문 내부 오류·손상된 잠금·시한 초과(hook-watchdog) 시 모두 막음(fail-closed)으로 동작한다.
 *
 * 안내 문서: docs/guides/plan-review-write-guard.md
 */
const fs = require("fs");

function writeAll(buf) {
	for (let o = 0; o < buf.length;) {
		try {
			o += fs.writeSync(1, buf, o);
		} catch (e) {
			if (e.code !== "EAGAIN") throw e;
		}
	}
}

function writeJson(obj) {
	writeAll(Buffer.from(JSON.stringify(obj)));
}

function block(reason) {
	writeJson({ decision: "block", reason });
	process.exit(0);
}

let runWithWatchdog;
try {
	({ runWithWatchdog } = require("./lib/hook-watchdog.js"));
} catch (error) {
	block(`[Harness] 계획 리뷰 쓰기 관문 시한 감시 모듈을 불러오지 못해 막습니다 (fail-closed): ${error && (error.code || error.message)}`);
}

if (runWithWatchdog({
	script: __filename,
	defaultMs: 15000,
	msEnvVar: "NAIA_PLAN_REVIEW_GUARD_WATCHDOG_MS",
	label: "계획 리뷰 쓰기 관문",
})) {
	// 부모 감시 프로세스는 자식 종료 시 직접 exit 한다.
} else {
	main();
}

function main() {
	let isFileMutationTool, isShellTool, inspectPlanReviewLock, isPidInLineage, isPlanReviewRecordPath, extractWriteTargets, repoRootOf;
	try {
		({ isFileMutationTool, isShellTool } = require("./tool-names.js"));
		({ inspectPlanReviewLock, isPidInLineage, isPlanReviewRecordPath } = require("./lib/deploy-plan.js"));
		({ extractWriteTargets, repoRootOf } = require("./lib/plan-review-write-targets.js"));
	} catch (error) {
		block(`[Harness] 계획 리뷰 쓰기 관문 핵심 모듈을 불러오지 못해 막습니다 (fail-closed): ${error && (error.code || error.message)}`);
	}

	let raw = "";
	try {
		raw = fs.readFileSync(0, "utf8");
	} catch (error) {
		block(`[Harness] 계획 리뷰 쓰기 관문 표준 입력을 읽지 못해 막습니다 (fail-closed): ${error && (error.code || error.message)}`);
	}

	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		block("[Harness] 계획 리뷰 쓰기 관문 입력이 올바른 JSON 이 아니라 막습니다 (fail-closed).");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		block("[Harness] 계획 리뷰 쓰기 관문 입력 형식이 올바르지 않아 막습니다 (fail-closed).");
	}

	try {
		const tool = String(data.tool_name || "");
		const tail = tool.split(/[.:/]/).pop() || "";
		const isEdit = isFileMutationTool(tool) || /^multiedit$/i.test(tail);
		const isShell = isShellTool(tool);
		if (!isEdit && !isShell) {
			process.exit(0);
		}

		const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd();
		const sessionRepos = new Set();
		for (const cand of [cwd, process.env.CLAUDE_PROJECT_DIR, process.env.NAIA_ADK_ROOT]) {
			if (typeof cand === "string" && cand.trim()) {
				const root = repoRootOf(cand.trim());
				if (root) sessionRepos.add(root);
			}
		}

		const { targets, unresolvedMutation } = extractWriteTargets({
			isShell,
			toolInput: data.tool_input,
			cwd,
		});

		const writeByRepo = new Map();
		const addRepoTarget = (repo, entry) => {
			if (!repo) return;
			if (!writeByRepo.has(repo)) writeByRepo.set(repo, []);
			writeByRepo.get(repo).push(entry);
		};

		for (const target of targets) {
			const repo = repoRootOf(target.path);
			if (repo) addRepoTarget(repo, { path: target.path, wholeRepo: Boolean(target.wholeRepo) });
		}
		if (unresolvedMutation) {
			for (const repo of sessionRepos) {
				addRepoTarget(repo, { path: repo, wholeRepo: true });
			}
		}

		const now = Date.now();
		const notices = [];
		const checkedRepos = new Set();

		for (const [repo, entries] of writeByRepo.entries()) {
			checkedRepos.add(repo);
			const status = inspectPlanReviewLock(repo, now);
			if (status.state === "none") continue;
			if (status.state === "corrupt") {
				block(`[Harness] 계획 리뷰 잠금 파일을 검증하지 못해 쓰기를 막습니다 (fail-closed): ${status.reason}`);
			}
			if (status.state === "dead" || status.state === "expired") {
				if (status.notice) notices.push(status.notice);
				continue;
			}
			if (status.state === "active") {
				if (isPidInLineage(process.pid, status.lock.pid, status.lock.pidStartTicks)) {
					continue;
				}
				if (entries.length > 0 && entries.every((e) => !e.wholeRepo && isPlanReviewRecordPath(e.path, repo))) {
					continue;
				}
				block(status.blockReason);
			}
		}

		// 읽기 명령이나 저장소 밖 작업이어도 현재 세션 저장소에 죽은/만료된 잠금이 남아 있으면 한 줄 알림을 준다.
		for (const repo of sessionRepos) {
			if (checkedRepos.has(repo)) continue;
			const status = inspectPlanReviewLock(repo, now);
			if ((status.state === "dead" || status.state === "expired") && status.notice) {
				notices.push(status.notice);
			}
		}

		if (notices.length > 0) {
			const singleLine = [...new Set(notices)].join(" | ").replace(/[\r\n]+/g, " ").trim();
			writeJson({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					additionalContext: singleLine,
				},
			});
		}
		process.exit(0);
	} catch (error) {
		block(`[Harness] 계획 리뷰 쓰기 관문 실행 중 예외가 발생해 막습니다 (fail-closed): ${error && (error.code || error.message || String(error))}`);
	}
}
