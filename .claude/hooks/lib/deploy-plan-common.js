"use strict";
// Plan gate responsibility: common.
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../../..");

const PLAN_FILE = "deploy-plan.json";

const REVIEW_FILE = "deploy-plan-review.json";

const DISCORD_FILE = "deploy-approval-discord.json";

const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PLAN_APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;

const STEP_CODE_TTL_MS = 2 * 60 * 60 * 1000;

// 사전승인 단계 코드 유효 기간: 발급 시각부터 12시간(PLAN TTL과 동일). 일반 단계 코드는 2시간 유지.
const PREAPPROVE_STEP_TTL_MS = 12 * 60 * 60 * 1000;

const INCIDENT_VERDICT_TTL_MS = 30 * 60 * 1000;

function sha256(buf) {
	return crypto.createHash("sha256").update(buf).digest("hex");
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

const str = (v, min = 1) => typeof v === "string" && v.trim().length >= min;

const strList = (v, min = 1) => Array.isArray(v) && v.length > 0 && v.every((x) => str(x, min));

function isoMs(value) {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ? Date.parse(value) : NaN;
}

function readPlanSnapshot(file) {
	try {
		const bytes = fs.readFileSync(file);
		const plan = JSON.parse(bytes.toString("utf8"));
		return plan && typeof plan === "object" ? { plan, sha: sha256(bytes) } : null;
	} catch { return null; }
}

// Both reviewed images must remain available independently of the deployed file.
function readTargetFile(base, name) {
	const abs = path.resolve(base, name);
	if (fs.realpathSync(abs) !== abs) throw new Error(`target pin uses a symlink: ${name}`);
	const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd, { bigint: true });
		if (!stat.isFile()) throw new Error(`not a regular target file: ${name}`);
		const body = fs.readFileSync(fd);
		const end = fs.lstatSync(abs, { bigint: true });
		if (fs.realpathSync(abs) !== abs || stat.dev !== end.dev || stat.ino !== end.ino || stat.ctimeNs !== end.ctimeNs) throw new Error(`target file changed while reading: ${name}`);
		return { body, digest: sha256(body), identity: `${stat.dev}:${stat.ino}` };
	} finally { fs.closeSync(fd); }
}

/** gatesDir 안 일반 파일만 허용한다. 새 출력은 부모 realpath 부터 검사한다. */
function resultFile(gatesDir, result, allowMissing = false) {
	if (typeof result !== "string" || !result || path.isAbsolute(result)) throw new Error("결과는 gatesDir 기준 상대 경로여야 함");
	const gates = fs.realpathSync(gatesDir), file = path.resolve(gatesDir, result);
	const inside = (base, target) => { const rel = path.relative(base, target); return rel && !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel); };
	if (!inside(path.resolve(gatesDir), file)) throw new Error("결과 경로가 gatesDir 밖임");
	let parent;
	try { parent = fs.realpathSync(path.dirname(file)); }
	catch (e) { if (e.code === "ENOENT") throw new Error("결과 하위 폴더를 먼저 만드십시오"); throw e; }
	const real = path.join(parent, path.basename(file));
	if (!inside(gates, real)) throw new Error("결과 realpath 가 gatesDir 밖임");
	try {
		if (!fs.lstatSync(file).isFile() || !inside(gates, fs.realpathSync(file))) throw new Error("결과는 gatesDir 안 일반 파일이어야 함");
	} catch (e) { if (!allowMissing || e.code !== "ENOENT") throw e; }
	return real;
}

/** 가장 가까운 저장소 루트(.git 보유). 시작 경로는 심볼릭 링크를 먼저 푼다. 없으면 모듈 ROOT. */
function resolveRepoRoot(startDir) {
	let dir = path.resolve(startDir);
	for (;;) {
		try { dir = fs.realpathSync(dir); break; }
		catch { const parent = path.dirname(dir); if (parent === dir) return ROOT; dir = parent; }
	}
	try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { return ROOT; }
	for (;;) {
		try { if (fs.existsSync(path.join(dir, ".git"))) return fs.realpathSync(dir); } catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return ROOT;
		dir = parent;
	}
}

module.exports = {
	ROOT,
	PLAN_FILE,
	REVIEW_FILE,
	DISCORD_FILE,
	PLAN_MAX_AGE_MS,
	PLAN_APPROVAL_TTL_MS,
	STEP_CODE_TTL_MS,
	PREAPPROVE_STEP_TTL_MS,
	INCIDENT_VERDICT_TTL_MS,
	sha256,
	readJson,
	str,
	strList,
	isoMs,
	readPlanSnapshot,
	readTargetFile,
	resultFile,
	resolveRepoRoot,
};
