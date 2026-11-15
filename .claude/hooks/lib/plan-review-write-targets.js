"use strict";
/**
 * 계획 리뷰 쓰기 관문용 변경 대상 경로 추출기.
 *
 * PreToolUse 입력(파일 변이 도구 및 셸 도구)에서 실제로 바뀔 수 있는 경로 목록을 뽑고,
 * 심볼릭 링크를 풀어 해당 경로가 속한 git 저장소 뿌리(repoRoot)에 대응시킨다.
 */
const fs = require("fs");
const path = require("path");
const {
	effectiveCommands,
	writtenPaths,
	interpreterProgram,
	gitClauseDirectory,
	resolvePathWord,
	SHELLS,
	SHELL_ALT,
} = require("./effective-argv.js");

const SHEBANG_SHELL_RE = new RegExp(`^#!\\s*/.*\\b(?:${SHELL_ALT})\\b`);

const GIT_UNCONDITIONAL_WRITES = new Set([
	"add", "stage", "rm", "mv", "restore", "clean", "checkout", "switch",
	"reset", "commit", "merge", "pull", "cherry-pick", "rebase", "revert",
	"apply", "am", "notes", "update-ref",
]);

const PKG_WRITES = new Set([
	"install", "i", "ci", "add", "remove", "rm", "uninstall", "un",
	"update", "up", "upgrade", "link", "unlink", "dedupe", "prune", "init",
]);

const MUTATOR_HEADS = new Set([
	"rm", "rmdir", "truncate", "shred", "unlink", "mv", "cp", "ln", "install",
	"tee", "touch", "mkdir", "mkfifo", "mknod", "chmod", "chown", "chgrp",
	"patch", "dd", "unzip",
]);

function realPathLoose(targetPath) {
	const resolved = path.resolve(String(targetPath || ""));
	let cur = resolved;
	const tail = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(cur), ...tail);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return resolved;
			tail.unshift(path.basename(cur));
			cur = parent;
		}
	}
}

function repoRootOf(targetPath) {
	if (!targetPath) return null;
	let cur = realPathLoose(targetPath);
	for (;;) {
		try {
			if (fs.existsSync(path.join(cur, ".git"))) {
				return realPathLoose(cur);
			}
		} catch {}
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

function patchPaths(text) {
	const out = [];
	for (const line of String(text || "").split(/\r?\n/)) {
		const codexMatch = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) || line.match(/^\*\*\* Move to: (.+)$/);
		if (codexMatch) {
			out.push(codexMatch[1].trim());
			continue;
		}
		const gitDiff = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
		if (gitDiff) {
			if (gitDiff[1] !== "/dev/null") out.push(gitDiff[1]);
			if (gitDiff[2] !== "/dev/null") out.push(gitDiff[2]);
			continue;
		}
		const unified = line.match(/^(?:\+\+\+|---) (?:[ab]\/)?([^\t\r\n]+)$/);
		if (unified && unified[1] !== "/dev/null") {
			out.push(unified[1].trim());
		}
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

function scriptWrites(text) {
	const src = String(text || "");
	const paths = [];
	let hasUnresolvedWrite = false;
	const vars = new Map();
	const recordPath = (p) => {
		if (p) paths.push(p);
		else hasUnresolvedWrite = true;
	};
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
			const ev = (idx) => (args[idx] ? evalScriptExpr(args[idx], vars) : null);
			const evMode = (idx) => {
				if (!args[idx]) return "";
				const m = args[idx].replace(/^(?:mode|flags)\s*=\s*/, "");
				return unquoteStr(m.trim()) || "";
			};
			if (call.fn === "open") {
				const mode = args.slice(1).map((a) => unquoteStr(a.replace(/^mode\s*=\s*/, "").trim()) || "").find(Boolean) || "";
				if (/[wax+]/.test(mode)) recordPath(ev(0));
				else if (args[1]) {
					const pm = unquoteStr(args[1].trim());
					if (pm && /^(?:>|>>|\+>)/.test(pm)) recordPath(pm.replace(/^(?:>|>>|\+>)\s*/, "").trim());
				}
			} else if (call.fn === "Path") {
				const p = ev(0);
				const rest = line.slice(call.end);
				const pm = rest.match(/^\s*\.\s*(write_text|write_bytes|unlink|rmdir|touch|open|rename|replace)\s*\(([^)]*)\)/);
				if (pm) {
					if (pm[1] === "open") {
						if (/[wax+]/.test(pm[2])) recordPath(p);
					} else if (pm[1] === "rename" || pm[1] === "replace") {
						recordPath(p);
						recordPath(evalScriptExpr(splitTopLevel(pm[2], ",")[0] || "", vars));
					} else {
						recordPath(p);
					}
				}
			} else if (/^([A-Za-z_][A-Za-z0-9_]*)\.(write_text|write_bytes|unlink|rmdir|touch|open|rename|replace)$/.test(call.fn) && vars.has(call.fn.split(".")[0])) {
				const [obj, meth] = call.fn.split(".");
				const p = vars.get(obj);
				if (meth === "open") { if (/[wax+]/.test(evMode(0))) recordPath(p); }
				else if (meth === "rename" || meth === "replace") { recordPath(p); recordPath(ev(0)); }
				else recordPath(p);
			} else if (/^(?:os\.)?(?:remove|unlink|rmdir|mkdir|makedirs|truncate|chmod|chown|chgrp|lchown)$/.test(call.fn) || call.fn === "shutil.rmtree" || /^(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|rmSync|rm|rmdirSync|rmdir|unlinkSync|unlink|mkdirSync|mkdir|truncateSync|truncate|chmodSync|chmod|chownSync|chown)$/.test(tailFn)) {
				if (call.fn === "open" || call.fn === "Path") continue;
				if (/^(?:rm|unlink|rmdir|mkdir|truncate|chmod|chown|open)$/.test(tailFn) && call.fn.includes(".") && !/^(?:os|fs|promises|File)\./.test(call.fn) && !call.fn.endsWith(`.promises.${tailFn}`)) {
					if (!/\.promises\./.test(call.fn)) continue;
				}
				if (/^(?:unlink|chmod|chown)$/.test(tailFn) && !call.fn.includes(".") && args[0] && /^(?:0|['"]?[0-7])/.test(args[0].trim())) {
					for (let k = 1; k < args.length; k++) recordPath(ev(k));
					continue;
				}
				recordPath(ev(0));
			} else if (/^(?:os\.(?:rename|replace|link|symlink)|shutil\.move)$/.test(call.fn) || /^(?:renameSync|rename|linkSync|link|symlinkSync|symlink)$/.test(tailFn)) {
				recordPath(ev(0));
				recordPath(ev(1));
			} else if (/^shutil\.(?:copy|copy2|copyfile|copytree)$/.test(call.fn) || /^(?:copyFileSync|copyFile|cpSync|cp)$/.test(tailFn)) {
				recordPath(ev(1));
			} else if (call.fn === "File.write" || call.fn === "File.binwrite" || call.fn === "File.delete" || call.fn === "File.unlink") {
				for (let k = 0; k < args.length; k++) {
					if ((call.fn === "File.write" || call.fn === "File.binwrite") && k > 0) break;
					recordPath(ev(k));
				}
			} else if (call.fn === "File.rename") {
				recordPath(ev(0));
				recordPath(ev(1));
			}
		}
		for (const m of line.matchAll(/\bopen\s*(?:\([^)]*\)|\w+)\s*,\s*(["'])(?:>|>>|\+>)\s*(.*?)\1/g)) {
			if (m[2].trim()) paths.push(m[2].trim());
		}
	}
	return { paths, hasUnresolvedWrite };
}

const nonFlags = (argv, from = 1, valueOpts = null) => {
	const o = [];
	let end = false;
	for (let i = from; i < argv.length; i++) {
		const a = argv[i];
		if (!end && a === "--") { end = true; continue; }
		if (!end && valueOpts && valueOpts.has(a)) { i++; continue; }
		if (end || !a.startsWith("-")) o.push(a);
	}
	return o;
};

function isMutatingArgv(argv) {
	const head = path.basename(argv[0] || "");
	if (MUTATOR_HEADS.has(head)) return true;
	if ((head === "sed" || head === "perl" || head === "ruby") && argv.slice(1).some((a) => /^(--in-place(=.*)?|-[A-Za-z]*i.*)$/.test(a))) return true;
	if ((head === "awk" || head === "gawk") && argv.slice(1).some((a) => /^inplace$/.test(a))) return true;
	return false;
}

function isTestRunnerInvocation(argv) {
	const head = path.basename(argv[0] || "");
	if (head === "node" && argv.slice(1).some((a) => a === "--test" || a.startsWith("--test="))) return true;
	if (head.startsWith("python") && argv.slice(1).some((a, i) => a === "-m" && /^(?:pytest|unittest)$/.test(argv[i + 2] || ""))) return true;
	return false;
}

function localShellScript(argv, resolveFn) {
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
			const r = absPrev(a);
			if (r) roots.push(r);
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

function staticPrefixBeforeExpansion(word, baseDir) {
	const raw = String(word || "").replace(/^['"]|['"]$/g, "");
	const dynIdx = raw.search(/[$`]/);
	if (dynIdx < 0) return null;
	const prefix = raw.slice(0, dynIdx);
	if (!prefix) return baseDir || null;
	const slashIdx = prefix.lastIndexOf("/");
	const dirPart = slashIdx >= 0 ? (prefix.slice(0, slashIdx) || "/") : ".";
	return path.isAbsolute(dirPart) ? dirPart : (baseDir ? path.resolve(baseDir, dirPart) : null);
}

function clauseTargets(clause, command, fallbackCwd, depth = 0, seenScripts = new Set(), allClauses = null, clauseIdx = 0) {
	const argv = clause.argv || [];
	const head = path.basename(argv[0] || "");
	const dir = clause.dir || fallbackCwd;
	const isPipedXargs = Boolean(clause.piped || (Array.isArray(clause.clause) && path.basename(clause.clause[0] || "") === "xargs"));
	const abs = (w) => {
		if (!w) return null;
		if (/[$`]/.test(String(w))) return null;
		return resolvePathWord(w, dir, command, clause.dirKnown) || (path.isAbsolute(w) ? w : clause.dirKnown === false ? null : path.resolve(dir, w));
	};
	const t = [];
	const add = (w, wholeRepo = false) => {
		if (!w || (isPipedXargs && /\{\}/.test(w))) return;
		const a = abs(w);
		if (a) {
			t.push({ path: a, wholeRepo });
			return;
		}
		const prefix = staticPrefixBeforeExpansion(w, dir);
		t.push({ path: prefix || dir || fallbackCwd, wholeRepo: true });
	};

	const heredocs = clause.heredocs || (clause.clause && clause.clause.heredocs);
	for (const [p] of writtenPaths(argv, dir, command, clause.dirKnown, heredocs)) {
		if (p && p !== "/dev/null") t.push({ path: p, wholeRepo: false });
	}
	// 동적 리다이렉션(> $OUT 등) 보강
	for (let i = 0; i < argv.length; i++) {
		const tok = String(argv[i] || "");
		if (/^(?:\d*>>?|\d*&>>?)$/.test(tok) && argv[i + 1]) {
			const next = String(argv[i + 1]);
			if (next !== "/dev/null" && !/^&\d+$/.test(next) && /[$`]/.test(next)) add(next, true);
		} else if (/^(?:\d*>>?|\d*&>>?)(?!&\d)(.+)$/.test(tok)) {
			const rest = tok.replace(/^(?:\d*>>?|\d*&>>?)/, "");
			if (rest && rest !== "/dev/null" && /[$`]/.test(rest)) add(rest, true);
		}
	}

	if (head === "rm" || head === "rmdir") {
		const dd = argv.indexOf("--");
		const flags = (dd >= 0 ? argv.slice(1, dd) : argv.slice(1)).filter((a) => a.startsWith("-"));
		const rec = head === "rmdir" || flags.some((f) => f === "--recursive" || (/^-[A-Za-z]+$/.test(f) && (f.includes("r") || f.includes("R"))));
		nonFlags(argv).forEach((w) => add(w, rec));
	}
	if (head === "shred" || head === "unlink" || head === "mkfifo") nonFlags(argv).forEach((w) => add(w));
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
			if (a === "--output-dir" && argv[i + 1]) { outDir = abs(argv[++i]) || outDir; continue; }
			if (a.startsWith("--output-dir=")) { outDir = abs(a.slice("--output-dir=".length)) || outDir; continue; }
			if (a === "-O" || a === "--remote-name" || a === "--remote-name-all" || /^-[A-Za-z]*O[A-Za-z]*$/.test(a)) { remoteName = true; continue; }
			if (!a.startsWith("-") && /^https?:\/\//i.test(a)) url = a;
		}
		if (remoteName && !explicit) {
			const base = url ? path.posix.basename(url.split("?")[0]) : "";
			t.push({ path: base ? path.resolve(outDir, base) : outDir, wholeRepo: !base });
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
			if ((a === "-P" || a === "--directory-prefix") && argv[i + 1]) { outDir = abs(argv[++i]) || outDir; add(outDir, true); explicit = true; continue; }
			if (a.startsWith("--directory-prefix=")) { outDir = abs(a.slice("--directory-prefix=".length)) || outDir; add(outDir, true); explicit = true; continue; }
			if (!a.startsWith("-") && /^https?:\/\//i.test(a)) url = a;
		}
		if (!spider && !explicit && url) {
			const base = path.posix.basename(url.split("?")[0]);
			t.push({ path: base ? path.resolve(outDir, base) : outDir, wholeRepo: !base });
		}
	}
	if (head === "mv") nonFlags(argv, 1, new Set(["-S", "--suffix", "-t", "--target-directory"])).forEach((w) => add(w));
	if (head === "cp" || head === "ln" || head === "install") {
		let targetDir = null;
		for (let i = 1; i < argv.length; i++) {
			if ((argv[i] === "-t" || argv[i] === "--target-directory") && argv[i + 1]) targetDir = argv[++i];
			else if (argv[i].startsWith("--target-directory=")) targetDir = argv[i].slice("--target-directory=".length);
		}
		if (targetDir) add(targetDir, true);
		else {
			const pos = nonFlags(argv, 1, new Set(["-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"]));
			if (pos.length >= 2) add(pos[pos.length - 1]);
		}
	}
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
		t.push({ path: d, wholeRepo: true });
	}
	if (head === "rsync") { const p = nonFlags(argv); if (p.length >= 2) add(p[p.length - 1], true); }
	if (head === "dd") argv.forEach((a) => { if (a.startsWith("of=")) add(a.slice(3)); });
	if (head === "tar" && argv.slice(1).some((a) => /^-?[A-Za-z]*x/.test(a) || a === "--extract")) {
		let d = dir;
		argv.forEach((a, i) => { if ((a === "-C" || a === "--directory") && argv[i + 1]) d = abs(argv[i + 1]) || d; });
		t.push({ path: d, wholeRepo: true });
	}
	if (head === "git") {
		const gdir = gitClauseDirectory(clause) || dir;
		let sub = null, subIdx = -1;
		for (let i = 1; i < argv.length; i++) {
			if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/.test(argv[i])) { i++; continue; }
			if (/^(?:-C.+|--git-dir=|--work-tree=|--namespace=|--exec-path=|--config-env=)/.test(argv[i])) continue;
			if (argv[i].startsWith("-")) continue;
			sub = argv[i]; subIdx = i; break;
		}
		if (sub && GIT_UNCONDITIONAL_WRITES.has(sub)) {
			t.push({ path: gdir, wholeRepo: true });
		} else if (sub === "stash") {
			const stashSub = argv.slice(subIdx + 1).find((a) => !a.startsWith("-")) || "push";
			if (stashSub !== "list" && stashSub !== "show") t.push({ path: gdir, wholeRepo: true });
		} else if (sub === "branch") {
			const rest = argv.slice(subIdx + 1);
			const mutFlag = rest.some((a) => /^(?:-[dDmMcCu]|--delete|--move|--copy|--set-upstream-to(?:=|$)|--unset-upstream)/.test(a));
			const listFlag = rest.some((a) => /^(?:-[alv]|--all|--remotes|--list|--show-current|--contains|--merged|--no-merged|--points-at)/.test(a));
			const pos = nonFlags(argv, subIdx + 1);
			if (mutFlag || (!listFlag && pos.length > 0)) t.push({ path: gdir, wholeRepo: true });
		} else if (sub === "tag") {
			const rest = argv.slice(subIdx + 1);
			const readFlag = rest.some((a) => /^(?:-[lv]|--list|--verify|--contains|--points-at|--merged|--no-merged)/.test(a));
			const mutFlag = rest.some((a) => /^(?:-[dasufmF]|--delete|--annotate|--sign|--force|--message)/.test(a));
			const pos = nonFlags(argv, subIdx + 1);
			if (mutFlag || (!readFlag && pos.length > 0)) t.push({ path: gdir, wholeRepo: true });
		} else if (sub === "config") {
			const rest = argv.slice(subIdx + 1);
			const globalOrRead = rest.some((a) => /^(?:--global|--system|--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope)/.test(a));
			if (!globalOrRead && rest.length >= 2) t.push({ path: gdir, wholeRepo: true });
		} else if (sub === "worktree" && argv[subIdx + 1] === "remove") {
			for (const w of nonFlags(argv, subIdx + 2)) add(w, true);
		}
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
		if (sub && PKG_WRITES.has(sub)) t.push({ path: pkgDir, wholeRepo: true });
	}
	if (head === "find") {
		const roots = [];
		let i = 1;
		for (; i < argv.length; i++) {
			const a = argv[i];
			if (a.startsWith("-") || a === "!" || a === "(") break;
			const r = abs(a);
			if (r) roots.push(r);
		}
		const effRoots = roots.length ? roots : [dir];
		for (; i < argv.length; i++) {
			const a = argv[i];
			if (a === "-delete") {
				for (const r of effRoots) t.push({ path: r, wholeRepo: true });
			} else if (a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir") {
				const inner = [];
				for (i++; i < argv.length; i++) {
					if (argv[i] === ";" || argv[i] === "+") break;
					if (argv[i] !== "{}") inner.push(argv[i]);
				}
				if (inner.length) {
					t.push(...clauseTargets({ ...clause, argv: inner }, command, fallbackCwd, depth + 1, seenScripts));
					if (isMutatingArgv(inner)) for (const r of effRoots) t.push({ path: r, wholeRepo: true });
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
			const innerT = clauseTargets({ ...clause, argv: inner }, command, fallbackCwd, depth + 1, seenScripts);
			t.push(...innerT);
			if (isMutatingArgv(inner)) {
				const up = upstreamPathsFrom(allClauses, clauseIdx, command);
				if (up.known) for (const p of up.paths) t.push({ path: p, wholeRepo: true });
				else if (!innerT.length) t.push({ path: dir, wholeRepo: true });
			}
		}
	}
	if (!isTestRunnerInvocation(argv)) {
		const interp = interpreterProgram(argv, heredocs);
		if (interp) {
			let body = interp.text || "";
			if (interp.file) {
				try {
					const f = path.resolve(dir, interp.file);
					if (fs.statSync(f).size < 1 << 20) body = fs.readFileSync(f, "utf8");
				} catch {}
			}
			const sw = scriptWrites(body);
			for (const w of sw.paths) add(w);
			if (interp.text !== undefined && sw.hasUnresolvedWrite) {
				t.push({ path: dir, wholeRepo: true });
			}
		}
	}
	if (isPipedXargs && isMutatingArgv(argv)) {
		const up = upstreamPathsFrom(allClauses, clauseIdx, command);
		if (up.known) {
			for (const p of up.paths) t.push({ path: p, wholeRepo: true });
		} else if (!t.length) {
			t.push({ path: dir, wholeRepo: true });
		}
	}
	if (depth < 3) {
		const sh = localShellScript(argv, abs);
		if (sh && !seenScripts.has(sh.file)) {
			const nextSeen = new Set(seenScripts);
			nextSeen.add(sh.file);
			for (const sc of effectiveCommands(sh.text, dir)) {
				t.push(...clauseTargets(sc, sh.text, fallbackCwd, depth + 1, nextSeen));
			}
		}
	}
	return t;
}

function extractWriteTargets({ isShell, toolInput, cwd }) {
	const input = toolInput && typeof toolInput === "object" ? toolInput : {};
	const baseCwd = path.resolve(typeof cwd === "string" && cwd ? cwd : process.cwd());
	if (isShell) {
		const command = String(input.command || input.cmd || "");
		if (!command.trim()) return { targets: [], unresolvedMutation: false };
		let clauses;
		try {
			clauses = effectiveCommands(command, baseCwd);
		} catch {
			return { targets: [], unresolvedMutation: true };
		}
		const targets = [];
		for (let i = 0; i < clauses.length; i++) {
			targets.push(...clauseTargets(clauses[i], command, baseCwd, 0, new Set(), clauses, i));
		}
		return { targets, unresolvedMutation: false };
	}

	const targets = [];
	const direct = input.file_path || input.notebook_path || input.path || input.target_file;
	if (typeof direct === "string" && direct.trim()) {
		targets.push({ path: path.resolve(baseCwd, direct.trim()), wholeRepo: false });
	}
	if (Array.isArray(input.edits)) {
		for (const item of input.edits) {
			const ep = item && (item.file_path || item.path || item.target_file);
			if (typeof ep === "string" && ep.trim()) {
				targets.push({ path: path.resolve(baseCwd, ep.trim()), wholeRepo: false });
			}
		}
	}
	const patchBody = input.input || input.patch || input.command || input.patch_text;
	for (const p of patchPaths(patchBody)) {
		targets.push({ path: path.resolve(baseCwd, p), wholeRepo: false });
	}
	return { targets, unresolvedMutation: targets.length === 0 };
}

module.exports = {
	realPathLoose,
	repoRootOf,
	patchPaths,
	extractWriteTargets,
};
