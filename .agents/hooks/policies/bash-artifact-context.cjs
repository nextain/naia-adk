"use strict";
const path=require("node:path"),fs=require("node:fs"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const core=require("../core/harness-core.js");
const DEFAULT_ARTIFACT_EXTENSIONS = [
	".nva",
	".exe",
	".msi",
	".dmg",
	".AppImage",
	".apk",
	".vrm",
];

const DEFAULT_ARTIFACT_SCRIPT_DIRS = [
	"naia-labs/avatar",
	"naia-labs/**/service",
	"scripts/build*",
];

const ARTIFACT_DRIFT_MESSAGE =
	"커밋 안 된 대본으로 산출물을 만들 수 없습니다. 공통 코드에 고쳐 가지에 커밋하고 PR 로 올린 뒤 실행하세요.";

function normalizeExtensions(list) {
	if (!Array.isArray(list) || list.length === 0) return null;
	const out = list
		.filter((item) => typeof item === "string" && item.trim().length > 0)
		.map((item) => {
			const trimmed = item.trim();
			return (trimmed.startsWith(".") ? trimmed : `.${trimmed}`).toLowerCase();
		});
	return out.length > 0 ? out : null;
}

function normalizeDirPatterns(list) {
	if (!Array.isArray(list) || list.length === 0) return [];
	return list
		.filter((item) => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
		.filter(Boolean);
}

function readDriftConfigObjectFromDir(dir) {
	if (!dir) return null;
	const driftJsonPath = path.join(dir, ".agents", "context", "drift-guard.json");
	if (fs.existsSync(driftJsonPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(driftJsonPath, "utf8"));
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			/* ignore malformed json and fall through */
		}
	}
	for (const rulesFile of ["agents-rules.json", "agents-rules-detail.json"]) {
		const rulesPath = path.join(dir, ".agents", "context", rulesFile);
		if (!fs.existsSync(rulesPath)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
			const dg = parsed?.conventions?.drift_guard || parsed?.drift_guard;
			if (dg && typeof dg === "object") return dg;
			if (parsed?.artifact_extensions || parsed?.artifact_script_dirs) return parsed;
		} catch {
			/* ignore */
		}
	}
	return null;
}

function readDriftConfigFromRoot(dir) {
	const cfg = readDriftConfigObjectFromDir(dir);
	if (!cfg) return null;
	return normalizeExtensions(cfg.artifact_extensions);
}

function loadArtifactExtensions(cwd, opts) {
	if (opts && Array.isArray(opts.artifactExtensions)) {
		const custom = normalizeExtensions(opts.artifactExtensions);
		if (custom) return custom;
	}
	let cur = path.resolve(cwd || process.cwd());
	while (cur) {
		const found = readDriftConfigFromRoot(cur);
		if (found) return found;
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	const wsRoot = path.resolve(__dirname, "..", "..", "..");
	const wsFound = readDriftConfigFromRoot(wsRoot);
	if (wsFound) return wsFound;
	return DEFAULT_ARTIFACT_EXTENSIONS.map((e) => e.toLowerCase());
}

function loadArtifactScriptDirs(cwd, opts, extraRoots = []) {
	const merged = new Set(normalizeDirPatterns(DEFAULT_ARTIFACT_SCRIPT_DIRS));
	if (opts && Array.isArray(opts.artifactScriptDirs)) {
		for (const p of normalizeDirPatterns(opts.artifactScriptDirs)) merged.add(p);
	}
	const searchDirs = [];
	const pushHierarchy = (startDir) => {
		if (!startDir) return;
		let cur = path.resolve(startDir);
		while (cur) {
			if (!searchDirs.includes(cur)) searchDirs.push(cur);
			const parent = path.dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	};
	pushHierarchy(cwd || process.cwd());
	for (const r of extraRoots) pushHierarchy(r);
	const wsRoot = path.resolve(__dirname, "..", "..", "..");
	if (!searchDirs.includes(wsRoot)) searchDirs.push(wsRoot);

	for (const d of searchDirs) {
		const cfg = readDriftConfigObjectFromDir(d);
		if (!cfg) continue;
		const patterns = normalizeDirPatterns(cfg.artifact_script_dirs || cfg.artifact_producer_dirs);
		for (const p of patterns) merged.add(p);
	}
	return [...merged];
}

function matchesArtifactScriptPattern(relPath, pattern) {
	if (!relPath || !pattern) return false;
	const normPath = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
	const normPat = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
	if (!normPath || !normPat) return false;
	if (normPath.startsWith("..")) return false;

	// Convert glob pattern into regex:
	// /**/ matches "/" or "/any/nested/"
	const DOUBLE_STAR_SLASH = "\x00DOUBLE_STAR_SLASH\x00";
	const DOUBLE_STAR = "\x00DOUBLE_STAR\x00";
	const SINGLE_STAR = "\x00SINGLE_STAR\x00";
	const QUESTION = "\x00QUESTION\x00";

	const regexBody = normPat
		.replace(/\/\*\*\//g, DOUBLE_STAR_SLASH)
		.replace(/\*\*/g, DOUBLE_STAR)
		.replace(/\*/g, SINGLE_STAR)
		.replace(/\?/g, QUESTION)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll(DOUBLE_STAR_SLASH, "(?:/|/.+/)")
		.replaceAll(DOUBLE_STAR, ".*")
		.replaceAll(SINGLE_STAR, "[^/]*")
		.replaceAll(QUESTION, "[^/]");

	const re = new RegExp(`(?:^|/)${regexBody}(?:/.*|$)`, "i");
	return re.test(normPath);
}

function isArtifactProducerScript(scriptArg, effectiveCwd, checkResult, dirPatterns) {
	if (!Array.isArray(dirPatterns) || dirPatterns.length === 0) return false;
	const candidates = [];
	if (checkResult && checkResult.relPosix) {
		candidates.push(checkResult.relPosix);
	}
	if (checkResult && checkResult.absScript && effectiveCwd) {
		const relToCwd = path.relative(effectiveCwd, checkResult.absScript).replace(/\\/g, "/");
		if (relToCwd && !relToCwd.startsWith("..") && !path.isAbsolute(relToCwd)) {
			candidates.push(relToCwd);
		}
	}
	if (scriptArg && typeof scriptArg === "string") {
		const normArg = scriptArg.replace(/\\/g, "/").replace(/^\.\//, "");
		if (normArg && !normArg.startsWith("/") && !normArg.startsWith("..")) {
			candidates.push(normArg);
		}
	}
	for (const candidate of candidates) {
		for (const pattern of dirPatterns) {
			if (matchesArtifactScriptPattern(candidate, pattern)) {
				return true;
			}
		}
	}
	return false;
}

function splitShellSegments(command) {
	const segments = [];
	let current = "";
	let quote = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			current += ch;
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				current += command[++i];
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[++i];
			continue;
		}
		if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
			segments.push({ text: current, sep: ch + ch });
			current = "";
			i++;
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "|") {
			segments.push({ text: current, sep: ch });
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim().length > 0) segments.push({ text: current, sep: "" });
	return segments;
}

function tokenizeSegment(segmentText) {
	const tokens = [];
	let cur = "";
	let quote = null;
	for (let i = 0; i < segmentText.length; i++) {
		const ch = segmentText[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < segmentText.length) {
				cur += segmentText[++i];
			} else if (ch === quote) {
				quote = null;
			} else {
				cur += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < segmentText.length) {
			cur += segmentText[++i];
			continue;
		}
		if (/\s/.test(ch)) {
			if (cur.length > 0) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur.length > 0) tokens.push(cur);
	return tokens;
}

function unwrapGroupingTokens(rawTokens) {
	const tokens = [...rawTokens];
	let openParens = 0;
	let closeParens = 0;

	while (tokens.length > 0) {
		const first = tokens[0];
		if (first === "(" || first === "{") {
			if (first === "(") openParens++;
			tokens.shift();
			continue;
		}
		if (first === ")" || first === "}" || first === ";") {
			if (first === ")") closeParens++;
			tokens.shift();
			continue;
		}
		if (first.startsWith("(")) {
			const m = first.match(/^\(+/);
			if (m) openParens += m[0].length;
			tokens[0] = first.replace(/^\(+/, "");
			if (!tokens[0]) tokens.shift();
			continue;
		}
		if (first.startsWith("{") && first !== "{}" && !first.startsWith("${")) {
			tokens[0] = first.replace(/^\{+/, "");
			if (!tokens[0]) tokens.shift();
			continue;
		}
		break;
	}

	while (tokens.length > 0) {
		const last = tokens[tokens.length - 1];
		if (last === ")" || last === "}" || last === ";") {
			if (last === ")") closeParens++;
			tokens.pop();
			continue;
		}
		if (
			/[;)\}]+$/.test(last) &&
			last !== "{}" &&
			!last.endsWith("{}") &&
			!/\$\{[^}]*\}$/.test(last) &&
			!/\(\d+\)$/.test(last)
		) {
			const parenMatches = last.match(/\)+$/);
			if (parenMatches) closeParens += parenMatches[0].length;
			tokens[tokens.length - 1] = last.replace(/[;)\}]+$/, "");
			if (!tokens[tokens.length - 1]) tokens.pop();
			continue;
		}
		break;
	}

	return { tokens, openParens, closeParens };
}

function expandShellVars(token, varMap) {
	if (!token || typeof token !== "string" || !token.includes("$") || !varMap || varMap.size === 0) {
		return token;
	}
	return token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, g1, g2) => {
		const key = g1 || g2;
		return varMap.has(key) ? varMap.get(key) : m;
	});
}

function expandHomePath(p) {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home) return p;
	if (p === "~") return home;
	if (p.startsWith("~/")) return path.join(home, p.slice(2));
	if (p.startsWith("$HOME/")) return path.join(home, p.slice(6));
	if (p.startsWith("${HOME}/")) return path.join(home, p.slice(8));
	return p;
}

function matchArtifactToken(token, artifactExts) {
	if (!token || typeof token !== "string") return null;
	const candidates = [token];
	const eqIdx = token.indexOf("=");
	if (eqIdx >= 0) candidates.push(token.slice(eqIdx + 1));
	const redirMatch = token.match(/^(?:\d*>>?|\&>>?)(.+)$/);
	if (redirMatch) candidates.push(redirMatch[1]);
	for (const part of token.split(/[\s'"()`,;:=<>[\]{}|&]+/)) {
		if (part) candidates.push(part);
	}

	for (const raw of candidates) {
		const cleaned = raw.replace(/^['"]+|['",;)]+$/g, "").trim();
		if (!cleaned) continue;
		const lower = cleaned.toLowerCase();
		for (const ext of artifactExts) {
			if (lower.length > ext.length && lower.endsWith(ext)) {
				return cleaned;
			}
		}
	}
	return null;
}


module.exports={DEFAULT_ARTIFACT_EXTENSIONS,DEFAULT_ARTIFACT_SCRIPT_DIRS,ARTIFACT_DRIFT_MESSAGE,loadArtifactExtensions,loadArtifactScriptDirs,isArtifactProducerScript,splitShellSegments,tokenizeSegment,unwrapGroupingTokens,expandShellVars,expandHomePath,matchArtifactToken};
