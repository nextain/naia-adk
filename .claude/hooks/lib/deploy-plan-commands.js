"use strict";
// Plan gate responsibility: commands.
const path = require("path");
const fs = require("fs");
const { commandHash } = require("./deploy-human-approval.js");
const crypto = require("crypto");
const { PLAN_FILE, readPlanSnapshot, PLAN_MAX_AGE_MS, sha256 } = require("./deploy-plan-common.js");

/** Existing schema command locations, preserving namespace and array order. */
function planCommandEntries(plan) {
 const groups=[["scenario",plan?.scenario],["incident",plan?.incident?.actions]];
 return groups.flatMap(([kind,entries])=>(Array.isArray(entries)?entries:[]).map((entry,position)=>({kind,entry,position})));
}

/** 24시간 안에 만든 계획서들. */
function recentPlans(root, now = Date.now()) {
	const base = path.join(root, ".agents", "progress");
	let dirs = [];
	try {
		dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_"));
	} catch {
		return [];
	}
	const out = [];
	for (const d of dirs) {
		const file = path.join(base, d.name, "gates", PLAN_FILE);
		const snapshot = readPlanSnapshot(file);
		if (!snapshot) continue;
		const { plan, sha } = snapshot;
		const at = Date.parse(plan.createdAt || "");
		if (!Number.isFinite(at) || now - at > PLAN_MAX_AGE_MS || at - now > 5 * 60 * 1000) continue;
		const entries=planCommandEntries(plan);
		const steps=entries.filter(row=>row.kind==="scenario").map(row=>row.entry);
		const actions=entries.filter(row=>row.kind==="incident").map(row=>row.entry);
		out.push({ file, plan, sha, steps, actions });
	}
	return out;
}

/** 명령의 sha 가 든 계획서들. 24시간 안의 것만. */
function plansForCommand(command, root, now = Date.now()) {
	const h = commandHash(command);
	const has = (e) => e && Array.isArray(e.commands) && e.commands.some((c) => typeof c === "string" && commandHash(c) === h);
	const out = [];
	for (const { file, plan, sha, steps, actions } of recentPlans(root, now)) {
		const step = steps.find(has);
		const action = actions.find(has);
		if (step || action) out.push({ file, gatesDir: path.dirname(file), plan, step: step || null, action: action || null, sha });
	}
	return out;
}

function canonicalizeArgvToken(token, baseDir, isShellScriptArg, canonicalTargetPath) {
	if (!token || typeof token !== "string") return token;
	const isPathLike = (s, allowBareExisting = false) => {
		if (!s || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return false;
		if (s === "." || s === ".." || s.startsWith("/") || s.startsWith("./") || s.startsWith("../")) return true;
		if (s.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(s) || /^[^/]+@[^/]+:/.test(s)) return false;
		if (s.includes("/")) return true;
		if (allowBareExisting && baseDir) {
			try { return fs.existsSync(path.resolve(baseDir, s)); } catch { return false; }
		}
		return false;
	};
	if (token.startsWith("@")) {
		const rest = token.slice(1);
		if (isPathLike(rest, false)) return `@${canonicalTargetPath(rest, baseDir)}`;
		return token;
	}
	const eqMatch = /^(--?[A-Za-z0-9_-]+)=(@?)(.+)$/.exec(token);
	if (eqMatch) {
		const [, opt, at, rhs] = eqMatch;
		if (isPathLike(rhs, false)) return `${opt}=${at}${canonicalTargetPath(rhs, baseDir)}`;
		return token;
	}
	if (isPathLike(token, isShellScriptArg)) return canonicalTargetPath(token, baseDir);
	return token;
}

function collectStrippedRunEntries(command, cwd) {
	const { effectiveCommands, redirectSpan } = require("./effective-argv.js");
	const out = [];
	for (const e of effectiveCommands(command, cwd)) {
		if (e.opaque || !Array.isArray(e.argv)) continue;
		const argv = [];
		for (let i = 0; i < e.argv.length; i++) {
			const r = redirectSpan(e.argv, i);
			if (r) { i += r - 1; continue; }
			argv.push(e.argv[i]);
		}
		if (argv.length) out.push({ argv, dir: e.dir || cwd || "/" });
	}
	return out;
}

/** 실제로 도는 명령들의 argv(sudo·timeout·bash -c 등을 벗기고 리다이렉션 낱말을 뺀 것). 무엇이 도는지 모르는 절은 뺀다. */
function runArgvs(command, cwd) {
	return collectStrippedRunEntries(command, cwd).map((e) => e.argv);
}

/** 경로 낱말을 realpath·렉시컬 정규화한 runArgvs. 다른 cwd/상대경로/심볼릭링크/../cd X 변형도 같은 대본으로 묶는다. */
function normalizedRunArgvs(command, cwd) {
	const { shellInvocation } = require("./effective-argv.js");
	const { canonicalTargetPath } = require("./deploy-readiness.js");
	return collectStrippedRunEntries(command, cwd).map(({ argv, dir }) => {
		const scriptIdx = shellInvocation(argv).script;
		return argv.map((tok, idx) => canonicalizeArgvToken(tok, dir, idx === scriptIdx, canonicalTargetPath));
	});
}

/**
 * 계획서 단계·선조치 명령을 품었지만 글자가 다른 명령(뒤에 2>&1 | tail, 앞에 cd … &&·timeout, bash -c 로 감쌈)의 계획서들.
 * 이런 명령은 sha 가 달라 plansForCommand 에 안 걸리고, 분류기가 대본을 운영 변경으로 못 알아보면 승인도 실행 기록도 없이 돈다.
 * 승인된 명령으로 치지 않는다. 부르는 쪽은 막고 계획서 글자 그대로 실행하라고 알린다.
 */
function plansCarryingCommand(command, root, cwd, now = Date.now()) {
	const plans = recentPlans(root, now);
	if (!plans.length) return [];
	const h = commandHash(command);
	const ranRaw = runArgvs(command, cwd || root);
	const ranNorm = normalizedRunArgvs(command, cwd || root);
	if (!ranRaw.length && !ranNorm.length) return [];
	const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
	const sliceMatch = (ran, want) => {
		if (!want.length || !ran.length) return false;
		for (let i = 0; i + want.length <= ran.length; i++) if (want.every((w, j) => same(w, ran[i + j]))) return true;
		return false;
	};
	const carries = (c) => {
		if (typeof c !== "string" || commandHash(c) === h) return false;
		// 계획서 명령은 계획서 소속 저장소(root) 기준으로 해석해야 다른 cwd 에서도 상대/심볼릭 경로가 맞는다.
		if (sliceMatch(ranRaw, runArgvs(c, root))) return true;
		return sliceMatch(ranNorm, normalizedRunArgvs(c, root));
	};
	const out = [];
	for (const { file, plan, sha, steps, actions } of plans) {
		const has = (e) => e && Array.isArray(e.commands) && e.commands.some(carries);
		const step = steps.find(has);
		const action = actions.find(has);
		if (step || action) out.push({ file, gatesDir: path.dirname(file), plan, step: step || null, action: action || null, sha, carried: (step || action).commands.find(carries) });
	}
	return out;
}

function pinSha(abs) {
	if (fs.statSync(abs).size > 64 * 1024 * 1024) return `unpinnable-too-big-${crypto.randomBytes(8).toString("hex")}`;
	return sha256(fs.readFileSync(abs));
}

function rootOwnedBinary(abs) {
	let fd;
	try {
		const safeChain = (name) => {
			let p = path.resolve(name);
			for (;;) {
				const st = fs.lstatSync(p);
				if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) return false;
				if (p === "/") return true;
				p = path.dirname(p);
			}
		};
		if (!safeChain(abs)) return false;
		const real = fs.realpathSync(abs);
		if (!safeChain(real)) return false;
		fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const before = fs.fstatSync(fd);
		if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) || !(before.mode & 0o111)) return false;
		const magic = Buffer.alloc(20);
		if (fs.readSync(fd, magic, 0, 20, 0) !== 20) return false;
		if (!magic.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
			![1, 2].includes(magic[4]) || ![1, 2].includes(magic[5]) || magic[6] !== 1) return false;
		const elfType = magic[5] === 1 ? magic.readUInt16LE(16) : magic.readUInt16BE(16);
		if (elfType !== 2 && elfType !== 3) return false;
		const after = fs.statSync(real), end = fs.fstatSync(fd);
		return before.dev === after.dev && before.ino === after.ino && before.size === end.size &&
			before.mtimeMs === end.mtimeMs && before.ctimeMs === end.ctimeMs && safeChain(abs) &&
			fs.realpathSync(abs) === real && safeChain(real);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function readSmallText(f, dir) {
	try {
		const abs = path.isAbsolute(f) ? f : path.resolve(dir || "/", f);
		const st = fs.statSync(abs);
		if (!st.isFile() || st.size > 1024 * 1024) return "";
		return fs.readFileSync(abs, "utf8");
	} catch {
		return "";
	}
}

function scriptFileOf(e, command) {
	const { executedShellFile } = require("./deploy-command-classifier.js");
	const { SHELLS } = require("./effective-argv.js");
	const argv = e.argv || [];
	const direct = executedShellFile(argv, e.dir, e.dirKnown !== false, command);
	if (direct) return direct;
	if (!SHELLS.test(argv[0] || "")) return null;
	for (let i = 1; i < argv.length; i++) {
		const m = argv[i].match(/^0?<(.*)$/);
		if (!m) continue;
		const f = m[1] || argv[i + 1];
		if (!f) return null;
		const abs = path.isAbsolute(f) ? f : path.resolve(e.dir || "/", f);
		try {
			return fs.statSync(abs).isFile() ? abs : null;
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * 운영 명령이 읽거나 실행하는 파일과 그 sha256. 감싼 셸 스크립트는 안까지 3단계 본다.
 * 계획서 단계의 files 에 이 sha 가 있어야 통과한다.
 */
function referencedFiles(command, cwd) {
	const { effectiveCommands, resolvePathWord } = require("./effective-argv.js");
	const out = new Map();
	const seen = new Set();
	const visit = (text, dir, depth) => {
		let entries = [];
		try {
			entries = effectiveCommands(text, dir);
		} catch {
			return;
		}
		for (const e of entries) {
			for (const t of (e.argv || []).map(String)) {
				for (const cand of new Set([t, t.replace(/^[^=]*=/, ""), t.replace(/^[^=]*=/, "").replace(/^@/, ""), t.replace(/^@/, ""), t.replace(/^\d*</, ""), t.replace(/^file:\/\//, "")])) {
					if (!cand || cand.length > 1024) continue;
					let resolved = null;
					try {
						resolved = resolvePathWord(cand, e.dir || dir || cwd || "/", text, e.dirKnown !== false);
					} catch {}
					const abs = resolved || (path.isAbsolute(cand) ? cand : path.resolve(e.dir || dir || cwd || "/", cand));
					if (out.has(abs)) continue;
					try {
						if (!fs.statSync(abs).isFile()) continue;
						if (rootOwnedBinary(abs)) continue;
						out.set(abs, pinSha(abs));
					} catch {}
				}
			}
			const script = depth < 3 ? scriptFileOf(e, text) : null;
			if (script && !out.has(script)) {
				try {
					out.set(script, pinSha(script));
				} catch {}
			}
			if (script && !seen.has(script)) {
				seen.add(script);
				const body = readSmallText(script, "/");
				if (body) visit(body, e.dir || dir || cwd || "/", depth + 1);
			}
		}
	};
	visit(command, cwd, 0);
	return [...out].map(([p, sha]) => ({ path: p, sha }));
}

module.exports = {
	planCommandEntries,
	recentPlans,
	plansForCommand,
	canonicalizeArgvToken,
	collectStrippedRunEntries,
	runArgvs,
	normalizedRunArgvs,
	plansCarryingCommand,
	pinSha,
	rootOwnedBinary,
	readSmallText,
	scriptFileOf,
	referencedFiles,
};
