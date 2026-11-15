#!/usr/bin/env node
/**
 * 3층 쓰기 막기 (PreToolUse: Bash·Edit·Write·NotebookEdit·MultiEdit·apply_patch)
 *
 * 3층(역할 세션)은 감시·평가·사용자 소통을 한다. 저장소 코드의 설계·구현·검증은 2층 일꾼에게 지시서로 맡긴다.
 * 3층 판정과 허용·예외 규칙은 lib/lead-guard.js, 설계는 docs/guides/lead-write-guard.md.
 * 역할 세션은 ADK 저장소 밖에서 돌므로 프로젝트 훅이 안 뜬다. 사용자 프로필(templates/claude-user-profile)이 절대 경로로 등록한다.
 * 기본 허용이다: 3층이 아니거나(표지 없음·일꾼·서브에이전트) 훅이 예외로 끝나면 통과한다. 막힘은 감사 기록에 남는다.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { isFileMutationTool, isShellTool } = require("./tool-names.js");
const { effectiveCommands, writtenPaths, interpreterProgram, gitClauseDirectory, resolvePathWord, SHELLS, SHELL_ALT } = require("./lib/effective-argv.js");
const SHEBANG_SHELL_RE = new RegExp(`^#!\\s*/.*\\b(?:${SHELL_ALT})\\b`);
const guard = require("./lib/lead-guard.js");

const GIT_WRITES = new Set(["apply", "am", "rm", "mv", "restore", "clean", "checkout", "merge", "pull", "cherry-pick", "rebase", "revert", "switch"]);
const PKG_WRITES = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "link", "unlink", "dedupe", "prune"]);

function block(reason, event) {
	guard.audit({ event: "block", ...event });
	process.stdout.write(JSON.stringify({ decision: "block", reason }));
	process.exit(0);
}

function guideMessage(target, rule, lead) {
	const { workDir, workerGuide, approverLabel } = guard.guardMeta(lead);
	if (rule === "self:role-file" || rule === "self:protected-path") {
		return `[3층 쓰기 막기] ${target} 는 역할 표지·훅 설정·예외 기록이라 3층이 바꿀 수 없습니다. ${approverLabel} 쪽에서 직접 바꾸어야 합니다.`;
	}
	const extra = workerGuide ? ` (다른 도구 예시는 ${workerGuide})` : "";
	return `[3층 쓰기 막기] 3층은 저장소 코드를 직접 쓰지 않습니다(${target}). 2층 일꾼에게 지시서로 맡기십시오.\n`
		+ `1) ${workDir}/<일>/prompt.md 에 지시서를 씁니다(허용). 2) 한 줄로 띄웁니다: `
		+ `\`claude -p --model sonnet "$(cat ${workDir}/<일>/prompt.md)" > ${workDir}/<일>/out.log 2>&1 &\`${extra}. `
		+ "3) 결과 파일을 읽고 평가합니다.\n"
		+ `허용 경로: 저장소 밖 파일, docs/common/<역할>/, docs/common/team/now/<역할>.md, .agents/progress/, .agents/work/. 긴급 예외는 ${approverLabel} 허락이 있어야 하고 3층이 열 수 없습니다.`;
}

function patchPaths(text) {
	const out = [];
	for (const line of String(text || "").split(/\r?\n/)) {
		const m = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) || line.match(/^\*\*\* Move to: (.+)$/);
		if (m) out.push(m[1].trim());
	}
	return out;
}

function splitTopLevel(str, sep) {
	const parts = [];
	let cur = "", q = null, depth = 0;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (q) {
			cur += c;
			if (c === "\\" && q !== "'" && i + 1 < str.length) { cur += str[++i]; continue; }
			if (c === q) q = null;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") { q = c; cur += c; continue; }
		if (c === "(" || c === "[" || c === "{") { depth++; cur += c; continue; }
		if (c === ")" || c === "]" || c === "}") { depth = Math.max(0, depth - 1); cur += c; continue; }
		if (depth === 0 && c === sep) { parts.push(cur.trim()); cur = ""; continue; }
		cur += c;
	}
	if (cur.trim()) parts.push(cur.trim());
	return parts;
}

function unquoteStr(tok) {
	if (tok.length < 2) return null;
	const q = tok[0];
	if ((q !== "'" && q !== '"' && q !== "`") || tok[tok.length - 1] !== q) return null;
	if (q === "`" && /\$\{/.test(tok)) return null;
	let out = "";
	for (let i = 1; i < tok.length - 1; i++) {
		const c = tok[i];
		if (c === "\\" && i + 1 < tok.length - 1) {
			const n = tok[++i];
			if (n === "n") out += "\n";
			else if (n === "t") out += "\t";
			else out += n;
			continue;
		}
		if (c === q) return null;
		out += c;
	}
	return out;
}

function evalScriptExpr(rawExpr, vars, depth = 0) {
	if (depth > 8 || !rawExpr) return null;
	let expr = rawExpr.trim();
	while (expr.startsWith("(") && expr.endsWith(")")) {
		const inner = splitTopLevel(expr.slice(1, -1), ",");
		if (inner.length !== 1) break;
		expr = expr.slice(1, -1).trim();
	}
	const slashParts = splitTopLevel(expr, "/");
	if (slashParts.length > 1) {
		const args = slashParts.map((a) => evalScriptExpr(a, vars, depth + 1));
		if (args.every((a) => a !== null)) return path.join(...args);
	}
	const plusParts = splitTopLevel(expr, "+");
	if (plusParts.length > 1) {
		let acc = "";
		for (const p of plusParts) {
			const v = evalScriptExpr(p, vars, depth + 1);
			if (v === null) return null;
			acc += v;
		}
		return acc;
	}
	const lit = unquoteStr(expr);
	if (lit !== null) return lit;
	if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr) && vars.has(expr)) return vars.get(expr);
	const joinM = expr.match(/^(?:os\.)?path\.join\s*\(([\s\S]+)\)$/) || expr.match(/^Path\s*\(([\s\S]+)\)$/);
	if (joinM) {
		const args = splitTopLevel(joinM[1], ",").map((a) => evalScriptExpr(a, vars, depth + 1));
		if (args.length && args.every((a) => a !== null)) return path.join(...args);
	}
	return null;
}

/** 파이썬·노드·루비·펄 코드가 쓰는 파일(상수 변수·'+' 결합·삭제/이름변경 포함). */
function scriptWrites(text) {
	const src = String(text || "");
	const out = [];
	const vars = new Map();
	// 줄 단위/문장 단위로 앞에서 뒤로 훑어 변수 대입과 호출 시점의 값을 맞춘다.
	const stmts = src.split(/(?:\r?\n|;)+/);
	for (const rawLine of stmts) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("//")) continue;
		const assignM = line.match(/^(?:(?:const|let|var|export)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(\+=|=)\s*([\s\S]+)$/);
		if (assignM && !/^=/.test(assignM[3])) {
			const val = evalScriptExpr(assignM[3].replace(/\s+(?:#|\/\/).*$/, ""), vars);
			if (assignM[2] === "+=" && val !== null && vars.has(assignM[1])) { vars.set(assignM[1], vars.get(assignM[1]) + val); continue; }
			if (val !== null) { vars.set(assignM[1], val); continue; }
			vars.delete(assignM[1]);
		}
		const calls = [];
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (c === "'" || c === '"' || c === "`") {
				const q = c; i++;
				while (i < line.length && line[i] !== q) { if (line[i] === "\\" && q !== "'") i++; i++; }
				continue;
			}
			const sub = line.slice(i);
			const hm = sub.match(/^((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)\s*\(/);
			if (!hm) continue;
			const open = i + hm[0].length - 1;
			let depth = 1, j = open + 1, iq = null;
			for (; j < line.length && depth > 0; j++) {
				const ch = line[j];
				if (iq) { if (ch === "\\" && iq !== "'") j++; else if (ch === iq) iq = null; continue; }
				if (ch === "'" || ch === '"' || ch === "`") { iq = ch; continue; }
				if (ch === "(") depth++;
				else if (ch === ")") depth--;
			}
			if (depth === 0) calls.push({ fn: hm[1], argsStr: line.slice(open + 1, j - 1), end: j });
		}
		for (const call of calls) {
			const args = splitTopLevel(call.argsStr, ",");
			const tailFn = call.fn.split(".").pop();
			const ev = (idx) => args[idx] ? evalScriptExpr(args[idx], vars) : null;
			const evMode = (idx) => {
				if (!args[idx]) return "";
				const m = args[idx].replace(/^(?:mode|flags)\s*=\s*/, "");
				return unquoteStr(m.trim()) || "";
			};
			if (call.fn === "open") {
				const mode = args.slice(1).map((a) => unquoteStr(a.replace(/^mode\s*=\s*/, "").trim()) || "").find(Boolean) || "";
				if (/[wax+]/.test(mode)) { const p = ev(0); if (p) out.push(p); }
				else if (args[1]) {
					const pm = unquoteStr(args[1].trim());
					if (pm && /^(?:>|>>|\+>)/.test(pm)) out.push(pm.replace(/^(?:>|>>|\+>)\s*/, "").trim());
				}
			} else if (call.fn === "Path") {
				const p = ev(0);
				const rest = line.slice(call.end);
				const pm = rest.match(/^\s*\.\s*(write_text|write_bytes|unlink|rmdir|touch|open|rename|replace)\s*\(([^)]*)\)/);
				if (pm && p) {
					if (pm[1] === "open") {
						if (/[wax+]/.test(pm[2])) out.push(p);
					} else if (pm[1] === "rename" || pm[1] === "replace") {
						out.push(p);
						const dst = evalScriptExpr(splitTopLevel(pm[2], ",")[0] || "", vars);
						if (dst) out.push(dst);
					} else out.push(p);
				}
			} else if (/^([A-Za-z_][A-Za-z0-9_]*)\.(write_text|write_bytes|unlink|rmdir|touch|open|rename|replace)$/.test(call.fn) && vars.has(call.fn.split(".")[0])) {
				const [obj, meth] = call.fn.split(".");
				const p = vars.get(obj);
				if (meth === "open") { if (/[wax+]/.test(evMode(0))) out.push(p); }
				else if (meth === "rename" || meth === "replace") { out.push(p); const dst = ev(0); if (dst) out.push(dst); }
				else out.push(p);
			} else if (/^(?:os\.)?(?:remove|unlink|rmdir|mkdir|makedirs|truncate|chmod|chown|chgrp|lchown)$/.test(call.fn) || call.fn === "shutil.rmtree" || /^(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|rmSync|rm|rmdirSync|rmdir|unlinkSync|unlink|mkdirSync|mkdir|truncateSync|truncate|chmodSync|chmod|chownSync|chown)$/.test(tailFn)) {
				if (call.fn === "open" || call.fn === "Path") continue;
				if (/^(?:rm|unlink|rmdir|mkdir|truncate|chmod|chown|open)$/.test(tailFn) && call.fn.includes(".") && !/^(?:os|fs|promises|File)\./.test(call.fn) && !call.fn.endsWith(`.promises.${tailFn}`)) {
					// Keep Path.unlink etc. handled by Path; skip unknown obj.rm unless fs/os/promises
					if (!/\.promises\./.test(call.fn)) continue;
				}
				if (/^(?:unlink|chmod|chown)$/.test(tailFn) && !call.fn.includes(".") && args[0] && /^(?:0|['"]?[0-7])/.test(args[0].trim())) {
					// Perl chmod(0755, file) puts mode first
					for (let k = 1; k < args.length; k++) { const p = ev(k); if (p) out.push(p); }
					continue;
				}
				const p = ev(0); if (p) out.push(p);
			} else if (/^(?:os\.(?:rename|replace|link|symlink)|shutil\.move)$/.test(call.fn) || /^(?:renameSync|rename|linkSync|link|symlinkSync|symlink)$/.test(tailFn)) {
				const a0 = ev(0), a1 = ev(1);
				if (a0) out.push(a0);
				if (a1) out.push(a1);
			} else if (/^shutil\.(?:copy|copy2|copyfile|copytree)$/.test(call.fn) || /^(?:copyFileSync|copyFile|cpSync|cp)$/.test(tailFn)) {
				const a1 = ev(1);
				if (a1) out.push(a1);
			} else if (call.fn === "File.write" || call.fn === "File.binwrite" || call.fn === "File.delete" || call.fn === "File.unlink") {
				for (let k = 0; k < args.length; k++) {
					if ((call.fn === "File.write" || call.fn === "File.binwrite") && k > 0) break;
					const p = ev(k); if (p) out.push(p);
				}
			} else if (call.fn === "File.rename") {
				const a0 = ev(0), a1 = ev(1); if (a0) out.push(a0); if (a1) out.push(a1);
			}
			void evMode;
		}
		for (const m of line.matchAll(/\bopen\s*(?:\([^)]*\)|\w+)\s*,\s*(["'])(?:>|>>|\+>)\s*(.*?)\1/g)) {
			if (m[2].trim()) out.push(m[2].trim());
		}
	}
	return out;
}

const nonFlags = (argv, from = 1, valueOpts = null) => {
	const o = []; let end = false;
	for (let i = from; i < argv.length; i++) {
		const a = argv[i];
		if (!end && a === "--") { end = true; continue; }
		if (!end && valueOpts && valueOpts.has(a)) { i++; continue; }
		if (end || !a.startsWith("-")) o.push(a);
	}
	return o;
};

const MUTATOR_HEADS = new Set(["rm", "truncate", "shred", "unlink", "mv", "cp", "tee", "touch", "mkdir", "chmod", "chown", "chgrp", "patch", "dd"]);

function isMutatingArgv(argv) {
	const head = path.basename(argv[0] || "");
	if (MUTATOR_HEADS.has(head)) return true;
	if ((head === "sed" || head === "perl" || head === "ruby") && argv.slice(1).some((a) => /^(--in-place(=.*)?|-[A-Za-z]*i.*)$/.test(a))) return true;
	if ((head === "awk" || head === "gawk") && argv.slice(1).some((a) => /^inplace$/.test(a))) return true;
	return false;
}

function localShellScript(argv, dir, resolveFn) {
	const head = path.basename(argv[0] || "");
	let candidate = null;
	if (SHELLS.test(head) || head === "." || head === "source") {
		if (argv.slice(1).some((a) => a === "-c" || a === "-s")) return null;
		const pos = nonFlags(argv, 1, new Set(["-o", "+o"]));
		if (pos.length) candidate = resolveFn(pos[0]);
	} else if ((argv[0] || "").includes("/") && !/^\/(?:bin|usr\/bin|sbin|usr\/sbin)\//.test(argv[0])) {
		candidate = resolveFn(argv[0]);
	}
	if (!candidate) return null;
	try {
		const st = fs.statSync(candidate);
		if (!st.isFile() || st.size > 1 << 20) return null;
		const buf = fs.readFileSync(candidate);
		if (buf.subarray(0, 512).includes(0)) return null;
		const text = buf.toString("utf8");
		if (SHELLS.test(head) || head === "." || head === "source" || /\.(?:ba)?sh$/.test(candidate) || SHEBANG_SHELL_RE.test(text)) return { file: candidate, text };
	} catch {}
	return null;
}

function upstreamPathsFrom(allClauses, idx, command) {
	if (!allClauses || idx <= 0) return { known: false, paths: [] };
	const prev = allClauses[idx - 1];
	const pargv = prev && prev.argv ? prev.argv : [];
	const phead = path.basename(pargv[0] || "");
	const pdir = prev ? prev.dir : process.cwd();
	const absPrev = (w) => resolvePathWord(w, pdir, command, prev.dirKnown) || (path.isAbsolute(w) ? w : prev.dirKnown === false ? null : path.resolve(pdir, w));
	if (phead === "find") {
		const roots = [];
		for (let i = 1; i < pargv.length; i++) {
			const a = pargv[i];
			if (a.startsWith("-") || a === "!" || a === "(") break;
			const r = absPrev(a); if (r) roots.push(r);
		}
		return { known: true, paths: roots.length ? roots : [pdir] };
	}
	if (phead === "echo" || phead === "printf" || phead === "ls") {
		const skip = phead === "ls" ? new Set(["-w", "--width", "-T", "--tabsize", "-I", "--ignore", "--hide", "--color", "--time-style"]) : null;
		const args = nonFlags(pargv, phead === "printf" ? 2 : 1, skip);
		const paths = args.map(absPrev).filter(Boolean);
		if (paths.length) return { known: true, paths };
	}
	return { known: false, paths: [] };
}

function clauseTargets(clause, command, depth = 0, seenScripts = new Set(), allClauses = null, clauseIdx = 0) {
	const argv = clause.argv || [];
	const head = path.basename(argv[0] || "");
	const dir = clause.dir;
	const isPipedXargs = Boolean(clause.piped || (Array.isArray(clause.clause) && path.basename(clause.clause[0] || "") === "xargs"));
	const abs = (w) => resolvePathWord(w, dir, command, clause.dirKnown) || (path.isAbsolute(w) ? w : clause.dirKnown === false ? null : path.resolve(dir, w));
	const t = [];
	const add = (w, wholeWorktreeRemove = false) => {
		if (!w || (isPipedXargs && /\{\}/.test(w))) return;
		const a = abs(w); if (a) t.push({ path: a, wholeWorktreeRemove });
	};
	const heredocs = clause.heredocs || (clause.clause && clause.clause.heredocs);
	for (const [p] of writtenPaths(argv, dir, command, clause.dirKnown, heredocs)) t.push({ path: p, wholeWorktreeRemove: false });
	if (head === "rm") {
		const dd = argv.indexOf("--");
		const flags = (dd >= 0 ? argv.slice(1, dd) : argv.slice(1)).filter((a) => a.startsWith("-"));
		const rec = flags.some((f) => f === "--recursive" || (/^-[A-Za-z]+$/.test(f) && (f.includes("r") || f.includes("R"))));
		nonFlags(argv).forEach((w) => add(w, rec));
	}
	if (head === "shred" || head === "unlink") nonFlags(argv).forEach((w) => add(w));
	if (head === "truncate") nonFlags(argv, 1, new Set(["-s", "--size", "-r", "--reference", "-o", "--io-blocks"])).forEach((w) => add(w));
	if (head === "touch") nonFlags(argv, 1, new Set(["-r", "--reference", "-d", "--date", "-t", "--time"])).forEach((w) => add(w));
	if (head === "mkdir") nonFlags(argv, 1, new Set(["-m", "--mode", "-Z", "--context"])).forEach((w) => add(w));
	if (head === "chmod" || head === "chown" || head === "chgrp") {
		let ref = false, end = false, skipMode = false;
		const modeFlags = new Set(["-R", "--recursive", "-v", "--verbose", "-f", "--silent", "--quiet", "-c", "--changes", "--no-dereference", "-h", "-H", "-L", "-P", "--preserve-root", "--no-preserve-root"]);
		for (let i = 1; i < argv.length; i++) {
			const a = argv[i];
			if (!end && a === "--") { end = true; continue; }
			if (!end && (a === "--reference" || a === "--from")) { ref = true; i++; continue; }
			if (!end && (a.startsWith("--reference=") || a.startsWith("--from="))) { ref = true; continue; }
			if (!end && modeFlags.has(a)) continue;
			if (!end && head === "chmod" && /^-[rwxXstugo]+$/.test(a)) { skipMode = true; continue; }
			if (!end && a.startsWith("-") && !skipMode) continue;
			if (!ref && !skipMode) { skipMode = true; continue; }
			add(a);
		}
	}
	if (head === "curl") {
		let outDir = dir, remoteName = false, explicit = false, url = null;
		for (let i = 1; i < argv.length; i++) {
			const a = argv[i];
			if ((a === "-o" || a === "--output" || /^-[A-Za-z]*o$/.test(a)) && argv[i + 1]) { add(argv[++i]); explicit = true; continue; }
			if (a.startsWith("--output=")) { add(a.slice("--output=".length)); explicit = true; continue; }
			const om = a.match(/^-[A-Za-z]*o(.+)$/);
			if (om) { add(om[1]); explicit = true; continue; }
			if ((a === "--output-dir") && argv[i + 1]) { outDir = abs(argv[++i]) || outDir; continue; }
			if (a.startsWith("--output-dir=")) { outDir = abs(a.slice("--output-dir=".length)) || outDir; continue; }
			if (a === "-O" || a === "--remote-name" || a === "--remote-name-all" || /^-[A-Za-z]*O[A-Za-z]*$/.test(a)) { remoteName = true; continue; }
			if (!a.startsWith("-") && /^https?:\/\//i.test(a)) url = a;
		}
		if (remoteName && !explicit) {
			const base = url ? path.posix.basename(url.split("?")[0]) : "";
			t.push({ path: base ? path.resolve(outDir, base) : outDir, wholeWorktreeRemove: false });
		}
	}
	if (head === "wget") {
		let outDir = dir, explicit = false, spider = false, url = null;
		for (let i = 1; i < argv.length; i++) {
			const a = argv[i];
			if (a === "--spider") { spider = true; continue; }
			if (/^-[A-Za-z]*O-$/.test(a)) { explicit = true; continue; }
			if ((a === "-O" || a === "--output-document") && argv[i + 1]) {
				const dest = argv[++i]; explicit = true;
				if (dest !== "-") add(dest);
				continue;
			}
			if (a.startsWith("--output-document=")) {
				const dest = a.slice("--output-document=".length); explicit = true;
				if (dest !== "-") add(dest);
				continue;
			}
			if (/^-[A-Za-z]*O.+/.test(a)) {
				const dest = a.slice(a.indexOf("O") + 1); explicit = true;
				if (dest !== "-") add(dest);
				continue;
			}
			if ((a === "-P" || a === "--directory-prefix") && argv[i + 1]) { outDir = abs(argv[++i]) || outDir; add(outDir); explicit = true; continue; }
			if (a.startsWith("--directory-prefix=")) { outDir = abs(a.slice("--directory-prefix=".length)) || outDir; add(outDir); explicit = true; continue; }
			if (!a.startsWith("-") && /^https?:\/\//i.test(a)) url = a;
		}
		if (!spider && !explicit && url) {
			const base = path.posix.basename(url.split("?")[0]);
			t.push({ path: base ? path.resolve(outDir, base) : outDir, wholeWorktreeRemove: false });
		}
	}
	if (head === "mv") nonFlags(argv, 1, new Set(["-S", "--suffix"])).forEach((w) => add(w));
	if (head === "sed" || head === "perl" || head === "ruby" || head === "awk" || head === "gawk") {
		const inplace = argv.slice(1).some((a) => (head === "awk" || head === "gawk") ? /^inplace$/.test(a) : /^(--in-place(=.*)?|-[A-Za-z]*i.*)$/.test(a));
		if (inplace) {
			const hasScriptFlag = argv.slice(1).some((a) => /^(-e|-f|--expression|--file|-E)$/.test(a) || /^-[A-Za-z]*[ef]$/.test(a));
			const skipArgs = new Set();
			argv.forEach((a, i) => { if (/^(-e|-f|--expression|--file|-E|-pe|-ne)$/.test(a) && argv[i + 1]) skipArgs.add(i + 1); });
			const pos = argv.map((a, i) => [a, i]).slice(1).filter(([a, i]) => !a.startsWith("-") && !skipArgs.has(i)).map(([a]) => a);
			(hasScriptFlag || head === "perl" || head === "ruby" ? pos : pos.slice(1)).forEach((w) => add(w));
		}
	}
	if (head === "patch") {
		let d = dir;
		argv.forEach((a, i) => { if (a === "-d" && argv[i + 1]) d = path.resolve(d, argv[i + 1]); else if (/^-d.+/.test(a)) d = path.resolve(d, a.slice(2)); });
		t.push({ path: d, wholeWorktreeRemove: false });
	}
	if (head === "rsync") { const p = nonFlags(argv); if (p.length >= 2) add(p[p.length - 1]); }
	if (head === "dd") argv.forEach((a) => { if (a.startsWith("of=")) add(a.slice(3)); });
	if (head === "tar" && argv.slice(1).some((a) => /^-?[A-Za-z]*x/.test(a) || a === "--extract")) {
		let d = dir; argv.forEach((a, i) => { if ((a === "-C" || a === "--directory") && argv[i + 1]) d = abs(argv[i + 1]) || d; });
		t.push({ path: d, wholeWorktreeRemove: false });
	}
	if (head === "git") {
		const gdir = gitClauseDirectory(clause);
		let sub = null, subIdx = -1;
		for (let i = 1; i < argv.length; i++) {
			if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/.test(argv[i])) { i++; continue; }
			if (/^(?:-C.+|--git-dir=|--work-tree=|--namespace=|--exec-path=|--config-env=)/.test(argv[i])) continue;
			if (argv[i].startsWith("-")) continue;
			sub = argv[i]; subIdx = i; break;
		}
		const resetWrite = argv.includes("--hard") || argv.includes("--merge") || argv.includes("--keep") || argv.includes("--");
		if (sub && (GIT_WRITES.has(sub) || (sub === "reset" && resetWrite))) t.push({ path: gdir, wholeWorktreeRemove: false });
		if (sub === "stash") {
			const stashSub = argv.slice(subIdx + 1).find((a) => !a.startsWith("-")) || "push";
			if (stashSub !== "list" && stashSub !== "show") t.push({ path: gdir, wholeWorktreeRemove: false });
		}
		if (sub === "commit") {
			const longVal = new Set(["--message", "--file", "--reuse-message", "--reedit-message", "--template", "--author", "--date", "--cleanup", "--fixup", "--squash", "--trailer", "--untracked-files", "--pathspec-from-file", "--gpg-sign"]);
			let afterDd = false, commitAll = false;
			const pathspecs = [];
			for (let k = subIdx + 1; k < argv.length; k++) {
				const a = argv[k];
				if (!afterDd && a === "--") { afterDd = true; continue; }
				if (afterDd) { pathspecs.push(a); continue; }
				if (a === "--all") { commitAll = true; break; }
				if (a.startsWith("--")) { if (!a.includes("=") && longVal.has(a)) k++; continue; }
				if (a.startsWith("-") && a.length > 1) {
					let consumesNext = false;
					for (let ci = 1; ci < a.length; ci++) {
						const ch = a[ci];
						if (ch === "a") { commitAll = true; break; }
						if ("mFCctuSo".includes(ch)) { if (ci === a.length - 1 && "mFCctu".includes(ch)) consumesNext = true; break; }
					}
					if (commitAll) break;
					if (consumesNext) k++;
					continue;
				}
				pathspecs.push(a);
			}
			if (commitAll) t.push({ path: gdir, wholeWorktreeRemove: false });
			for (const p of pathspecs) t.push({ path: path.resolve(gdir, p), wholeWorktreeRemove: false });
		}
		if (sub === "worktree" && argv[subIdx + 1] === "remove") {
			for (const w of nonFlags(argv, subIdx + 2)) {
				const wp = abs(w);
				if (wp) t.push({ path: wp, wholeWorktreeRemove: true });
			}
		}
		if (sub === "apply" || sub === "am") for (const f of nonFlags(argv, subIdx + 1)) { try { const text = fs.readFileSync(path.resolve(gdir, f), "utf8"); for (const p of text.split(/\r?\n/)) { const m = p.match(/^\+\+\+ (?:b\/)?([^\t]+)/) || p.match(/^diff --git a\/\S+ b\/(\S+)/); if (m && m[1] !== "/dev/null") t.push({ path: path.resolve(gdir, m[1]), wholeWorktreeRemove: false }); } } catch {} }
	}
	if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") {
		let pkgDir = dir, sub = null;
		const valOpts = new Set(["-C", "--dir", "--prefix", "--filter", "-F", "--workspace", "-w", "--cwd"]);
		for (let i = 1; i < argv.length; i++) {
			const a = argv[i];
			if ((a === "-C" || a === "--dir" || a === "--prefix" || a === "--cwd") && argv[i + 1]) { pkgDir = abs(argv[++i]) || pkgDir; continue; }
			if (a.startsWith("--prefix=") || a.startsWith("--cwd=")) { pkgDir = abs(a.slice(a.indexOf("=") + 1)) || pkgDir; continue; }
			if (valOpts.has(a)) { i++; continue; }
			if (a.startsWith("-")) continue;
			sub = a; break;
		}
		if (sub && PKG_WRITES.has(sub)) t.push({ path: pkgDir, wholeWorktreeRemove: false });
	}
	if (head === "find") {
		const roots = [];
		let i = 1;
		for (; i < argv.length; i++) {
			const a = argv[i];
			if (a.startsWith("-") || a === "!" || a === "(") break;
			const r = abs(a); if (r) roots.push(r);
		}
		const effRoots = roots.length ? roots : [dir];
		for (; i < argv.length; i++) {
			const a = argv[i];
			if (a === "-delete") {
				for (const r of effRoots) t.push({ path: r, wholeWorktreeRemove: true });
			} else if (a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir") {
				const inner = [];
				for (i++; i < argv.length; i++) {
					if (argv[i] === ";" || argv[i] === "+") break;
					if (argv[i] !== "{}") inner.push(argv[i]);
				}
				if (inner.length) {
					t.push(...clauseTargets({ ...clause, argv: inner }, command, depth + 1, seenScripts));
					if (isMutatingArgv(inner)) for (const r of effRoots) t.push({ path: r, wholeWorktreeRemove: false });
				}
			}
		}
	}
	if (head === "xargs") {
		const xargsVal = new Set(["-I", "-L", "-l", "-n", "-P", "-s", "-d", "-E", "-e", "-a", "--arg-file", "--delimiter", "--eof", "--max-args", "--max-lines", "--max-procs", "--max-chars", "--process-slot-var"]);
		let k = 1;
		for (; k < argv.length; k++) {
			const a = argv[k];
			if (a === "--") { k++; break; }
			if (xargsVal.has(a)) { k++; continue; }
			if (a.startsWith("-")) continue;
			break;
		}
		const inner = argv.slice(k).filter((x) => !/\{\}/.test(x));
		if (inner.length) {
			const innerT = clauseTargets({ ...clause, argv: inner }, command, depth + 1, seenScripts);
			t.push(...innerT);
			if (isMutatingArgv(inner)) {
				const up = upstreamPathsFrom(allClauses, clauseIdx, command);
				if (up.known) for (const p of up.paths) t.push({ path: p, wholeWorktreeRemove: false });
				else if (!innerT.length) t.push({ path: dir, wholeWorktreeRemove: false });
			}
		}
	}
	const interp = interpreterProgram(argv, heredocs);
	if (interp) {
		let body = interp.text || "";
		if (interp.file) { try { const f = path.resolve(dir, interp.file); if (fs.statSync(f).size < 1 << 20) body = fs.readFileSync(f, "utf8"); } catch {} }
		for (const w of scriptWrites(body)) add(w);
	}
	if (isPipedXargs && isMutatingArgv(argv)) {
		const up = upstreamPathsFrom(allClauses, clauseIdx, command);
		const recRm = head === "rm" && argv.some((f) => /^--recursive$|^-[A-Za-z]*[rR]/.test(f));
		if (up.known) {
			for (const p of up.paths) t.push({ path: p, wholeWorktreeRemove: recRm });
		} else if (!t.length) {
			t.push({ path: dir, wholeWorktreeRemove: false });
		}
	}
	if (depth < 3) {
		const sh = localShellScript(argv, dir, abs);
		if (sh && !seenScripts.has(sh.file)) {
			const nextSeen = new Set(seenScripts);
			nextSeen.add(sh.file);
			for (const sc of effectiveCommands(sh.text, dir)) {
				t.push(...clauseTargets(sc, sh.text, depth + 1, nextSeen));
			}
		}
	}
	return t;
}

function main() {
	let data = {};
	try { data = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
	const tool = data.tool_name;
	const isShell = isShellTool(tool);
	if (!isShell && !isFileMutationTool(tool) && !/^(multiedit)$/i.test(String(tool).split(/[.:/]/).pop())) return;
	const lead = guard.leadSession(data);
	if (!lead.lead) return;
	const { approverLabel } = guard.guardMeta(lead);
	const input = data.tool_input || {};
	const cwd = typeof data.cwd === "string" ? data.cwd : process.cwd();
	const targets = [];
	let command = "";
	if (isShell) {
		command = String(input.command || input.cmd || "");
		const clauses = effectiveCommands(command, cwd);
		for (let i = 0; i < clauses.length; i++) {
			const clause = clauses[i];
			if ((clause.argv || []).some((a) => /lead-guard-exception/.test(a)) && !(clause.argv || []).includes("status")) {
				block(`[3층 쓰기 막기] 긴급 예외 기록은 ${approverLabel} 허락으로 외부에서 엽니다. 3층은 열거나 닫을 수 없습니다.`, { role: lead.role, session_id: data.session_id, tool, rule: "self:exception-script", command: command.slice(0, 300) });
			}
			targets.push(...clauseTargets(clause, command, 0, new Set(), clauses, i));
		}
	} else {
		const p = input.file_path || input.notebook_path || input.path || input.target_file;
		if (p) targets.push({ path: path.resolve(cwd, p), wholeWorktreeRemove: false });
		for (const q of patchPaths(input.input || input.patch || input.command || input.patch_text)) targets.push({ path: path.resolve(cwd, q), wholeWorktreeRemove: false });
	}
	for (const target of targets) {
		const r = guard.classify(target.path, lead, target.wholeWorktreeRemove ? { wholeWorktreeRemove: true } : undefined);
		if (r.ok && r.exception) guard.audit({ event: "exception-used", exception_id: r.exception, role: lead.role, session_id: data.session_id, tool, target: target.path });
		if (!r.ok) block(guideMessage(target.path, r.rule, lead), { role: lead.role, session_id: data.session_id, tool, rule: r.rule, target: target.path });
	}
}

if (require.main === module) {
	try { main(); } catch (e) { try { guard.audit({ event: "guard-error", error: String(e && e.message || e).slice(0, 200) }); } catch {} }
}
