"use strict";
// Approval CLI responsibility: cli.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const readiness = require("../../.claude/hooks/lib/deploy-readiness.js");
const { registeredReviewProfiles, gateConfigView } = require("../../.claude/hooks/lib/deploy-plan-context.js");
const lib = require("../../.claude/hooks/lib/deploy-plan.js");
const { commandHash } = require("../../.claude/hooks/lib/deploy-human-approval.js");
const { ROOT, loadPlan, die, sha256, opt, optAll } = require("./approval-plan-files.cjs");
const { runReviewers, runMuse } = require("./approval-plan-reviewer.cjs");
const { reviewErrorDetails } = require("./approval-plan-snapshot.cjs");

function createApprovalPlanCli({ STARTUP_EXECUTOR_SHAS, BOOT_ENTRY_SHA, registration = null }) {
function writeReviewFile(target, content, profile) {
	if (!profile) return fs.writeFileSync(target, content);
	const temp = path.join(path.dirname(target), `.review-${crypto.randomUUID()}.tmp`);
	fs.writeFileSync(temp, content, { flag: "wx" });
	try { fs.renameSync(temp, target); } finally { fs.rmSync(temp, { force: true }); }
}

function reviewStatus(gatesDir, sha, writeFindings = false, root = ROOT) {
	const r = writeFindings ? lib.selectedReviewProblems(gatesDir, sha, root) : lib.reviewProblems(gatesDir, sha, root);
	for (const row of r.reviewers) {
		const fail = row.summary.filter((s) => s.verdict !== "PASS").map((s) => s.id);
		console.log(`리뷰어 ${row.id}: ${row.body ? (row.ok ? "PASS" : "FAIL") : "결과 없음"}; 불통과 기준 ${fail.join(", ") || (row.summary.length === lib.CRITERIA.length ? "없음" : "결과 없음")}; 남은 지적(차단) ${row.openFindings ?? "확인 불가"}; 참고 지적 ${row.advisoryFindings ?? 0}(차단 아님)`);
	}
	if (writeFindings) {
		const dir = lib.reviewRecordDirectory(gatesDir);
		const merged = lib.resultFile(dir, "deploy-plan-review-findings.md", true);
		writeReviewFile(merged, lib.renderMergedFindings(r, sha), dir !== gatesDir);
		console.log(`통합 지적: ${path.relative(root, merged)}`);
	}
	return r;
}

async function runApprovalPlan(argv = process.argv.slice(2)) {
const [cmd, ...args] = argv;
switch (cmd) {
	case "template":
		console.log(JSON.stringify({ ...lib.TEMPLATE, createdAt: new Date().toISOString() }, null, 2));
		break;
	case "ready":
	case "prepare": {
        if (args.length !== 1) die("prepare requires exactly one plan path");
        const { abs, plan, gatesDir, sha, root: planRoot } = loadPlan(args[0]);
        const profiles = registeredReviewProfiles(planRoot);
        const before = new Map();
        const manifest = () => lib.reviewInputManifest(abs, planRoot);
        for (const profile of profiles) await lib.withReviewProfile(planRoot, profile.id, () => before.set(profile.id, manifest()));
        if (!profiles.length) before.set("legacy", manifest());
        let preparation = profiles.length ? null : readiness.inspectPlanPreparation({ plan, root: planRoot, cwd: planRoot, gatesDir, planFile:abs });
        const results = [];
        for (const profile of profiles) await lib.withReviewProfile(planRoot, profile.id, () => {
            const checked = readiness.inspectPlanPreparation({ plan, root: planRoot, cwd: planRoot, gatesDir, planFile:abs });
            if (preparation && JSON.stringify([preparation.steps,preparation.coverage]) !== JSON.stringify([checked.steps,checked.coverage])) throw new Error("Preparation target state changed between profiles");
            preparation = preparation ? { ...preparation, ok: preparation.ok && checked.ok, problems: [...preparation.problems, ...checked.problems] } : checked;
            const now = manifest();
            if (!now || now !== before.get(profile.id)) throw new Error("Preparation inputs changed");
            results.push({ id: profile.id, root: profile.root, policy_sha256: profile.hash,
                scope_sha256: lib.reviewProfileBinding(abs, planRoot).scope_sha256,
                input_manifest_sha256: now, ...checked });
        });
        if (!profiles.length && (!before.get("legacy") || manifest() !== before.get("legacy"))) throw new Error("Preparation inputs changed");
        if (lib.readPlanSnapshot(abs)?.sha !== sha) throw new Error("Preparation plan changed");
        const review = lib.reviewProblems(gatesDir, sha, planRoot);
        const engineCommit = registration ? registration.engine.commit : execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-C", ROOT, "rev-parse", "HEAD"], {
            env: { HOME: "/home/nextain", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8", timeout: 5000 }).trim();
        const output = { purpose: "plan-preparation/v1", plan_sha256: sha, plan_root: planRoot,
            engine_root: ROOT, engine_commit: engineCommit, engine_entry_sha256: BOOT_ENTRY_SHA,
            executor_manifest_sha256: sha256(JSON.stringify([...STARTUP_EXECUTOR_SHAS].sort())),
            ok: preparation.ok && (cmd!=="ready"||review.ok), problems: [...preparation.problems,...(cmd==="ready"?review.problems:[])], steps: preparation.steps,
            profiles: results, review: { ok: review.ok, problems: review.problems } };
        console.log(JSON.stringify(output)); process.exitCode = output.ok ? 0 : 1; return output;
    }
	case "check": {
		const { abs, plan, gatesDir, sha, root: planRoot } = loadPlan(args[0]);
		const form = lib.formProblems(plan);
		console.log(`계획서: ${path.relative(planRoot, abs)}  sha256 ${sha}`);
		for (const s of plan.scenario || []) for (const c of s.commands || []) console.log(`  ${s.id}  ${commandHash(c)}  ${String(c).slice(0, 120)}`);
		for (const a of plan.incident?.actions || []) for (const c of a.commands || []) console.log(`  장애 ${a.id}  ${commandHash(c)}  ${String(c).slice(0, 120)}`);
		console.log(form.length ? `양식: 빈 칸 ${form.length}\n${form.map((x) => `- ${x}`).join("\n")}` : "양식: 통과");
		const warnings = typeof lib.formWarnings === "function" ? lib.formWarnings(plan) : [];
		if (warnings.length) console.log(`경고 ${warnings.length}\n${warnings.map((x) => `- ${x}`).join("\n")}`);
		const r = reviewStatus(gatesDir, sha, false, planRoot);
		console.log(r.ok ? "적대 리뷰: 통과" : `적대 리뷰: 미통과\n${r.problems.map((x) => `- ${x}`).join("\n")}`);
		process.exit(form.length || !r.ok ? 1 : 0);
	}
	case "report": {
		const { plan, gatesDir, sha, root: planRoot } = loadPlan(args[0]);
		const form = lib.formProblems(plan);
		if (form.length) die(`양식 빈 칸 ${form.length}건 — 보고문을 낼 수 없습니다\n${form.join("\n")}`, 1);
		const warnings = typeof lib.formWarnings === "function" ? lib.formWarnings(plan) : [];
		for (const w of warnings) console.error(w);
		const r = lib.reviewProblems(gatesDir, sha, planRoot);
		if (!r.ok) die(`적대 리뷰 미통과 — 보고문을 낼 수 없습니다\n${r.problems.join("\n")}`, 1);
		console.log(lib.renderReport(plan, sha, r));
		break;
	}
	case "review-prompt": {
		const { abs, plan, sha, root: planRoot } = loadPlan(args[0]);
		const profileIds = lib.registeredReviewProfileIds(planRoot);
		if (profileIds.length && !lib.reviewProfileBinding(abs, planRoot)) {
			for (const id of profileIds) await lib.withReviewProfile(planRoot, id, () => runApprovalPlan(argv));
			return;
		}
		try { lib.reviewModelsFor(planRoot); }
		catch (error) { die(`리뷰 모델 설정을 읽지 못함: ${error.message}`, 1); }
		const roBind = lib.planReadOnlyScriptsBinding(plan, planRoot);
		if (!roBind.ok) die(roBind.why, 1);
		console.log(lib.reviewPrompt(plan, sha, planRoot, { planFile: abs, readOnlyScripts: roBind.items }));
		break;
	}
	case "review": {
		const { abs, plan, gatesDir, sha, root: planRoot } = loadPlan(args[0]);
		const profileIds = lib.registeredReviewProfileIds(planRoot);
		const profile = lib.reviewProfileBinding(abs, planRoot);
		if (profileIds.length && !profile) {
            const expected=new Map();
            if(registration)for(const id of profileIds)await lib.withReviewProfile(planRoot,id,()=>{
                const ready=readiness.inspectPlanPreparation({plan,root:planRoot,cwd:planRoot,gatesDir,planFile:abs});
                if(!ready.ok)die("Registered mandatory preparation failed: "+ready.problems.join("; "),1);
                expected.set(id,JSON.stringify([lib.reviewProfileBinding(abs,planRoot),lib.reviewInputManifest(abs,planRoot)]));
            });
			let passed = true;
			for (const id of profileIds) {
				console.log(`Review gate: ${id}`);
				const ok = await lib.withReviewProfile(planRoot, id, () => runApprovalPlan(argv));
				if (!ok) passed = false;
			}
            if(registration)for(const id of profileIds)await lib.withReviewProfile(planRoot,id,()=>{
                const ready=readiness.inspectPlanPreparation({plan,root:planRoot,cwd:planRoot,gatesDir,planFile:abs});
                if(!ready.ok||expected.get(id)!==JSON.stringify([lib.reviewProfileBinding(abs,planRoot),lib.reviewInputManifest(abs,planRoot)]))passed=false;
            });
			const combined = lib.reviewProblems(gatesDir, sha, planRoot);
			if (!combined.ok) console.error(combined.problems.join("\n"));
			process.exitCode = passed && combined.ok ? 0 : 1;
			return passed && combined.ok;
		}
		const recordDir = lib.reviewRecordDirectory(gatesDir, true);
		try { lib.reviewModelsFor(planRoot); }
		catch (error) { die(`리뷰 모델 설정을 읽지 못함: ${error.message}`, 1); }
		const roBind = lib.planReadOnlyScriptsBinding(plan, planRoot);
		if (!roBind.ok) die(roBind.why, 1);
		let early = null;
		try { early = lib.reviewInputEntries(abs, planRoot, { readOnlyScripts: roBind.items }); } catch { early = null; }
		const bindProblems = [];
		if (!early || early.digest === null) bindProblems.push(`읽기 전용 검사 실패: 리뷰 대상 또는 실행기가 바뀜(${early && early.problems.length ? early.problems[0] : "계획서·핀·실행기를 읽지 못함"})`);
		else {
			if (early.planSha256 !== sha) bindProblems.push("읽기 전용 검사 실패: 리뷰 대상 또는 실행기가 바뀜(계획서가 manifest 계산 뒤 바뀜)");
			const earlyByFile = new Map((early.entries || []).map((e) => [e.file, e.sha256]));
			if (STARTUP_EXECUTOR_SHAS.size !== lib.REVIEW_EXECUTOR_FILES.length) bindProblems.push("읽기 전용 검사 실패: 리뷰 대상 또는 실행기가 바뀜(실행기 목록이 기동 뒤 바뀜)");
			for (const [rel, want] of STARTUP_EXECUTOR_SHAS) {
				let now = null;
				try { now = sha256(fs.readFileSync(path.join(ROOT, rel))); } catch { now = null; }
				const earlySha = earlyByFile.get(rel) ?? null;
				if (want === null || now === null || earlySha === null || now !== want || earlySha !== want) {
					bindProblems.push(`읽기 전용 검사 실패: 리뷰 대상 또는 실행기가 바뀜(실행기 ${rel} 가 적재 경계 또는 기동 뒤 바뀜)`);
					break;
				}
			}
		}
		if (bindProblems.length) die(bindProblems.join("\n"), 1);
		const author = opt(args, "--author");
		if (!lib.ROTATION.includes(author)) die("--author argon|codex|muse|claude 가 필요합니다(차례 작성자 중 계획서 author_model 과 같은 것)");
		if (plan.author_model !== author) die("--author(argon|codex|muse|claude) 와 계획서 author_model 이 다릅니다");
		const form = lib.formProblems(plan);
		if (form.length) die(`양식 빈 칸 ${form.length}건 — 먼저 채우십시오\n${form.join("\n")}`, 1);
		const warnings = typeof lib.formWarnings === "function" ? lib.formWarnings(plan) : [];
		for (const w of warnings) console.error(w);
		const pins = lib.pinnedFileProblems(plan, planRoot);
		if (pins.length) die(pins.join("\n"), 1);
		const prompt = lib.reviewPrompt(plan, sha, planRoot, { planFile: abs, readOnlyScripts: roBind.items });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomUUID();
		const out = opt(args, "--out");
		if (profile && out && (out === "." || out === ".." || path.basename(out) !== out)) die("For registered gates --out is a filename within each gate's review directory");
		const base = out ? (profile ? path.join(recordDir, out) : path.resolve(out)) : path.join(recordDir, `deploy-plan-review-${stamp}.md`);
		// 차례는 기록 reviewedAt 과 같은 시각으로 고른다. 관문이 같은 시각으로 차례를 다시 만들어 대조한다.
		const reviewedAt = new Date().toISOString();
		let ids;
		try { ids = lib.orderedReviewers(author, planRoot, reviewedAt); }
		catch (error) { die(`리뷰 차례를 정하지 못함: ${error.message}`); }
		const activeModels = lib.reviewModelsFor(planRoot);
		if (ids.some((id) => lib.selfReview(author, id, activeModels))) die("작성자와 같은 모델은 리뷰할 수 없습니다", 1);
		try { lib.reviewModelsFor(planRoot); }
		catch (error) { die(`리뷰 모델 설정을 읽지 못함: ${error.message}`); }
		const parsed = path.parse(base);
		const outputs = ids.map((id) => path.join(parsed.dir, `${parsed.name}-${id}${parsed.ext || ".md"}`));
		for (const out of outputs) if (out === abs || fs.existsSync(out)) die("리뷰 결과 경로가 이미 있습니다. 새 --out 경로를 쓰십시오");
		try { for (const out of outputs) lib.resultFile(recordDir, path.relative(recordDir, out), true); }
		catch { die("--out 은 해당 계획서 gatesDir 안 일반 파일 경로여야 합니다. 하위 폴더는 먼저 만드십시오"); }
		const planRel = path.relative(planRoot, abs);
		const lockHandle = lib.acquirePlanReviewLock({ repoRoot: planRoot, plan: planRel, pid: process.pid, env: process.env });
		if (!lockHandle.ok) die(lockHandle.why, 1);
		const cleanupLock = () => { try { lib.releasePlanReviewLock(lockHandle); } catch {} };
		const cancellation = new AbortController();
		const cancel = (code) => {
			if (cancellation.signal.aborted) return;
			process.exitCode = code;
			cancellation.abort();
		};
		const onSigInt = () => cancel(130);
		const onSigTerm = () => cancel(143);
		const onSigHup = () => cancel(129);
		process.once("exit", cleanupLock);
		process.on("SIGINT", onSigInt);
		process.on("SIGTERM", onSigTerm);
		process.on("SIGHUP", onSigHup);
		try {
			const rec = { plan_sha256: sha, plan: planRel, author_model: author, prompt_sha256: sha256(prompt), read_only_scripts: roBind.items, rotation: true, skipped: [], reviewers: [], reviewedAt };
			if (profile) rec.review_profile = profile;
			const writeRecord = () => writeReviewFile(lib.resultFile(lib.reviewRecordDirectory(gatesDir), lib.REVIEW_FILE, true), `${JSON.stringify(rec, null, 2)}\n`, profile);
			writeRecord();
			const reviewStartedAt = Date.now();
			// 리뷰 본문은 계획서 낱말을 되풀이할 수 있으므로 한도 판별에서 뺀다.
			const limitTextOf = (r) => `${r.stderr || ""}\n${r.error || ""}`;
			let actual = null, actualOutput = null;
			const roOpt = { readOnlyScripts: roBind.items, registeredProviders:registration?.providers };
			try {
				const [first] = await runReviewers([ids[0]], prompt, abs, early.digest, roOpt, planRoot, cancellation.signal);
				if (cancellation.signal.aborted) return;
				if (lib.isLimitFailure(first.receipt?.exit_code, limitTextOf(first)) && ids.length > 1) {
					rec.skipped.push({ id: ids[0], model: first.model, effort: first.effort, reason: "limit", exit_code: first.receipt.exit_code, ended_at: first.receipt.ended_at });
					console.log(`한도 실패로 다음 차례 리뷰어로 넘어감: ${ids[0]} → ${ids[1]}`);
					const [second] = await runReviewers([ids[1]], prompt, abs, early.digest, roOpt, planRoot, cancellation.signal);
					actual = second; actualOutput = outputs[1];
				} else {
					actual = first; actualOutput = outputs[0];
				}
			}
			catch (error) {
				if (cancellation.signal.aborted) return;
				die(`읽기 전용 실행 준비 실패. 이전 리뷰 기록은 무효입니다 ${reviewErrorDetails(error, error.reviewStage || "review-prepare", reviewStartedAt, planRoot)}`, 3);
			}
			if (cancellation.signal.aborted) return;
			{
				const r = actual;
				const text = r.body.endsWith("\n") ? r.body : `${r.body}\n`;
				const final = `${text}review-run: target_sha256=${sha} prompt_sha256=${sha256(prompt)} stdout_sha256=${sha256(text)}\n`;
				let output;
				try { output = lib.resultFile(lib.reviewRecordDirectory(gatesDir), path.relative(recordDir, actualOutput), true); }
				catch { die("리뷰 실행 중 결과 경로가 gatesDir 밖 또는 일반 파일이 아닌 경로로 바뀜", 3); }
				fs.writeFileSync(output, final, { flag: "wx" });
				rec.reviewers.push({ id: r.id, model: r.model, effort: r.effort, result: path.relative(recordDir, actualOutput), result_sha256: sha256(final), target_sha256: sha, receipt: { ...r.receipt, stdout_sha256: sha256(text), isolation: r.isolation }, ...(r.error ? { execution_error: r.error } : {}) });
				console.log(`결과 ${r.id}: ${path.relative(planRoot, actualOutput)}`);
			}
			writeRecord();
			const r = reviewStatus(gatesDir, sha, true, planRoot);
			console.log(r.ok ? "적대 리뷰: 통과 — 승인 요청 가능" : `적대 리뷰: 미통과\n${r.problems.map((x) => `- ${x}`).join("\n")}`);
			cleanupLock();
			if (profile) return r.ok;
			process.exit(r.ok ? 0 : 1);
		} finally {
			cleanupLock();
			process.removeListener("exit", cleanupLock);
			process.removeListener("SIGINT", onSigInt);
			process.removeListener("SIGTERM", onSigTerm);
			process.removeListener("SIGHUP", onSigHup);
		}
	}
	case "preapprove": {
		const { abs, root: planRoot } = loadPlan(args[0]);
		const session = opt(args, "--session");
		if (!session) die("--session <rootSessionId> 가 필요합니다");
		const profile=registration?.profiles.find(p=>p.id===gateConfigView.getStore()?.admissionProfile);
		const admissionEnv=profile?{...process.env,DEPLOY_APPROVAL_STATE_DIR:profile.stateDir}:process.env;
		const r = await lib.preapproveStepCodes(abs, planRoot, session, admissionEnv, Date.now());
		if (!r.ok) die(`사전발급 거부: ${r.why}`, 1);
		console.log(r.report);
		console.log(`승인 세션: ${session} / 계획서: ${abs}`);
		console.log(`사전발급 코드(사용자 본인이 한 메시지로 승인): PLAN ${r.plan_code} ` + r.steps.map((s) => `${s.step} ${s.code}`).join(" "));
		break;
	}
	case "step-ok": {
		const { plan, gatesDir, sha, root: planRoot } = loadPlan(args[0]);
		try { lib.reviewModelsFor(planRoot); }
		catch (error) { die(`리뷰 모델 설정을 읽지 못함: ${error.message}`, 1); }
		const step = args[1];
		if (!(plan.scenario || []).some((s) => s.id === step)) die(`단계 ${step} 가 계획서에 없습니다`);
		try { lib.verifyTargetResults(plan, planRoot, step); }
		catch (error) { die(error.message, 1); }
		const ev = opt(args, "--evidence");
		if (!ev || !fs.existsSync(ev)) die("--evidence <성공 확인 출력 파일> 이 필요합니다");
		const dir = path.join(gatesDir, "deploy-steps");
		fs.mkdirSync(dir, { recursive: true });
		const copy = path.join(dir, `${step}-evidence.txt`);
		fs.copyFileSync(ev, copy);
		const rec = { plan_sha256: sha, step, verdict: "pass", evidence: path.basename(copy), evidence_sha256: sha256(fs.readFileSync(copy)), checkedAt: new Date().toISOString() };
		fs.writeFileSync(path.join(dir, `${step}.json`), `${JSON.stringify(rec, null, 2)}\n`);
		console.log(`단계 ${step} 성공 확인 기록: ${path.relative(planRoot, path.join(dir, `${step}.json`))}`);
		break;
	}
	case "judge": {
		const { abs, plan, gatesDir, sha, root: planRoot } = loadPlan(args[0]);
		let museCfg;
		try { museCfg = lib.reviewModelsFor(planRoot).muse; }
		catch (error) { die(`리뷰 모델 설정을 읽지 못함: ${error.message}`, 1); }
		if (!museCfg || (museCfg.runner && museCfg.runner !== "muse")) die("장애 판정자는 muse 실행기여야 합니다", 1);
		const roBind = lib.planReadOnlyScriptsBinding(plan, planRoot);
		if (!roBind.ok) die(roBind.why, 1);
		let judgeManifest;
		try { judgeManifest = lib.reviewInputManifest(abs, planRoot, { readOnlyScripts: roBind.items }); }
		catch (error) { die(`판정 입력 목록(input manifest)을 읽지 못함: ${error.message}`, 1); }
		const evidence = optAll(args, "--evidence");
		const executor = opt(args, "--executor-session") || process.env.CLAUDE_SESSION_ID || "";
		if (!executor) die("--executor-session <실행 세션 id> 가 필요합니다");
		if (evidence.length === 0) die("--evidence <확인 결과·헬스·오류 로그 파일> 이 하나 이상 필요합니다");
		const ev = evidence.map((p) => { const evAbs = path.resolve(p); const buf = fs.readFileSync(evAbs); return { path: evAbs, sha256: sha256(buf), text: buf.toString("utf8").slice(0, 20000) }; });
		const prompt = [
			"당신은 운영 배포를 실행하는 세션과 다른, 독립 판정자입니다. 지금 상황이 '장애'인지 '개발'인지 판정하십시오.",
			"장애(incident): 운영 사용자에게 지금 영향이 있거나 곧 생기며, 계획서의 장애 판단 기준에 해당한다. 계획서에 미리 적은 선조치를 바로 해야 한다.",
			"개발(development): 배포 작업 중 생긴 실패·예상 밖 결과지만 운영 사용자 영향이 없거나 기준에 해당하지 않는다. 실행 세션은 멈추고 보고해야 한다.",
			"애매하면 개발로 판정하십시오(선조치는 승인 없이 도는 길이라 좁게 씁니다).",
			"",
			"장애 판단 기준:",
			...((plan.incident && plan.incident.criteria) || []).map((c) => `- ${c}`),
			"선조치 목록:",
			...((plan.incident && plan.incident.actions) || []).map((a) => `- ${a.id}: ${a.why_safe}`),
			"",
			...ev.flatMap((e) => [`증거 ${path.basename(e.path)}:`, "```", e.text, "```"]),
			"",
			"출력 마지막 줄을 정확히 'VERDICT: incident' 또는 'VERDICT: development' 로 쓰고, 그 위에 근거를 3줄 이내로 적으십시오.",
		].join("\n");
		const raw = runMuse(prompt, museCfg, registration?.providers.muse);
		let afterJudgeManifest = null;
		try {
			const planAfter = JSON.parse(fs.readFileSync(abs, "utf8"));
			const afterRo = lib.planReadOnlyScriptsBinding(planAfter, planRoot);
			if (afterRo.ok) afterJudgeManifest = lib.reviewInputManifest(abs, planRoot, { readOnlyScripts: afterRo.items });
		} catch { afterJudgeManifest = null; }
		if (!afterJudgeManifest || afterJudgeManifest !== judgeManifest) {
			die("판정 중 계획서·설정·실행기가 바뀌어 판정 기록을 남기지 않음", 3);
		}
		const lastLine = raw.trim().split(/\r?\n/).filter((l) => l.trim()).pop() || "";
		const m = lastLine.match(/^\s*VERDICT:\s*(incident|development)\s*$/i);
		const verdict = m ? m[1].toLowerCase() : "development";
		const judgeSession = `muse-judge-${crypto.randomUUID()}`;
		const dir = path.join(gatesDir, "deploy-incident");
		fs.mkdirSync(dir, { recursive: true });
		const rec = { plan_sha256: sha, input_manifest_sha256: judgeManifest, verdict, judge: { model: museCfg.model, effort: museCfg.effort, session: judgeSession }, executor_session: executor, evidence: ev.map(({ path: p, sha256: s }) => ({ path: p, sha256: s })), decidedAt: new Date().toISOString(), raw_output: raw.slice(-4000), raw_sha256: sha256(raw) };
		const file = path.join(dir, `${rec.decidedAt.replace(/[:.]/g, "-")}.json`);
		fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
		console.log(`판정: ${verdict === "incident" ? "장애 — 계획서의 선조치만 실행하고 바로 보고" : "개발 — 선조치 불가, 멈추고 보고"}\n기록: ${path.relative(planRoot, file)}`);
		process.exit(verdict === "incident" ? 0 : 1);
	}
	default:
		die("사용: approval-plan.mjs template|prepare|check|report|review|review-prompt|preapprove|step-ok|judge (docs/guides/approval-plan-gate.md)");
}

}
return runApprovalPlan;
}
module.exports = { createApprovalPlanCli };
