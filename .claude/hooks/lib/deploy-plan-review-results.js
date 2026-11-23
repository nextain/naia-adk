"use strict";
// Plan gate responsibility: review-results.
const path = require("path");
const fs = require("fs");
const { sha256, resolveRepoRoot, readJson, REVIEW_FILE, readPlanSnapshot, PLAN_FILE, resultFile, isoMs } = require("./deploy-plan-common.js");
const { CRITERIA, riskAcceptanceProblems, riskAcceptanceActive, requiresArchitectureFit } = require("./deploy-plan-schema.js");
const { registeredReviewProfiles, withReviewProfile, gateConfigView: gateConfigContext, reviewRecordDirectory, reviewProfileBinding } = require("./deploy-plan-context.js");
const { reviewModelsFor, isRotationRecord, AUTHOR_IDS, reviewerIdsFor, AUTHOR_MODELS, LEGACY_REVIEW_CUTOFF, ROTATION, orderedReviewers, REVIEW_MODELS, selfReview } = require("./deploy-plan-review-policy.js");
const { pinnedFileProblems } = require("./deploy-plan-targets.js");
const { validateReadOnlyBindingRecords } = require("./deploy-plan-readonly-policy.js");
const { planReadOnlyScriptsBinding } = require("./deploy-plan-readonly-binding.js");
const { reviewPrompt, reviewInputEntries } = require("./deploy-plan-review-input.js");

/** review-run 결과 파일 끝줄: review-run: target_sha256=… prompt_sha256=… stdout_sha256=… */
function reviewTrailer(text) {
	const lines = text.split("\n");
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	const last = lines[lines.length - 1] || "";
	const m = last.match(/^review-run: target_sha256=(\S+) prompt_sha256=([a-f0-9]{64}) stdout_sha256=([a-f0-9]{64})$/);
	if (!m) return null;
	const body = text.slice(0, text.lastIndexOf(last));
	return { targets: m[1].split(","), prompt: m[2], stdout: m[3], bodySha: sha256(Buffer.from(body, "utf8")), body };
}

function reviewBodyProblems(text, sha, acceptSecurity = false, opts = null) {
	const requireArchFit = !opts || opts.requireArchitectureFit !== false;
	const problems = [];
	const tr = reviewTrailer(text);
	if (!tr) problems.push("적대 리뷰 결과 끝줄이 review-run: 줄이 아님");
	else {
		if (tr.targets.length !== 1 || tr.targets[0] !== sha) problems.push("적대 리뷰 결과의 target_sha256 에 이 계획서 sha 가 없음");
		if (tr.bodySha !== tr.stdout) problems.push("적대 리뷰 결과 본문이 review-run 기록(stdout_sha256)과 다름");
	}
	const body = tr ? tr.body : text;
	const summary = [];
	for (const [id] of CRITERIA) {
		const re = new RegExp(`^[\\s>*#|\\-]*(?:기준\\s*)?\`?${id}\`?\\b[^\\n]*?[:：|=]\\s*\\**\\s*(PASS|FAIL)\\b(.*)$`, "gim");
		const hits = [...body.matchAll(re)];
		if (hits.length === 0) {
			if (id === "architecture_fit" && !requireArchFit) {
				summary.push({ id, verdict: "생략(옛 계획)" });
				continue;
			}
			problems.push(`적대 리뷰 결과에 기준 ${id} 판정 줄이 없음("${id}: PASS" 또는 "${id}: FAIL")`); summary.push({ id, verdict: "없음" }); continue;
		}
		const verdicts = hits.map((h) => h[1].toUpperCase());
		const verdict = verdicts.includes("FAIL") ? "FAIL" : "PASS";
		if (verdict !== "PASS" && !(acceptSecurity && id === "security")) problems.push(`적대 리뷰 기준 ${id} 미통과`);
		summary.push({ id, verdict, note: (hits[0][2] || "").replace(/^[\s*|—-]+/, "").trim().slice(0, 160) });
	}
	// 마지막 줄을 본다. 앞 회차 요약의 "남은 지적: 0" 뒤에 새 지적이 붙어도 통과하지 않게.
	const open = [...body.matchAll(/(?:남은\s*지적|open[_ ]findings)\s*[:：=]\s*(\d+)/gi)].pop();
	if (!open) problems.push("적대 리뷰 결과에 \"남은 지적: <수>\" 줄이 없음");
	// 남은 지적은 차단 지적 수다. 참고 지적은 세지 않는다. 다만 목록에 [차단] 줄이 하나라도 있으면 남은 지적 숫자와 관계없이 미통과.
	const blockingLines = body.split(/\r?\n/).filter((line) => /^\s*(?:\d+[.)]|[-*])\s*\**\s*\[\s*차단/.test(line) || /^\s*\|.*\[\s*차단\s*:/.test(line));
	// 위험 수용 중에는 security 를 적은 차단 지적 하나만 뺀다(승인자는 값 하나를 받아들였다). 두 번째 security 지적은 새 노출로 보고 막는다.
	// 남은 지적 수도 1 이어야 한다.
	const securityFailed = summary.some((s) => s.id === "security" && s.verdict === "FAIL");
	const accepted = acceptSecurity && securityFailed ? blockingLines.filter((line) => /\bsecurity\b/i.test(line)).slice(0, 1) : [];
	if (blockingLines.length > accepted.length) problems.push(`적대 리뷰 목록에 차단 지적 ${blockingLines.length - accepted.length}건${accepted.length ? "(security 위험 수용분 제외)" : ""}`);
	if (open && Number(open[1]) !== accepted.length) problems.push(`적대 리뷰 남은 지적 ${open[1]}건${accepted.length ? `(security 위험 수용 ${accepted.length}건만 남아야 함)` : ""}`);
	const advisoryLines = body.split(/\r?\n/).filter((line) => /^\s*(?:\d+[.)]|[-*])\s*\**\s*\[\s*참고/.test(line));
	const advisory = [...body.matchAll(/참고\s*지적\s*[:：=]\s*(\d+)/g)].pop();
	const first = body.trim().split(/\r?\n/).find((line) => !/^(?:codex|tokens used|\d[\d,]*)\s*$/i.test(line.trim())) || "";
	if (!/^판정:\s*PASS\s*$/i.test(first) && !(accepted.length && /^판정:\s*FAIL\s*$/i.test(first))) problems.push("적대 리뷰 전체 판정이 PASS 가 아님");
	return { ok: problems.length === 0, riskAccepted: accepted.length > 0, problems, summary, openFindings: open ? Number(open[1]) : null, advisoryFindings: advisory ? Number(advisory[1]) : advisoryLines.length, body, prompt_sha256: tr?.prompt };
}

/** 리뷰 결과의 무결성·대상·작성자 분리·열 기준을 모두 확인한다. 새 모양(rotation:true)은 차례 리뷰어 1명, 옛 모양은 예전 구성(muse→argon 또는 codex 1명, sol·argon→2명)과 다르면 거절한다. */
function reviewProblems(gatesDir, sha, root) {
	const base = root ? path.resolve(root) : resolveRepoRoot(gatesDir);
	try {
		const profiles = registeredReviewProfiles(base, true);
		if (!profiles.length) return selectedReviewProblems(gatesDir, sha, base);
		const results = profiles.map(p => [p.id, withReviewProfile(base, p.id, () => selectedReviewProblems(gatesDir, sha, base))]);
		const problems = results.flatMap(([id, r]) => r.problems.map(issue => `[${id}] ${issue}`));
		const reviewers = results.flatMap(([id, r]) => r.reviewers.map(row => ({ ...row, id: `${id}/${row.id}` })));
		const summary = results.flatMap(([id, r]) => r.summary.map(row => ({ ...row, reviewer: `${id}/${row.reviewer}` })));
		const manifests = results.map(([id, r]) => [id, r.input_manifest_sha256]);
		const verifiedLists = results.map(([, result]) => result.read_only_scripts);
		const sharedReads = problems.length ? [] : verifiedLists[0].filter(row => verifiedLists.every(items =>
			items.some(item => item.path === row.path && item.service === row.service && item.sha256 === row.sha256 && item.script_sha256 === row.script_sha256)));
		return { ok: !problems.length, problems, reviewers, summary, read_only_scripts: sharedReads, findings: profiles.map(p => `gates/reviews/${p.id}/deploy-plan-review-findings.md`),
			input_manifest_sha256: problems.length ? null : sha256(JSON.stringify(["gate-reviews/v1", manifests])) };
	} catch (error) {
		return { ok: false, problems: [error.message], reviewers: [], summary: [], input_manifest_sha256: null };
	}
}

function selectedReviewProblems(gatesDir, sha, base) {
	try { return singleReviewProblems(gatesDir, sha, base); }
	catch (error) { return { ok: false, problems: [error.message], reviewers: [], summary: [], input_manifest_sha256: null }; }
}

function reviewedReadOnlyScripts(gatesDir, root) {
	if (!gateConfigContext.getStore()?.profiles) {
		const record = readJson(path.join(gatesDir, REVIEW_FILE));
		return record?.review_profile === undefined && Array.isArray(record?.read_only_scripts) ? record.read_only_scripts : [];
	}
	const snapshot = readPlanSnapshot(path.join(gatesDir, PLAN_FILE));
	return snapshot ? (reviewProblems(gatesDir, snapshot.sha, root).read_only_scripts || []) : [];
}

function singleReviewProblems(gatesDir, sha, base) {
	let MODELS;
	try { MODELS = reviewModelsFor(base); }
	catch (error) {
		return { ok: false, problems: [`review_models 설정을 읽지 못함: ${error.message}`], reviewers: [], summary: [] };
	}
	const recordDir = reviewRecordDirectory(gatesDir);
	const file = path.join(gatesDir, PLAN_FILE);
	const profile = reviewProfileBinding(file, base);
	const rec = readJson(profile ? resultFile(recordDir, REVIEW_FILE, true) : path.join(recordDir, REVIEW_FILE));
	const snapshot = readPlanSnapshot(path.join(gatesDir, PLAN_FILE));
	const plan = snapshot?.plan;
	const problems = [];
	const reviewers = [];
	let manifest = null;
	let reviewedReads = [];
	const finish = () => {
		if (!isRotationRecord(rec)) {
			const author = rec?.author_model || plan?.author_model;
			if (AUTHOR_IDS.includes(author)) {
				for (const id of (author === "muse" ? [] : reviewerIdsFor(author))) {
					if (!reviewers.some((r) => r.id === id)) reviewers.push({ id, ...MODELS[id], ok: false, summary: [], openFindings: null, body: "", problems: ["리뷰어 결과 없음"] });
				}
			}
		}
		return { ok: problems.length === 0, problems, reviewers, input_manifest_sha256: manifest, ...(profile && !problems.length ? { read_only_scripts: reviewedReads } : {}), summary: reviewers.flatMap((r) => r.summary.map((s) => ({ ...s, reviewer: r.id }))) };
	};
	if (rec && (profile ? rec.review_profile?.id !== profile.id || rec.review_profile.scope_sha256 !== profile.scope_sha256 || rec.review_profile.policy !== profile.policy || rec.plan !== path.relative(base, file) : rec.review_profile !== undefined)) problems.push("Review record differs from the registered gate policy or plan scope");
	if (!plan || !AUTHOR_MODELS.includes(plan.author_model)) problems.push("계획서 author_model(sol|muse|argon|codex|claude) 필수");
	if (plan) problems.push(...riskAcceptanceProblems(plan));
	if (plan?.risk_acceptance !== undefined && riskAcceptanceProblems(plan).length === 0 && !riskAcceptanceActive(plan)) problems.push("risk_acceptance 끝남(expires_at 지남)");
	const acceptSecurity = riskAcceptanceActive(plan);
	problems.push(...pinnedFileProblems(plan, base));
	let roOpt = profile ? { planFile: file } : null;
	if (rec && rec.read_only_scripts !== undefined) {
		const validRo = validateReadOnlyBindingRecords(rec.read_only_scripts);
		if (!validRo.ok) problems.push(validRo.why);
		else roOpt = { planFile: file, readOnlyScripts: validRo.items };
	}
	if (profile && plan && rec) {
		const current = planReadOnlyScriptsBinding(plan, base);
		if (!current.ok || !Array.isArray(rec.read_only_scripts) || JSON.stringify(roOpt?.readOnlyScripts) !== JSON.stringify(current.items)) problems.push("Reviewed allowlist differs from the current gate policy");
		else reviewedReads = current.items;
	}
	let promptSha = null;
	try { if (plan) promptSha = sha256(reviewPrompt(plan, sha, base, roOpt)); } catch { problems.push("현재 요청문을 다시 만들지 못함"); }
	if (!rec) { problems.push("적대 리뷰 기록 없음: " + REVIEW_FILE); return finish(); }
	if (rec.plan_sha256 !== sha) problems.push("적대 리뷰가 지금 계획서가 아닌 판을 검수함. 계획서를 고쳤으면 다시 검수받을 것");
	if (snapshot?.sha !== sha) problems.push("현재 계획서 sha256 이 검증 대상과 다름");
	try {
		const inputs = reviewInputEntries(path.join(gatesDir, PLAN_FILE), base, roOpt);
		if (inputs.planSha256 === sha) manifest = inputs.digest;
	} catch {}
	if (!AUTHOR_MODELS.includes(rec.author_model)) problems.push("적대 리뷰 작성자 author_model 없음 또는 잘못됨");
	if (!plan || plan.author_model !== rec.author_model) problems.push("계획서 author_model 과 적대 리뷰 작성자가 다름");
	if (!isRotationRecord(rec)) {
		const cutoff = Date.parse(LEGACY_REVIEW_CUTOFF);
		const times = [rec.reviewedAt, ...(Array.isArray(rec.reviewers) ? rec.reviewers.map((r) => r?.receipt?.started_at) : [])].map(isoMs);
		if (!times.every((t) => Number.isFinite(t) && t < cutoff)) problems.push(`옛 모양 리뷰 기록(rotation 칸 없음)은 ${LEGACY_REVIEW_CUTOFF} 앞선 것만 받음(reviewedAt·영수증 시작 시각). 차례 리뷰로 다시 받을 것`);
	}
	if (isRotationRecord(rec)) {
		if (!ROTATION.includes(rec.author_model)) problems.push("차례 기록(rotation:true)의 작성자는 argon·codex·muse·claude 중 하나여야 함");
		if (!Array.isArray(rec.reviewers) || rec.reviewers.length !== 1) problems.push("차례 기록(rotation:true)은 리뷰어 1명의 기록이 필요함");
		// 차례 대조: 리뷰 시각의 차례(고정 설정 포함)에서 skipped 는 앞에서부터 건너뛴 후보 그대로, 실제 리뷰어는 그 다음 후보여야 한다. 한도 실패 없이 뒤 후보를 쓰거나 모순된 skipped 는 막는다.
		// 차례를 다시 만들 시각(reviewedAt)은 실제 리뷰 시작보다 늦을 수 없고, 90분보다 앞설 수 없다(첫 후보 45분 제한 + 준비 여유). 시각을 미래로 옮겨 고정 리뷰어를 피하는 길을 막는다.
		const reviewedAtMs = isoMs(rec.reviewedAt);
		const firstStartMs = Date.parse(rec.reviewers?.[0]?.receipt?.started_at);
		let order = null;
		if (!Number.isFinite(reviewedAtMs)) problems.push("차례 기록의 reviewedAt(UTC ISO 시각)이 없거나 틀림");
		else if (!Number.isFinite(firstStartMs) || reviewedAtMs > firstStartMs || firstStartMs - reviewedAtMs > 90 * 60 * 1000) problems.push("차례 기록의 reviewedAt 이 리뷰어 영수증 시작 시각과 맞지 않음(시작 전 90분 안이어야 함)");
		else try { order = ROTATION.includes(rec.author_model) ? orderedReviewers(rec.author_model, base, reviewedAtMs) : null; }
		catch (error) { problems.push(`차례 기록의 리뷰 차례를 다시 만들지 못함: ${error.message}`); }
		if (!Array.isArray(rec.skipped)) problems.push("차례 기록의 skipped 는 배열이어야 함");
		else {
			if (rec.skipped.length > 1) problems.push("차례 기록의 skipped 는 최대 1개여야 함");
			for (const [i, s] of rec.skipped.entries()) {
				if (!s || typeof s !== "object") { problems.push(`차례 기록의 skipped[${i}] 모양이 틀림`); continue; }
				if (!MODELS[s.id] || s.id === "sol") problems.push(`차례 기록의 skipped[${i}] id 는 승인된 리뷰어여야 함`);
				if (s.id === rec.author_model) problems.push(`차례 기록의 skipped[${i}] 가 작성자와 같음`);
				if (s.reason !== "limit") problems.push(`차례 기록의 skipped[${i}] reason 은 "limit" 이어야 함`);
				if (!Number.isInteger(s.exit_code) || s.exit_code === 0) problems.push(`차례 기록의 skipped[${i}] exit_code 는 0이 아닌 정수여야 함`);
				if (order && s.id !== order[i]) problems.push(`차례 기록의 skipped[${i}] 가 차례(${order[i]})와 다름`);
				if (MODELS[s.id]) {
					const skippedModel = s.model ?? REVIEW_MODELS[s.id]?.model;
					const skippedEffort = s.effort ?? REVIEW_MODELS[s.id]?.effort;
					if (skippedModel !== MODELS[s.id].model || skippedEffort !== MODELS[s.id].effort) {
						problems.push(`차례 기록의 skipped[${i}](${s.id}) 모델·강도가 지금 설정(${MODELS[s.id].model}/${MODELS[s.id].effort})과 다름`);
					}
				}
			}
			const reviewer = Array.isArray(rec.reviewers) && rec.reviewers.length === 1 ? Object.keys(MODELS).find((k) => MODELS[k].model === rec.reviewers[0]?.model) : undefined;
			if (order && reviewer !== undefined && reviewer !== order[rec.skipped.length]) problems.push(`차례 기록의 리뷰어가 차례(${order[rec.skipped.length] ?? "없음"})와 다름`);
		}
	} else if (rec.author_model === "codex") {
		problems.push("codex 작성 계획서는 차례 기록(rotation:true)이 필요함(옛 단일·2인 기록은 재리뷰 필요)");
	} else if (rec.author_model === "muse") {
		if (!Array.isArray(rec.reviewers) || rec.reviewers.length !== 1) problems.push("Muse 작성 계획서는 리뷰어 1명의 기록이 필요함(옛 2인·단일 기록은 재리뷰 필요)");
	} else if (!Array.isArray(rec.reviewers) || rec.reviewers.length !== 2) problems.push("서로 다른 리뷰어 두 명의 기록이 필요함(옛 단일 리뷰 기록 미통과)");
	if (!promptSha || rec.prompt_sha256 !== promptSha) problems.push("기록 prompt_sha256 이 현재 요청문과 다름");
	const entries = Array.isArray(rec.reviewers) ? rec.reviewers : [];
	if (entries.length === 2 && entries[0]?.result === entries[1]?.result) problems.push("리뷰어 결과 파일이 서로 같음");
	const expected = (isRotationRecord(rec) || rec.author_model === "muse" || rec.author_model === "codex") ? [] : reviewerIdsFor(rec.author_model);
	for (const id of expected) {
		const config = MODELS[id];
		if (!config) { problems.push(`[${id}] 승인된 리뷰어 없음`); continue; }
		const matches = entries.filter((r) => r && r.model === config.model);
		if (matches.length !== 1) problems.push(`[${id}] 리뷰어 기록 누락 또는 중복`);
	}
	const resultIdentities = new Set();
	const bodyHashes = new Set();
	for (const [i, r] of entries.entries()) {
		const id = Object.keys(MODELS).find((k) => MODELS[k].model === r?.model) || `unknown-${i}`;
		const own = [];
		if (r?.id !== undefined && r.id !== id) own.push("리뷰어 id 와 모델이 다름");
		if (!MODELS[id]) own.push("허용되지 않은 모델");
		else if (isRotationRecord(rec) && id === "sol") own.push("허용되지 않은 모델");
		else if (!isRotationRecord(rec) && rec.author_model === "muse" && !["argon", "codex"].includes(id)) own.push("허용되지 않은 모델");
		else if (r.effort !== MODELS[id].effort) own.push("리뷰어 추론 강도가 다름");
		if (selfReview(plan?.author_model, id, MODELS) || id === rec.author_model) own.push("작성자와 같은 모델이 리뷰함");
		if (entries.filter((x) => x?.model === r?.model).length !== 1) own.push("리뷰어 모델 기록 중복");
		if (r?.target_sha256 !== sha) own.push("리뷰어 target_sha256 이 지금 계획서와 다름");
		if (r?.execution_error) own.push("리뷰어 실행 실패: " + r.execution_error);
		let text = null;
		try {
			if (typeof r?.result === "string" && r.result) {
				const real = resultFile(recordDir, r.result);
				const stat = fs.statSync(real);
				const identity = `${stat.dev}:${stat.ino}`;
				if (resultIdentities.has(identity)) own.push("리뷰어 결과 파일이 서로 같음(경로 별칭 포함)");
				resultIdentities.add(identity);
				text = fs.readFileSync(real, "utf8");
			}
		} catch {}
		let parsed = { summary: [], openFindings: null, body: "" };
		if (text === null) own.push("적대 리뷰 결과 파일을 읽지 못함");
		else {
			if (r.result_sha256 !== sha256(Buffer.from(text, "utf8"))) own.push("적대 리뷰 결과 파일의 sha256 이 기록과 다름");
			parsed = reviewBodyProblems(text, sha, acceptSecurity, { requireArchitectureFit: requiresArchitectureFit(plan) });
			own.push(...parsed.problems);
			if (!parsed.prompt_sha256 || parsed.prompt_sha256 !== rec.prompt_sha256 || parsed.prompt_sha256 !== promptSha) own.push("결과 prompt_sha256 이 기록 또는 현재 요청문과 다름");
			const receipt = r.receipt;
			if (!receipt || receipt.model !== r.model || receipt.effort !== r.effort || receipt.prompt_sha256 !== promptSha || receipt.exit_code !== 0 || !Number.isFinite(Date.parse(receipt.started_at)) || !Number.isFinite(Date.parse(receipt.ended_at)) || Date.parse(receipt.started_at) > Date.parse(receipt.ended_at) || receipt.stdout_sha256 !== sha256(parsed.body)) own.push("리뷰어 실행 영수증(모델·강도·시작·끝·종료 코드·요청문·본문 해시) 불일치");
			// 승인에 쓰는 영수증의 manifest는 필수다. 없거나 현재 값과 다르면 승인 불가(옛 기록은 재리뷰 필요).
			if (!receipt || typeof receipt.input_manifest_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(receipt.input_manifest_sha256) || manifest === null || receipt.input_manifest_sha256.toLowerCase() !== manifest) own.push("리뷰어 실행 영수증(input manifest) 없음 또는 불일치(없는 옛 기록은 재리뷰 필요)");
			const bodyHash = sha256(parsed.body);
			if (bodyHashes.has(bodyHash)) own.push("두 리뷰어 결과 본문이 바이트로 같음(복사 바꿔치기)");
			bodyHashes.add(bodyHash);
		}
		const row = { id, model: r?.model, effort: r?.effort, result: r?.result, ...parsed, problems: own, ok: own.length === 0 };
		reviewers.push(row);
		problems.push(...own.map((p) => `[${id}] ${p}`));
	}
	if (new Set(reviewers.map((r) => r.prompt_sha256).filter(Boolean)).size > 1) problems.push("두 리뷰어가 서로 다른 요청문을 검수함(prompt_sha256 불일치)");
	return finish();
}

/** 각 리뷰어 결과의 지적 원문과 기준별 FAIL 을 합친다. 같은 문구만 중복으로 묶고 의미 중복은 추정하지 않는다. */
function renderMergedFindings(review, sha) {
	const groups = new Map();
	for (const r of review.reviewers || []) {
		const findings = r.body.split(/\r?\n/).filter((line) => /^\s*(?:\d+[.)]|[-*]\s*\[)/.test(line));
		for (const s of r.summary) if (s.verdict !== "PASS") findings.push(`${s.id}: ${s.verdict} — ${s.note || "판정 누락"}`);
		for (const finding of findings) {
			const key = finding.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").replace(/\s+/g, " ").trim();
			if (!groups.has(key)) groups.set(key, new Set());
			groups.get(key).add(r.id);
		}
	}
	return [`# 정식 계획서 리뷰 지적 통합`, `계획서 sha256: ${sha}`, "", ...((review.reviewers || []).map((r) => `- ${r.id}: ${r.body ? (r.ok ? "PASS" : "FAIL") : "결과 없음"}, 남은 지적(차단) ${r.openFindings ?? "확인 불가"}건, 참고 지적 ${r.advisoryFindings ?? 0}건(차단 아님)`)), "", ...review.problems.map((p) => `- 검증: ${p}`), "", ...[...groups].map(([f, ids]) => `- [${[...ids].join(", ")}${ids.size > 1 ? "; 중복" : ""}] ${f}`), "", "## 리뷰어 원문", ...((review.reviewers || []).flatMap((r) => [`### ${r.id}`, r.body || "(결과 없음)", ""]))].join("\n");
}

module.exports = {
	reviewTrailer,
	reviewBodyProblems,
	reviewProblems,
	selectedReviewProblems,
	reviewedReadOnlyScripts,
	singleReviewProblems,
	renderMergedFindings,
};
