// Existing readiness evidence responsibility; behavior is owned by the public facade.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { sameCommit, readJson, sha256File, resolveIn } = require("./deploy-readiness-io.js");

const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const TOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const KINDS = new Set(["feature", "ops", "rollback"]);
/** 서비스 전부를 담은, 12시간 안의 가장 새 기록. */
function findReadiness(services, root, now = Date.now()) {
	const base = path.join(root, ".agents", "progress");
	let dirs = [];
	try {
		dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_"));
	} catch {
		return null;
	}
	let best = null;
	for (const d of dirs) {
		const file = path.join(base, d.name, "gates", "deploy.json");
		const rec = readJson(file);
		if (!rec || !Array.isArray(rec.services)) continue;
		if (!services.every((s) => rec.services.includes(s))) continue;
		const at = Date.parse(rec.createdAt || "");
		if (!Number.isFinite(at) || now - at > MAX_AGE_MS || at - now > 5 * 60 * 1000) continue;
		if (!best || at > best.at) best = { at, file, record: rec };
	}
	return best;
}

function defectFile(service, root) {
	return path.join(root, ".agents", "progress", "_service-defects", `${service.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
}

function defectFact(service, root, open) {
	if (!fs.existsSync(defectFile(service, root))) return `${service} 열린 치명 결함: 확인 안 됨(결함 목록 ${path.relative(root, defectFile(service, root))} 없음. 알려진 결함이 기록되지 않았을 수 있음)`;
	return `${service} 열린 치명 결함: ${open.length}건${open.length ? ` (${open.map((d) => d.id).join(", ")})` : ""}`;
}

function openCriticalDefects(service, root) {
	const safe = service.replace(/[^A-Za-z0-9._-]+/g, "_");
	const rec = readJson(path.join(root, ".agents", "progress", "_service-defects", `${safe}.json`));
	const list = rec && Array.isArray(rec.defects) ? rec.defects : [];
	return list.filter((d) => d && d.severity === "critical" && d.status !== "closed");
}

function defectVersions(d) {
	const out = [];
	for (const k of ["candidate", "candidates", "affects", "version", "versions", "image", "commit"]) {
		const v = d[k];
		for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && x.trim()) out.push(x.trim());
	}
	return out;
}

function git(repo, args) {
	if(require("./deploy-plan-context.js").gateConfigView.getStore()?.executionRegistrationSha256)return require("../../../scripts/lib/registered-git-identity.cjs").registeredGit(repo,args);
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000, maxBuffer: 8 << 20 });
}

function checkCodeGate(file, candidate, now) {
	const problems = [];
	const g = readJson(file);
	if (!g) return { problems: [`코드 검수 기록을 읽지 못함: ${file}`] };
	if (g.stage !== "code") problems.push("코드 검수 기록의 stage 가 code 가 아님");
	if (g.verdict !== "pass") problems.push("코드 검수 기록의 verdict 가 pass 가 아님");
	const a = g.author || {};
	const r = g.reviewer || {};
	if (!a.session || !r.session || a.session === r.session) problems.push("코드 작성자와 검수자의 세션이 같거나 비어 있음");
	const targets = Array.isArray(g.targets) ? g.targets : [];
	if (!targets.some((t) => t && typeof t.commit === "string" && t.commit.length >= 7 && (candidate.startsWith(t.commit) || t.commit.startsWith(candidate)))) problems.push(`코드 검수 기록의 targets 에 후보 ${candidate} 가 없음`);
	const tools = Array.isArray(g.tools) ? g.tools : [];
	const ui = tools.find((t) => t && t.name === "ui-copy-lint");
	if (!ui) problems.push("코드 검수 기록에 화면 문구 검사(ui-copy-lint) 출력이 없음");
	else {
		const out = resolveIn(path.dirname(file), ui.path || "");
		if (!ui.path || !fs.existsSync(out)) problems.push(`화면 문구 검사 출력 파일이 없음: ${ui.path}`);
		else {
			if (ui.sha256 !== sha256File(out)) problems.push("화면 문구 검사 출력의 sha256 이 기록과 다름");
			if (now - fs.statSync(out).mtimeMs > TOOL_MAX_AGE_MS) problems.push("화면 문구 검사 출력이 24시간보다 오래됨");
			const lint = readJson(out);
			if (!lint || !lint.summary || !sameCommit(lint.summary.commit, candidate)) problems.push(`화면 문구 검사가 후보 ${candidate} 를 검사한 출력이 아님(ui-copy-lint.mjs --ref ${candidate} --json 으로 다시 돌릴 것)`);
		}
	}
	let lintSummary = null;
	if (ui && ui.path) {
		const lint = readJson(resolveIn(path.dirname(file), ui.path));
		if (lint && lint.summary) lintSummary = lint.summary;
	}
	return { problems, reviewer: `${r.model || "?"} ${r.session || "?"}`, lintSummary };
}

function checkTestGate(file, candidate) {
	const problems = [];
	const g = readJson(file);
	if (!g) return [`시험 검수 기록을 읽지 못함: ${file}`];
	if (g.stage !== "test") problems.push("시험 검수 기록의 stage 가 test 가 아님");
	if (g.verdict !== "pass") problems.push("시험 검수 기록의 verdict 가 pass 가 아님");
	const a = g.author || {};
	const r = g.reviewer || {};
	if (!a.session || !r.session || a.session === r.session) problems.push("ET 를 돌린 세션과 시험 검수자 세션이 같거나 비어 있음");
	const targets = Array.isArray(g.targets) ? g.targets : [];
	if (!targets.some((t) => t && sameCommit(String(t.commit || ""), candidate))) problems.push(`시험 검수 기록의 targets 에 후보 ${candidate} 가 없음`);
	return problems;
}

function lastExecutedFor(service, auditPath) {
	let raw = "";
	try {
		raw = fs.readFileSync(auditPath, "utf8");
	} catch {
		return null;
	}
	let last = null;
	for (const line of raw.split("\n")) {
		if (!line.includes(service)) continue;
		try {
			const e = JSON.parse(line);
			if (e.event === "executed" && Array.isArray(e.services) && e.services.includes(service)) last = e;
		} catch {}
	}
	return last;
}

function executedBefore(candidate, auditPath) {
	let raw = "";
	try {
		raw = fs.readFileSync(auditPath, "utf8");
	} catch {
		return false;
	}
	for (const line of raw.split("\n")) {
		if (!line.includes(candidate)) continue;
		try {
			const e = JSON.parse(line);
			if (e.event === "executed" && String(e.command || "").includes(candidate)) return true;
		} catch {}
	}
	return false;
}

/** 기록을 실제로 실행하는 명령에 묶는다. */
function commandBinding(command, candidate, services, cwd) {
	const repos = [];
	for (const s of services) {
		if (s.startsWith("script:")) repos.push(path.dirname(s.slice("script:".length)));
		else if (s.startsWith("package:")) repos.push(s.slice("package:".length).split(":")[0]);
	}
	if (repos.length === 0) return { ok: false, why: "명령에 후보가 포함돼 있어도 계획·이미지·고정 본문의 강한 결합 없이는 허용하지 않음" };
	for (const dir0 of repos) {
		const dir = resolveIn(cwd, dir0 || ".");
		let head = "";
		let dirty = "";
		try {
			head = git(dir, ["rev-parse", "HEAD"]).trim();
			dirty = git(dir, ["status", "--porcelain", "--untracked-files=no"]).trim();
		} catch {
			return { ok: false, why: `배포 스크립트가 든 저장소를 읽지 못함: ${dir}` };
		}
		if (!sameCommit(head, candidate)) return { ok: false, why: `배포 스크립트 저장소 HEAD ${head.slice(0, 12)} 가 후보 ${candidate} 와 다름: ${dir}` };
		if (dirty) return { ok: false, why: `배포 스크립트 저장소에 커밋 안 된 변경이 있음(검수되지 않은 코드가 함께 올라감): ${dir}\n${dirty.split("\n").slice(0, 10).join("\n")}` };
	}
	const hexRuns = [...String(command).matchAll(/[0-9a-f]{7,40}/gi)].map((m) => m[0].toLowerCase());
	const marks = hexRuns.filter((h) => sameCommit(h, candidate.toLowerCase()) || (/[0-9]/.test(h) && /[a-f]/.test(h)));
	const foreign = marks.filter((h) => !sameCommit(h, candidate.toLowerCase()));
	if (foreign.length) return { ok: false, why: `명령에 후보 ${candidate} 와 다른 판 표시가 있음: ${[...new Set(foreign)].join(", ")}. 올릴 판이 후보와 같아야 함(옛 판이면 rollback 으로 신고)` };
	const skipBuild = /\b[A-Z0-9_]*(?:SKIP|NO)_?BUILD[A-Z0-9_]*=(?!0\b|false\b|no\b)\S|--(?:skip|no)-build\b/i.test(String(command));
	if (skipBuild && !marks.length) return { ok: false, why: `빌드를 건너뛰는 배포는 올라갈 이미지를 명령에서 확인할 수 있어야 함. 태그에 후보 커밋 ${candidate.slice(0, 8)} 를 넣거나 빌드를 건너뛰지 말 것` };
	return { ok: true, fact: "배포 스크립트 저장소 HEAD 가 후보와 같고 커밋 안 된 변경이 없음" };
}

// 계획 고정 대본 호출(`[sudo …]bash /<대본> …`). 대본 본문은 분류기가 다 읽을 수 없으므로 ops 로 받지 않는다(적대 리뷰 B1).

module.exports = { MAX_AGE_MS, TOOL_MAX_AGE_MS, KINDS, findReadiness, defectFile, defectFact, openCriticalDefects, defectVersions, git, checkCodeGate, checkTestGate, lastExecutedFor, executedBefore, commandBinding };
