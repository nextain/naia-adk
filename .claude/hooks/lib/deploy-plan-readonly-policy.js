"use strict";
// Plan gate responsibility: readonly-policy.
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { sha256 } = require("./deploy-plan-common.js");

/** 저장소 상대 POSIX 경로를 정규화하고, 절대경로·상위 탈출(..)·와일드카드·널 바이트를 거절한다. */
function normalizeRepoRelPath(raw) {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed || /[\0'"*?\[\]{}]/.test(trimmed)) return null;
	if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/.test(trimmed)) return null;
	const norm = path.posix.normalize(trimmed.replace(/\\/g, "/"));
	if (!norm || norm === "." || norm === ".." || norm.startsWith("../") || norm.startsWith("/")) return null;
	return norm;
}

function hasGlobChars(s) {
	return /[*?\[\]{}]/.test(String(s || ""));
}

/** config/deploy-gate.json readOnlyScripts 배열을 검증하고 정규화한다(service 글롭·path 누락 금지). */
function validateReadOnlyScriptsConfig(cfg) {
	if (!cfg || cfg.readOnlyScripts === undefined) return { ok: true, items: [] };
	if (!Array.isArray(cfg.readOnlyScripts)) return { ok: false, why: "config/deploy-gate.json readOnlyScripts 는 배열이어야 함", items: [] };
	const items = [];
	for (let i = 0; i < cfg.readOnlyScripts.length; i++) {
		const item = cfg.readOnlyScripts[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, why: `config/deploy-gate.json readOnlyScripts[${i}] 는 객체여야 함`, items: [] };
		const shaRaw = typeof item.sha256 === "string" ? item.sha256.trim() : "";
		if (!/^[a-f0-9]{64}$/i.test(shaRaw)) return { ok: false, why: `config/deploy-gate.json readOnlyScripts[${i}].sha256 는 64자리 hex 여야 함`, items: [] };
		const relPath = normalizeRepoRelPath(item.path);
		if (!relPath) return { ok: false, why: `config/deploy-gate.json readOnlyScripts[${i}].path 는 와일드카드·상위 탈출 없는 저장소 상대 경로여야 함`, items: [] };
		const svc = typeof item.service === "string" ? item.service.trim() : "";
		if (!svc || /\s/.test(svc) || hasGlobChars(svc)) return { ok: false, why: `config/deploy-gate.json readOnlyScripts[${i}].service 에 와일드카드(*, ? 등)나 공백을 쓸 수 없으며 정확한 서비스 키여야 함: ${svc || "(비어 있음)"}`, items: [] };
		const note = typeof item.note === "string" ? item.note.trim() : "";
		items.push({ sha256: shaRaw.toLowerCase(), path: relPath, service: svc, ...(note ? { note } : {}) });
	}
	return { ok: true, items };
}

/**
 * 저장소 파일이 심볼릭 링크(상위 경로 포함) 없이 git 으로 추적되고 작업 트리·스테이지 내용이 HEAD 블롭과 바이트 일치하는지 검증한다.
 */
function fileGit(directory,args,options={}) {
 if(require("./deploy-plan-context.js").gateConfigView.getStore()?.executionRegistrationSha256)return require("../../../scripts/lib/registered-git-identity.cjs").registeredGit(directory,args,options);
 return execFileSync("git",["-C",directory,...args],options);
}

function verifyRepoFileGitClean(filePath, expectedRealTop = null, shownName = null) {
	const shown = shownName || (filePath ? path.basename(String(filePath)) : "파일");
	if (!filePath || typeof filePath !== "string") return { ok: false, why: `${shown} 경로가 없음` };
	const absFile = path.resolve(filePath);
	let st;
	try {
		st = fs.lstatSync(absFile);
	} catch {
		return { ok: false, why: `${shown} 파일이 없음` };
	}
	if (st.isSymbolicLink() || !st.isFile()) {
		return { ok: false, why: `${shown} 은 심볼릭 링크가 아닌 일반 파일이어야 함` };
	}
	let topRaw;
	try {
		topRaw = fileGit(path.dirname(absFile), ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch {
		return { ok: false, why: `${shown} 이 git 저장소 안에 없음` };
	}
	let realTop;
	try {
		realTop = fs.realpathSync(topRaw);
	} catch {
		return { ok: false, why: `${shown} git 저장소 루트 확인 실패` };
	}
	if (expectedRealTop && realTop !== expectedRealTop) {
		return { ok: false, why: `${shown} 이 설정 파일과 같은 git 저장소 안에 없음` };
	}
	let anc = path.dirname(absFile);
	const tail = [path.basename(absFile)];
	let matchedTop = false;
	for (;;) {
		try {
			if (fs.realpathSync(anc) === realTop) { matchedTop = true; break; }
		} catch {}
		tail.unshift(path.basename(anc));
		const parent = path.dirname(anc);
		if (parent === anc) break;
		anc = parent;
	}
	if (!matchedTop) return { ok: false, why: `${shown} 이 git 저장소 밖에 있음` };
	let checkCur = anc;
	for (const seg of tail) {
		checkCur = path.join(checkCur, seg);
		let lst;
		try { lst = fs.lstatSync(checkCur); } catch { return { ok: false, why: `${shown} 경로 확인 실패` }; }
		if (lst.isSymbolicLink()) return { ok: false, why: `${shown} 경로(또는 상위 경로)에 심볼릭 링크를 쓸 수 없음` };
	}
	let realFile;
	try { realFile = fs.realpathSync(absFile); } catch { return { ok: false, why: `${shown} realpath 확인 실패` }; }
	if (realFile !== path.join(realTop, ...tail)) {
		return { ok: false, why: `${shown} 실제 경로가 저장소 내 등록 경로와 다름` };
	}
	const rel = tail.join("/");
	try {
		fileGit(realTop, ["ls-files", "--error-unmatch", "--", rel], { stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		return { ok: false, why: `${rel} 이 git 으로 추적되지 않음` };
	}
	let statusOut = "";
	try {
		statusOut = fileGit(realTop, ["status", "--porcelain", "--untracked-files=all", "--", rel], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		return { ok: false, why: `${rel} git 상태 확인 실패` };
	}
	if (statusOut.trim() !== "") {
		return { ok: false, why: `${rel} 에 커밋되지 않은 변경(또는 미추적 상태)이 있음` };
	}
	let committedBuf;
	let diskBuf;
	try {
		committedBuf = fileGit(realTop, ["show", `HEAD:${rel}`], { encoding: null, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 5 * 1024 * 1024 });
		diskBuf = fs.readFileSync(absFile);
	} catch {
		return { ok: false, why: `${rel} 커밋 내용(HEAD) 대조 실패` };
	}
	const shaDisk = sha256(diskBuf);
	const shaHead = sha256(committedBuf);
	if (shaDisk !== shaHead) {
		return { ok: false, why: `${rel} 작업 트리 내용이 HEAD 커밋과 다름` };
	}
	return { ok: true, rel, realTop, realFile, sha256: shaDisk };
}

function canonicalReadOnlyBinding(items) {
	const seen = new Set();
	const out = [];
	for (const item of items || []) {
		const row = {
			sha256: String(item.sha256).trim().toLowerCase(),
			path: normalizeRepoRelPath(item.path),
			service: String(item.service).trim(),
			script_sha256: String(item.script_sha256 || item.sha256).trim().toLowerCase(),
		};
		const key = `${row.service}\0${row.path}\0${row.sha256}\0${row.script_sha256}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(row);
	}
	out.sort((a, b) => (a.service !== b.service ? (a.service < b.service ? -1 : 1) : a.path !== b.path ? (a.path < b.path ? -1 : 1) : (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0)));
	return out;
}

function validateReadOnlyBindingRecords(records) {
	if (!Array.isArray(records)) return { ok: false, why: "적대 리뷰 read_only_scripts 는 배열이어야 함", items: [] };
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, why: `적대 리뷰 read_only_scripts[${i}] 모양이 틀림`, items: [] };
		if (!/^[a-f0-9]{64}$/i.test(String(r.sha256 || "")) || !/^[a-f0-9]{64}$/i.test(String(r.script_sha256 || ""))) return { ok: false, why: `적대 리뷰 read_only_scripts[${i}] sha256 이 틀림`, items: [] };
		if (!normalizeRepoRelPath(r.path)) return { ok: false, why: `적대 리뷰 read_only_scripts[${i}] path 가 틀림`, items: [] };
		const svc = typeof r.service === "string" ? r.service.trim() : "";
		if (!svc || /\s/.test(svc) || hasGlobChars(svc)) return { ok: false, why: `적대 리뷰 read_only_scripts[${i}] service 가 틀림`, items: [] };
	}
	return { ok: true, items: canonicalReadOnlyBinding(records) };
}

/** 계획 단계 명령이 직접 호출하는 저장소 내 대본 경로를 뽑는다(리뷰 시 본문 고정을 강제하기 위함). */
function directCommandScriptPaths(command, base) {
	const out = [];
	let clauses;
	try { clauses = require("./git-command-parser.js").shellClauses(String(command || "")); }
	catch { return out; }
	if (!clauses || clauses.unbalanced) return out;
	const addIfRepoFile = (raw) => {
		if (!raw || typeof raw !== "string" || raw.startsWith("-") || raw.includes("$")) return;
		const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
		const rel = path.relative(base, abs);
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
		try { if (fs.statSync(abs).isFile()) out.push(abs); } catch {}
	};
	for (const c of clauses) {
		if (!Array.isArray(c) || c.length === 0) continue;
		let i = 0;
		if (path.basename(c[i] || "") === "sudo") {
			i++;
			while (i < c.length && c[i].startsWith("-")) i++;
		}
		const prog = path.basename(c[i] || "").replace(/\.(?:cmd|exe|bat)$/i, "").toLowerCase();
		if (prog === "bash" || prog === "sh") {
			let j = i + 1;
			let inlineC = false;
			while (j < c.length && c[j].startsWith("-")) {
				if (c[j] === "-c" || /^-[a-z]*c[a-z]*$/.test(c[j])) inlineC = true;
				j++;
			}
			if (!inlineC && j < c.length) addIfRepoFile(c[j]);
		} else if (prog === "az" && c[i + 1] === "vm" && c[i + 2] === "run-command" && c[i + 3] === "invoke") {
			for (let j = i + 4; j < c.length; j++) {
				const t = c[j];
				if ((t === "--scripts" || t === "--script") && j + 1 < c.length && c[j + 1].startsWith("@")) {
					addIfRepoFile(c[j + 1].slice(1));
				} else if ((t.startsWith("--scripts=@") || t.startsWith("--script=@"))) {
					addIfRepoFile(t.slice(t.indexOf("=@") + 2));
				}
			}
		}
	}
	return [...new Set(out)];
}

module.exports = {
	normalizeRepoRelPath,
	hasGlobChars,
	validateReadOnlyScriptsConfig,
	verifyRepoFileGitClean,
	canonicalReadOnlyBinding,
	validateReadOnlyBindingRecords,
	directCommandScriptPaths,
};
