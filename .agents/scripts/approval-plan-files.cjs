"use strict";
// Approval CLI responsibility: files.
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const lib = require("../../.claude/hooks/lib/deploy-plan.js");

const ROOT = path.resolve(__dirname, "..", "..");
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const MUSE = process.env.APPROVAL_PLAN_MUSE_BIN || "muse";

function die(msg, code = 2) {
	console.error(msg);
	process.exit(code);
}

function opt(args, name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function optAll(args, name) {
	const out = [];
	for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
	return out;
}

function isInside(parentDir, targetPath) {
	const rel = path.relative(parentDir, targetPath);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function hasSymlinkSegment(baseDir, targetAbs) {
	const rel = path.relative(baseDir, targetAbs);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return true;
	let cur = baseDir;
	for (const seg of rel.split(path.sep)) {
		cur = path.join(cur, seg);
		if (fs.lstatSync(cur).isSymbolicLink()) return true;
	}
	return false;
}

function findGitRoot(startDir) {
	let dir = path.resolve(startDir);
	for (;;) {
		const dotGit = path.join(dir, ".git");
		let gitStat = null;
		try { gitStat = fs.lstatSync(dotGit); } catch (e) { if (e.code !== "ENOENT") return null; }
		if (gitStat) {
			if (gitStat.isSymbolicLink() || (!gitStat.isDirectory() && !gitStat.isFile())) return null;
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function resolvePlanRoot(abs) {
	let st;
	try { st = fs.lstatSync(abs); } catch (e) { die(`계획서를 읽지 못함: ${e.message}`); }
	if (st.isSymbolicLink() || !st.isFile()) die("계획서 경로는 심볼릭 링크가 아닌 일반 파일이어야 합니다");
	let realAbs;
	try { realAbs = fs.realpathSync(abs); } catch (e) { die(`계획서를 읽지 못함: ${e.message}`); }
	const realRoot = fs.realpathSync(ROOT);

	if (isInside(ROOT, abs)) {
		if (hasSymlinkSegment(ROOT, abs) || !isInside(realRoot, realAbs)) {
			die("계획서 경로에 심볼릭 링크는 허용하지 않습니다");
		}
		const relFromRoot = path.relative(ROOT, abs);
		if (relFromRoot.split(path.sep)[0] === ".git") die("계획서 경로가 .git 안에 있을 수 없습니다");
		return ROOT;
	}

	if (isInside(realRoot, realAbs) || realAbs !== abs) {
		die("계획서 경로에 심볼릭 링크는 허용하지 않습니다");
	}
	const gitRoot = findGitRoot(path.dirname(abs));
	if (!gitRoot) die("계획서가 git 저장소(.git) 안에 있지 않습니다");
	let realGitRoot;
	try { realGitRoot = fs.realpathSync(gitRoot); } catch (e) { die(`계획서 저장소 확인 실패: ${e.message}`); }
	if (realGitRoot !== gitRoot || !isInside(gitRoot, abs) || hasSymlinkSegment(gitRoot, abs)) {
		die("계획서 저장소 경로가 유효하지 않습니다");
	}
	const relFromGitRoot = path.relative(gitRoot, abs);
	if (relFromGitRoot.split(path.sep)[0] === ".git") die("계획서 경로가 .git 안에 있을 수 없습니다");
	if (lib.resolveRepoRoot(path.dirname(abs)) !== gitRoot) {
		die("계획서 저장소 루트가 일치하지 않습니다");
	}
	return gitRoot;
}

function loadPlan(p) {
	if (!p) die("계획서 경로가 필요합니다(.agents/progress/<작업>/gates/deploy-plan.json)");
	const abs = path.resolve(p);
	if (path.basename(abs) !== lib.PLAN_FILE || path.basename(path.dirname(abs)) !== "gates") die(`계획서는 .agents/progress/<작업>/gates/${lib.PLAN_FILE} 여야 합니다`);
	const root = resolvePlanRoot(abs);
	const snapshot = lib.readPlanSnapshot(abs);
	if (!snapshot) die("계획서를 읽지 못함");
	return { abs, gatesDir: path.dirname(abs), root, ...snapshot };
}

module.exports = {
	MUSE,
	die,
	opt,
	optAll,
	isInside,
	hasSymlinkSegment,
	findGitRoot,
	resolvePlanRoot,
	loadPlan,
	ROOT,
	sha256,
};
