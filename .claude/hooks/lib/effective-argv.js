"use strict";
/**
 * What a shell clause actually runs (2026-09-25 harness audit, design review round 9 hole 2).
 *
 * The deploy classifier and the agent-run gate each recognised a command only at
 * the head of a clause after a fixed wrapper list, so `setsid`, `timeout -s KILL`,
 * `flock <file>`, `systemd-run`, `bash -c '…'`, `tmux new -d '…'` and
 * `script -qc '…'` hid the real command. Both now read clauses through this one
 * routine: wrappers (and their option values) are peeled off, and commands passed
 * as a string to a shell-like runner are parsed again.
 *
 * expandClause(tokens) -> [{ argv, assigns }]  (argv[0] is the real program)
 */

const path = require("path");
const { shellClauses: rawShellClauses } = require("./git-command-parser.js");

// Keep shell data out of the command lexer. Quotes and substitutions remain
// lexical units; only substitutions inside [[...]]/case patterns execute.
function shellClauses(command) {
	const text = String(command);
	const cache = analysisCache?.clauses;
	if (!cache) return parseShellClauses(text);
	if (!cache.has(text)) cache.set(text, parseShellClauses(text));
	// Clauses are arrays with parser metadata; give callers independent copies.
	const copy = (array) => Object.assign(array.map((value) => Array.isArray(value) ? copy(value) : value),
		Object.fromEntries(Object.entries(array).filter(([key]) => !/^\d+$/.test(key)).map(([key, value]) => [key, Array.isArray(value) ? copy(value) : value])));
	return copy(cache.get(text));
}
function parseShellClauses(command) {
	const text = String(command), lex = [];
	if (!/\[\[|\bcase\b/.test(text)) return rawShellClauses(text);
	let i = 0;
	const heredocs=[];
	const wordEnd = (from, closing = "") => {
		let q = "", n = from;
		for (; n < text.length; n++) {
			const c = text[n];
			if (c === "\\" && q !== "'") { n++; continue; }
			if (q === "'") { if (c === q) q = ""; continue; }
			if (!q && closing && c === closing) return n;
			if (c === "`" || ((c === "$" || (!q && /[<>]/.test(c))) && text[n + 1] === "(")) {
				const end = wordEnd(n + (c === "`" ? 1 : 2), c === "`" ? "`" : ")");
				n = end; continue;
			}
			if (q) { if (c === q) q = ""; continue; }
			if (closing && c === closing) return n;
			if (c === "'" || c === '"') { q = c; continue; }
			if (closing && c === "(") { n = wordEnd(n + 1, ")"); continue; }
			if (!closing && /[\s;&|()]/.test(c)) break;
		}
		return n;
	};
	while (i < text.length) {
		if (/\s/.test(text[i])) {
			if (text[i] === "\n") {
				lex.push({ start:i, end:i+1, value:"\n", op:true }); i++;
				while(heredocs.length) {
					const hd=heredocs.shift();
					while(i<text.length) {const end=text.indexOf("\n",i),stop=end<0?text.length:end,line=text.slice(i,stop);i=end<0?text.length:end+1;if((hd.strip?line.replace(/^\t+/,""):line).trim()===hd.delim)break;}
				}
			} else i++;
			continue;
		}
		if (text[i] === "#") { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end; continue; }
		const start = i;
		if (/[;&|()]/.test(text[i])) { const m = text.slice(i).match(/^(?:;;&|;;|;&|&&|\|\||\|&|[;&|()])/)[0]; i += m.length; lex.push({start,end:i,value:m,op:true}); }
		else {
			const hd=text.slice(i).match(/^\d*<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\2/);
			if(hd)heredocs.push({strip:hd[1]==="-",delim:hd[3]});
			i = wordEnd(i); if (i === start) i++; lex.push({start,end:i,value:text.slice(start,i),op:false});
		}
	}
	const spans = [], cases = [];
	const hide = (start,end) => {
		const fragment = text.slice(start,end);
		const subs = rawShellClauses(fragment).flatMap(c => c.subs || []);
		spans.push({start,end,replacement: subs.map(s => `\n: $( ${s} )\n`).join("") + "\n"});
	};
	let commandPosition = true;
	const patternEnd = (from) => {
		let q="", bracket=false, nested=0, first=true;
		for(let k=from;k<text.length;k++) {
			const c=text[k];if(c==="\\"&&q!=="'"){k++;first=false;continue;}
			if(q){if(c===q)q="";continue;}
			if(c==="'"||c==='"'){q=c;first=false;continue;}
			if(c==="`"||((c==="$"||/[<>]/.test(c))&&text[k+1]==="(")){k=wordEnd(k+(c==="`"?1:2),c==="`"?"`":")");first=false;continue;}
			if(bracket){if(c==="]")bracket=false;continue;}
			if(c==="#"&&(first||/\s/.test(text[k-1]))){const nl=text.indexOf("\n",k);k=nl<0?text.length:nl;continue;}
			if(c==="["){bracket=true;first=false;continue;}
			if(first&&/\s/.test(c))continue;
			if(c==="("){if(!first)nested++;first=false;continue;}
			if(c===")"){if(nested)nested--;else return k;}
			first=false;
		}
		return -1;
	};
	for (let n = 0; n < lex.length; n++) {
		const t = lex[n];
		if (t.value === "[[" && commandPosition) {
			const end = lex.findIndex((v,k) => k > n && v.value === "]]");
			if (end < 0) break;
			hide(t.start,lex[end].end); n = end; commandPosition = false; continue;
		}
		const current = cases.at(-1);
		if (current?.phase === "head") {
			if (t.value === "in") { hide(current.start,t.end); current.phase = "pattern"; current.start = t.end; current.end=patternEnd(t.end); }
			continue;
		}
		if (current?.phase === "pattern") {
			if (t.value === "esac") { hide(current.start,t.start); cases.pop(); commandPosition = true; continue; }
			if (t.value === ")" && t.start === current.end) { hide(current.start,t.end); current.phase = "body"; commandPosition = true; }
			continue;
		}
		if (t.value === "case" && commandPosition) { cases.push({phase:"head",start:t.start}); continue; }
		if (t.value === "esac" && current) { cases.pop(); commandPosition = true; continue; }
		if (current && /^(?:;;|;&|;;&)$/.test(t.value)) { current.phase = "pattern"; current.start = t.end; current.end=patternEnd(t.end); commandPosition = true; continue; }
		commandPosition = t.op || /^(?:if|then|elif|else|do|while|until|!|\{)$/.test(t.value);
	}
	if (!spans.length) return rawShellClauses(text);
	let clean = "", at = 0;
	for (const span of spans) { clean += text.slice(at,span.start) + span.replacement; at = span.end; }
	return rawShellClauses(clean + text.slice(at));
}

function shellState(inherited, dir) {
	const initial = {};
	return { dir, dirKnown: true, vars: {...initial}, exported: {...initial}, autoExport:false, uncertain:false,
		...inherited, vars:{...(inherited ? inherited.vars : initial)}, exported:{...(inherited ? inherited.exported : initial)}, exportFlags:{...inherited?.exportFlags}, explicitExports:{...inherited?.explicitExports}, readonly:{...inherited?.readonly}, fds:new Map(inherited?.fds || []) };
}

// Every body entry uses this function: files, source, -c, stdin (heredoc,
// here-string, pipe/redirection), substitutions, subshells and generated code.
function shellBodyState(entry, kind = "exec") {
	const state = entry.shellState || entry;
	const child = shellState(state, entry.dir ?? state.dir);
	if (kind === "generated" && entry.generatedInline !== undefined) child.generatedInline = entry.generatedInline;
	const modes = {source:"shell",substitution:"shell",subshell:"shell",eval:"shell",exec:"environment",file:"environment",stdin:"environment",command:"environment",startup:"environment",generated:"environment",wrapper:"environment"};
	if (!Object.hasOwn(modes,kind)) child.uncertain=true;
	// Interpreter-derived commands may override their child's environment. The
	// string extractor cannot establish those options, so retain that uncertainty.
	if (kind === "generated" && /\b(?:env\s*[:=]|cwd\s*[:=]|chdir\s*\(|process\s*\.\s*env|(?:os\s*\.\s*)?environ\b)/.test(entry.bodyText || "")) child.uncertain=true;
	if (modes[kind] !== "shell") {
		child.vars = {...child.exported}; child.autoExport = false;
		child.exportFlags=Object.fromEntries(Object.entries(child.exported).map(([k,v])=>[k,v !== null])); child.readonly={};
		if (Object.hasOwn(child.exported,"PATH") && child.exported.PATH === null) child.uncertain=true;
	}
	for (const a of entry.prefixAssigns || []) {
		const at = a.indexOf("="),k=a.slice(0,at); child.vars[k] = a.slice(at+1); child.exported[k] = a.slice(at+1); child.exportFlags[k]=true;child.explicitExports[k]=true;
	}
	if (SHELLS.test(entry.argv?.[0] || "") && /^(?:file|stdin|command|startup)$/.test(kind)) {
		const inv=shellInvocation(entry.argv),end=inv.command>=0?inv.command:inv.script>=0?inv.script:entry.argv.length;
		for(let i=1;i<end;i++) {
			const opt=entry.argv[i];
			if (/^--(?:rcfile|init-file)$/.test(opt)) {i++;continue;}
			if(opt === "--posix") child.uncertain=true;
			if(!/^[-+][A-Za-z]+$/.test(opt))continue;
			if(opt.slice(1).includes("a"))child.autoExport=opt[0] === "-";
			if(/[oO]/.test(opt.slice(1))) {const value=entry.argv[++i];if(opt.includes("O")||value === "posix")child.uncertain=true;else if(value === "allexport")child.autoExport=opt[0] === "-";}
		}
	}
	return child;
}

function sourceTargetIndex(argv) {
	let i = 1;
	while (i < argv.length) {
		const r = redirectSpan(argv, i);
		if (r) { i += r; continue; }
		if (argv[i] === "--") { i++; break; }
		break;
	}
	return i < argv.length ? i : -1;
}

function updateShellState(words, state) {
	const name = /^[A-Za-z_]\w*$/;
	const value = (v) => v.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_,a,b) => shellValue(state,a || b));
	const assign = (w, exportIt = false) => {
		const at = w.indexOf("="), k = at < 0 ? w : w.slice(0,at);
		if (!name.test(k)) { state.uncertain = true; return; }
		if (at >= 0) { if(state.readonly[k]) state.uncertain=true; else state.vars[k] = value(w.slice(at+1)); }
		if (exportIt || state.autoExport || (state.exportFlags[k] ?? ((state.exported[k] != null) || Object.hasOwn(process.env,k)))) {
			state.exportFlags[k]=true;
			if(exportIt || state.autoExport) state.explicitExports[k]=true;
			state.exported[k]=Object.hasOwn(state.vars,k) ? state.vars[k] : process.env[k] ?? null;
		}
	};
	if (!words.length) return;
	// Shell builtins can assign values without a simple literal assignment. Keep
	// those values unknown instead of confusing them with an unset variable.
	const markUnknown = k => {
		if (!name.test(k)) return;
		state.vars[k] = "$unknown";
		if (state.exportFlags[k] || state.autoExport || state.exported[k] != null) state.exported[k] = "$unknown";
	};
	if (words.length === 1 && /^[A-Za-z_]\w*\+=/.test(words[0])) { markUnknown(words[0].split("+=")[0]); return; }
	if (/^(?:read|mapfile|readarray)$/.test(words[0])) {
		for (const w of words.slice(1).filter(w => name.test(w))) markUnknown(w);
	} else if (words[0] === "printf" && words[1] === "-v") markUnknown(words[2] || "");
	if (words.every(w => ASSIGN.test(w))) { words.forEach(w => assign(w)); return; }
	const head = words[0];
	if (head === "set") {
		for (let i=1;i<words.length;i++) {
			const w=words[i]; if (w === "--" || !/^[-+]/.test(w)) break;
			if (/^[-+][A-Za-z]+$/.test(w)) {
				if (/[^aefhkmnptuvxBCEHPTso]/.test(w.slice(1))) state.uncertain=true;
				if (w.includes("a")) state.autoExport=w[0] === "-";
				if (w.includes("o")) { const opt=words[++i]; if (opt === "allexport") state.autoExport=w[0] === "-"; else if (!/^(?:errexit|nounset|pipefail|xtrace|verbose|noglob|noclobber|monitor|notify|hashall|braceexpand|history|histexpand|ignoreeof|interactive-comments|keyword|onecmd|physical|posix|privileged|vi|emacs)$/.test(opt || "")) state.uncertain=true; if (opt === "posix") state.uncertain=true; }
			} else state.uncertain=true;
		}
		return;
	}
	if (/^(?:alias|unalias|hash|enable|eval)$/.test(head) || (head === "shopt" && words.some(w=>/^(?:sourcepath|expand_aliases|lastpipe|extglob)$/.test(w)))) state.uncertain=true;
	if (!/^(?:export|declare|typeset|local|readonly|unset)$/.test(head)) return;
	let i=1, exportIt=head === "export", unexport=false, print=false, remove=head === "unset", functions=false, readonly=head === "readonly";
	for (;i<words.length && /^[-+]/.test(words[i]);i++) {
		const w=words[i]; if(w === "--") {i++;break;}
		const allowed = head === "unset" ? "fv" : head === "export" ? "fnp" : head === "readonly" ? "afp" : "aAfFgilnprtuxGI";
		if (!/^[-+][A-Za-z]+$/.test(w) || [...w.slice(1)].some(c => !allowed.includes(c))) state.uncertain=true;
		if (/[aAilntuI]/.test(w.slice(1)) && /^(?:declare|typeset|local)$/.test(head)) state.uncertain=true;
		if (w.includes("x")) { exportIt=w[0] === "-"; unexport=w[0] === "+"; }
		if (w.includes("r") && /^(?:declare|typeset|local)$/.test(head)) { if(w[0] === "+") state.uncertain=true; else readonly=true; }
		if (/[aA]/.test(w.slice(1)) && head === "readonly") state.uncertain=true;
		if (head === "export" && w.includes("n")) { exportIt=false; unexport=true; }
		if (w.includes("p")) print=true;
		if (/[fF]/.test(w.slice(1))) functions=true;
	}
	if (functions) { if(exportIt || unexport || remove) state.uncertain=true; return; }
	if (print && /^(?:declare|typeset|local)$/.test(head)) return;
	for (const w of words.slice(i)) {
		const k=w.split("=")[0]; if (!name.test(k)) {state.uncertain=true;continue;}
		if (remove) { if(state.readonly[k]) {state.uncertain=true;continue;} state.vars[k]=null;state.exported[k]=null;state.exportFlags[k]=false;state.explicitExports[k]=false; if(k === "PATH") state.uncertain=true; continue;}
		assign(w,exportIt);
		if (/^(?:declare|typeset|local)$/.test(head) && w.includes("=")) markUnknown(k);
		if(unexport) {state.exported[k]=null;state.exportFlags[k]=false;state.explicitExports[k]=false;} if(readonly) state.readonly[k]=true;
	}
}

function shellValue(state,k) { return Object.hasOwn(state.vars,k) ? state.vars[k] ?? "" : process.env[k] ?? "$unknown"; }

function sourceFile(word, dir, root, dirKnown = true, shellPath = process.env.PATH) {
	if (!word || /[$`]/.test(word)) return null;
	if (word.includes("/")) return resolvePathWord(word,dir,root,dirKnown);
	if (shellPath === undefined || /[$`]/.test(shellPath)) return null;
	for (const part of new Set(shellPath.split(":"))) {
		const base=resolvePathWord(part || ".",dir,root,dirKnown); if(!base) return null;
		const file=path.join(base,word);
		try { if(require("fs").statSync(file).isFile()) return file; } catch {}
	}
	return resolvePathWord(word,dir,root,dirKnown);
}

const MULTICALL_BINARIES = ["busybox", "toybox"];
const ARGV_WRAPPERS = new Set(["sudo", "doas", "nohup", "time", "env", "exec", "command", "stdbuf", "nice", "ionice", "setsid", "chronic", "caffeinate", "systemd-run", "xargs", "timeout", "flock", "unbuffer", "builtin", ...MULTICALL_BINARIES]);
const VALUE_OPTS = {
	timeout: /^(?:-s|--signal|-k|--kill-after)$/,
	time: /^(?:-f|--format|-o|--output)$/,
	flock: /^(?:-w|--wait|--timeout|-E|--conflict-exit-code)$/,
	"systemd-run": /^(?:-u|--unit|-p|--property|-E|--setenv|-M|--machine|--slice|--description|--working-directory|-d|--uid|--gid|--nice|--on-calendar|--on-active)$/,
	sudo: /^(?:-u|--user|-U|--other-user|-g|--group|-C|-D|--chdir|-h|--host|-p|--prompt|-r|-t)$/,
	doas: /^(?:-u|-C)$/,
	nice: /^(?:-n|--adjustment)$/,
	ionice: /^(?:-c|-n|-p|-t|--class|--classdata)$/,
	stdbuf: /^(?:-i|-o|-e)$/,
	xargs: /^(?:-I|-L|-n|-P|-d|-s|-a|-E|--max-args|--max-procs|--delimiter|--arg-file)$/,
	env: /^(?:-u|--unset|-C|--chdir)$/,
};
const SHELL_NAMES = ["bash", "rbash", "sh", "ash", "hush", "dash", "zsh", "ksh", "mksh", "pdksh", "oksh", "loksh", "yash", "posh", "fish"];
const SHELL_ALT = SHELL_NAMES.join("|");
const SHELLS = new RegExp(`(?:^|/)(?:${SHELL_ALT})$`);

/**
 * 셸을 부른 인자를 bash 문법대로 읽는다(설계 검수 14회차 1번: "bash -euo pipefail ./deploy.sh prod" 에서 pipefail 을 스크립트로,
 * "bash -e ./deploy.sh" 의 -e 를 node -e 같은 코드 옵션으로 읽어 두 관문이 스크립트를 보지 못했다). 네 곳이 이 한 곳을 쓴다.
 * -o·+o·-O·+O·--rcfile·--init-file 은 값을 받고, -c 가 있으면 첫 피연산자가 명령 글, 없으면 첫 피연산자가 스크립트다.
 * 리다이렉션(< f, 2>/dev/null)은 피연산자가 아니다. 돌려주는 값: { command, script, readsStdin } — command·script 는 argv 의 자리(없으면 -1),
 * readsStdin 은 -s 로 표준 입력을 프로그램으로 읽겠다고 밝힌 경우.
 */
// 리다이렉션은 한 부류다(설계 검수 15회차 1번: "bash << 'EOF'", "bash <<< '…'" 의 떨어진 대상을 스크립트로 읽었다).
// 연산자만 있는 낱말은 다음 낱말을 대상으로 먹고(2칸), 대상이 붙은 낱말은 1칸이다. <(…)·>(…) 는 리다이렉션이 아니라 파일 이름이다.
const REDIR_OP = /^(?:\d+|&)?(?:<<<|<<-|<<|<>|<&|>&|>\||>>|>|<)$/;
const REDIR_GLUED = /^(?:\d+|&)?(?:<<<|<<-?|<>|<&|>&|>\||>>|>|<)(?!\()\S/;
function redirectSpan(tokens, i) {
	const t = tokens[i];
	if (typeof t !== "string") return 0;
	if (REDIR_OP.test(t)) return 2;
	return REDIR_GLUED.test(t) ? 1 : 0;
}

/** 낱말이 표준입력(`-`, `/dev/stdin`)이나 파일 설명자 경로(`/dev/fd/N`, `/proc/.../fd/N`)를 가리키는지 판별한다. */
function fdStdinSpec(word, dir, root = "", dirKnown = true) {
	if (typeof word !== "string" || !word) return null;
	if (word === "-") return { fd: 0, kind: "dash", token: word };
	const matchPath = (p) => {
		const norm = path.posix.normalize(p.replace(/\\/g, "/"));
		if (norm === "/dev/stdin") return { fd: 0, kind: "dev-stdin", token: word };
		let m = norm.match(/^\/dev\/fd\/(\d+)$/);
		if (m) return { fd: Number(m[1]), kind: "dev-fd", token: word };
		m = norm.match(/^\/proc\/(?:self|thread-self|\d+)\/fd\/(\d+)$/);
		if (m) return { fd: Number(m[1]), kind: "proc-fd", token: word };
		return null;
	};
	if (word.startsWith("/")) {
		const hit = matchPath(word);
		if (hit) return hit;
	}
	if (dir !== undefined) {
		const resolved = resolvePathWord(word, dir, root, dirKnown);
		if (resolved) {
			const hit = matchPath(resolved);
			if (hit) return hit;
		}
	}
	return null;
}

function shellInvocation(argv, opts = {}) {
	let c = false, s = false, n = false, i = 1;
	let stdinTok = null;
	for (; i < argv.length; i++) {
		const a = argv[i];
		const r = c ? 0 : redirectSpan(argv, i); // -c 뒤 글은 따옴표가 벗겨져 "<…" 로 시작할 수 있다
		if (r) { i += r - 1; continue; }
		if (a === "-") { s = true; stdinTok = "-"; i++; break; } // "bash -" 는 표준 입력에서 프로그램을 읽는다
		if (a === "--") { i++; break; }
		if (/^--(?:rcfile|init-file)$/.test(a)) { i++; continue; }
		if (a.startsWith("--")) continue;
		if (/^[-+][A-Za-z]+$/.test(a)) {
			const letters = a.slice(1);
			if (a[0] === "-" && letters.includes("c")) c = true;
			if (a[0] === "-" && letters.includes("s")) { s = true; stdinTok = stdinTok || a; }
			if (a[0] === "-" && letters.includes("n")) n = true; // -n 은 문법 검사만 하고 실행하지 않는다
			i += (letters.match(/[oO]/g) || []).length;
			continue;
		}
		break;
	}
	while (!c && i < argv.length && redirectSpan(argv, i)) i += redirectSpan(argv, i);
	const first = i < argv.length ? i : -1;
	if (n) return { command: -1, script: -1, readsStdin: false, noexec: true, stdinFd: null, fdToken: null };
	if (!c && !s && first >= 0) {
		const fdSpec = fdStdinSpec(argv[first], opts.dir, opts.root, opts.dirKnown);
		if (fdSpec) {
			return { command: -1, script: -1, readsStdin: true, stdinFd: fdSpec.fd, fdToken: argv[first] };
		}
	}
	return {
		command: c ? first : -1,
		script: c || s ? -1 : first,
		readsStdin: !c && s,
		stdinFd: !c && s ? 0 : null,
		fdToken: !c && s ? stdinTok : null,
	};
}
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_PROGRAM_VARIABLE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\}|[0-9]+|[@*?#$!])$/;

// 명령 앞에 올 수 있는 bash 예약어는 감싸개처럼 벗기고, 반복·분기의 머리와 닫는 말은 명령이 아니다(설계 검수 12회차 1번:
// "for s in …; do agy …; done", "if npm test; then deploy.sh prod; fi", "! agy …", "{ deploy.sh prod; }" 가 첫 낱말만 보는 관문을 지나갔다).
const RESERVED_LEAD = new Set(["!", "{", "if", "then", "elif", "else", "do", "while", "until"]);
const NOT_COMMAND = new Set(["for", "select", "case", "fi", "done", "esac", "}", "in", ";;"]);

/** 예약어를 벗긴 절. 명령이 아니면 null. */
function stripReserved(tokens) {
	let t = tokens;
	while (t.length && RESERVED_LEAD.has(t[0])) t = t.slice(1);
	if (t.length === 0 || NOT_COMMAND.has(t[0])) return null;
	return t;
}

function subsOf(clause, depth, assigns) {
	return (clause.subs || []).flatMap((sub) => nested(sub, depth, assigns));
}

/** 훅이 모르는 tmux 창 디렉터리로 옮겨 가는 글. 뒤의 상대 경로는 풀리지 않는다(cd "$(…)" 와 같다). */
const PANE_DIR = `cd "$(tmux display-message -p '#{pane_current_path}')" && `;
// PANE_DIR 이 만든 디렉터리 묻기 절은 훅이 지어낸 것이다. 섞인 절 규칙에 넣지 않는다(설계 검수 25회차 3번: 검수 받은 agy 를 창에서 돌리는 흐름이 늘 막혔다).
function paneProbe(argv) {
	return (argv || []).join(" ") === "tmux display-message -p #{pane_current_path}";
}
/** tmux 가 argv 로 받은 낱말을 셸 글로 다시 적는다. */
function tmuxQuote(t) { return /^[A-Za-z0-9_@%+=:,./-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`; }

function nested(str, depth, assigns) {
	if (typeof str !== "string" || !str.trim() || depth > 4) return [];
	// 글로 넘긴 프로그램(bash -c, eval, tmux …)은 자기 셸에서 돈다. 그 안의 cd 는 밖으로 새지 않는다(설계 검수 18회차 2번).
	return shellClauses(str).flatMap((c) => [...subsOf(c, depth + 1, assigns), ...expandClause(c, depth + 1, assigns)]).map((x) => ({ ...x, nested: true }));
}

function expandClause(tokens, depth = 0, inherited = []) {
	const piped = !!tokens.piped;
	const heredocs = tokens.heredocs || [];
	const heredocFds = tokens.heredocFds || [];
	let t = tokens.slice();
	const assigns = inherited.slice();
	const out = [];
	const moved = [];
	const withOuterIo = (clauses) => {
		if (!clauses.length) return clauses;
		const first = clauses[0];
		clauses[0] = {
			...first,
			argv: moved.length ? [...first.argv, ...moved] : first.argv,
			piped: first.piped || piped,
			heredocs: first.heredocs && first.heredocs.length ? first.heredocs : heredocs,
			heredocFds: first.heredocFds && first.heredocFds.length ? first.heredocFds : heredocFds,
		};
		return clauses;
	};
	let envProgramVariable = false;
	for (let guard = 0; guard < 20 && t.length; guard++) {
		if (RESERVED_LEAD.has(t[0])) { t = t.slice(1); continue; }
		// 앞에 둔 리다이렉션("2>/dev/null agy …")은 명령 뒤로 옮긴다. 조회 판정이 대상 파일을 볼 수 있게 버리지 않는다.
		const r = redirectSpan(t, 0);
		if (r && t.length > r) { moved.push(...t.slice(0, r)); t = t.slice(r); continue; }
		if (NOT_COMMAND.has(t[0])) return out;
		if (ASSIGN.test(t[0])) { assigns.push(t[0]); t = t.slice(1); continue; }
		const w = path.basename(t[0]);
		if (!ARGV_WRAPPERS.has(w)) break;
		t = t.slice(1);
		while (t.length && t[0].startsWith("-")) {
			if (w === "command" && /^-[a-zA-Z]*[vV]/.test(t[0])) return out; // command -v 는 찾기만 하고 실행하지 않는다
			if (w === "flock" && /^(?:-c|--command)(?:=|$)/.test(t[0])) {
				const cmdStr = t[0].includes("=") ? t[0].slice(t[0].indexOf("=") + 1) : t[1];
				const restAfter = t[0].includes("=") ? t.slice(1) : t.slice(2);
				return [...out, ...withOuterIo(nested(restAfter.length ? `${cmdStr} ${restAfter.map(quoteArg).join(" ")}` : cmdStr, depth, assigns))];
			}
			if (w === "env" && /^(?:-S|--split-string)(?:=.+)?$/.test(t[0])) {
				const str = t[0] === "-S" || t[0] === "--split-string" ? t.slice(1).join(" ") : `${t[0].replace(/^(?:-S|--split-string)=?/, "")} ${t.slice(1).join(" ")}`.trim();
				return [...out, ...withOuterIo(nested(str, depth, assigns))];
			}
			t = t.slice(VALUE_OPTS[w] && VALUE_OPTS[w].test(t[0]) ? 2 : 1);
		}
		// timeout's first positional argument is always DURATION. It may be a variable or
		// another non-numeric value; treating it as argv[0] hides the real command.
		if (w === "timeout" && t.length) t = t.slice(1);
		if (w === "flock" && t.length) {
			t = t.slice(1); // lock file or fd
			while (t.length && t[0].startsWith("-")) {
				if (/^(?:-c|--command)(?:=|$)/.test(t[0])) {
					const cmdStr = t[0].includes("=") ? t[0].slice(t[0].indexOf("=") + 1) : t[1];
					const restAfter = t[0].includes("=") ? t.slice(1) : t.slice(2);
					return [...out, ...withOuterIo(nested(restAfter.length ? `${cmdStr} ${restAfter.map(quoteArg).join(" ")}` : cmdStr, depth, assigns))];
				}
				t = t.slice(VALUE_OPTS.flock.test(t[0]) ? 2 : 1);
			}
		}
		if (w === "env") {
			while (t.length && ASSIGN.test(t[0])) { assigns.push(t[0]); t = t.slice(1); }
			// An unexpanded variable after env may be either an assignment or the program.
			// Keep it opaque; guessing would let the wrapper hide a command.
			envProgramVariable = ENV_PROGRAM_VARIABLE.test(t[0] || "");
		}
	}
	if (t.length === 0) return out;
	if (moved.length) t = [...t, ...moved];
	out.push({ argv: t, assigns, piped, heredocs, heredocFds, ...(envProgramVariable ? { envProgramVariable: true } : {}) });
	const head = path.basename(t[0]);
	const rest = t.slice(1);
	if (SHELLS.test(t[0])) {
		const c = shellInvocation(t).command;
		if (c >= 0) out.push(...nested(t[c], depth, assigns));
	} else if (head === "eval") {
		out.push(...nested(rest.join(" "), depth, assigns));
	} else if (head === "su" || head === "script" || head === "runuser") {
		const c = rest.findIndex((a) => /^(?:-c|-qc|-cq|--command)$/.test(a) || /^--command=/.test(a));
		if (c >= 0) out.push(...nested(rest[c].startsWith("--command=") ? rest[c].slice(10) : rest[c + 1], depth, assigns));
	} else if (head === "tmux") {
		// tmux 는 명령 뒤의 위치 인자를 셸 명령으로 돌린다(설계 검수 20회차 1번). 어느 옵션이 값을 받는지 짐작하지 않는다(21회차 2번).
		// 마지막 위치 인자는 셸 명령 글로, 옵션이 아닌 낱말에서 시작하는 뒤쪽 낱말들은 모두 argv 로 읽는다. 짐작으로 만든 절(guess)은
		// 에이전트·운영 관문만 보고, 섞인 절 규칙과 쓰기 판단에는 넣지 않는다(세션 이름 같은 값이 명령 자리에 오기 때문).
		let i = 0;
		while (i < rest.length && rest[i].startsWith("-")) {
			if (rest[i] === "-c" && rest[i + 1] !== undefined) out.push(...nested(rest[i + 1], depth, assigns));
			i += /^-[cfLST]$/.test(rest[i]) ? 2 : 1;
		}
		const paneNested = (text, d, a) => nested(PANE_DIR + text, d, a);
		// tmux 는 ; 로 여러 명령을 한 번에 받는다(new-session … \; send-keys …). 조각마다 따로 읽는다(설계 검수 26회차 2번).
		const segs = [[]];
		for (const w of rest.slice(i)) {
			if (w === ";" || w === "\\;") segs.push([]);
			else if (/[^\\];$/.test(w)) { segs[segs.length - 1].push(w.slice(0, -1)); segs.push([]); }
			else segs[segs.length - 1].push(w);
		}
		// tmux 는 모호하지 않은 앞머리(new-w, send-k)도 명령 이름으로 받는다.
		const TMUX_FULL = ["new-session", "new-window", "split-window", "respawn-pane", "respawn-window", "run-shell", "display-popup", "send-keys", "if-shell", "pipe-pane"];
		for (const seg of segs) {
			const full = seg[0] && seg[0].length >= 3 && !/^(?:new|neww|splitw|respawnp|respawnw|run|popup|send|if|pipep)$/.test(seg[0]) ? TMUX_FULL.filter((x) => x.startsWith(seg[0])) : [];
			if (full.length === 1) seg[0] = full[0];
			if (!/^(?:new-session|new|new-window|neww|split-window|splitw|respawn-pane|respawnp|respawn-window|respawnw|run-shell|run|display-popup|popup|send-keys|send|if-shell|if|pipe-pane|pipep)$/.test(seg[0] || "")) continue;
			let words = seg.slice(1);
			if (/^(?:send-keys|send)$/.test(seg[0])) {
				// 치는 글은 줄 끝 키(Enter, C-m, C-j, KPEnter)마다 한 줄씩 셸이 돌린다. -t·-T·-N 값은 글이 아니다(설계 검수 25회차 2번).
				// tmux 는 낱말들을 빈칸 없이 이어 친다. Space 키는 빈칸이다. -l 이면 키 이름도 글자 그대로다.
				// getopt 처럼 읽는다. 옵션은 첫 글 낱말 앞에만 오고, -- 는 옵션 끝이며, 값을 받는 글자(t, T, N, c)는 같은 낱말의 나머지나 다음 낱말을 값으로 받는다(설계 검수 26회차 1번).
				let literal = false;
				let k = 0;
				while (k < words.length) {
					const a = words[k];
					if (a === "--") { k++; break; }
					if (!/^-[A-Za-z]/.test(a)) break;
					for (let q = 1; q < a.length; q++) {
						if (a[q] === "l") literal = true;
						if (/[tTNc]/.test(a[q])) { if (q === a.length - 1) k++; break; }
					}
					k++;
				}
				const lines = [];
				let line = "";
				for (; k < words.length; k++) {
					const a = words[k];
					if (!literal && /^(?:enter|c-m|c-j|kpenter|\^m|\^j)$/i.test(a)) { lines.push(line); line = ""; continue; }
					if (!literal && /^space$/i.test(a)) { line += " "; continue; }
					if (!literal && /^(?:C-\S|M-\S|Escape|Tab|BSpace|KP\w+|F\d+|Up|Down|Left|Right|Home|End|PageUp|PageDown|PPage|NPage|Insert|Delete|DC|IC|BTab)$/i.test(a)) continue;
					line += a;
				}
				lines.push(line);
				for (const l of lines.flatMap((x) => x.split("\n"))) if (l.trim()) out.push(...paneNested(l, depth, assigns).map((x) => ({ ...x, guess: true })));
				words = [];
			}
			// 새 창·분할의 시작 디렉터리(-c dir)는 그 명령 글 앞의 cd 로 읽는다(설계 검수 22회차 2번).
			const cdir = /^(?:new-session|new|new-window|neww|split-window|splitw|respawn-pane|respawnp|respawn-window|respawnw)$/.test(seg[0]) ? words.findIndex((a, k) => a === "-c" && k + 1 < words.length - 1) : -1;
			// 이미 있는 창에 치는 글(send-keys)과 -c 없는 respawn, #{…} 형식의 -c 는 그 창의 디렉터리에서 돈다. 훅은 그 디렉터리를 모른다(설계 검수 24회차 3번).
			const paneRun = /^(?:send-keys|send|respawn-pane|respawnp|respawn-window|respawnw)$/.test(seg[0]);
			const startDir = cdir >= 0 && !words[cdir + 1].includes("#{") ? `cd '${words[cdir + 1].replace(/'/g, `'\\''`)}' && ` : cdir >= 0 || paneRun ? PANE_DIR : "";
			for (let j = 0; j < words.length; j++) {
				if (words[j].startsWith("-")) continue;
				// 마지막 낱말이 빈칸을 품은 셸 명령 글이면 짐작이 아니다. 쓰고 곧바로 실행하기, 섞인 절 규칙을 그대로 받는다(설계 검수 22회차 1번).
				// 한 낱말뿐인 마지막 값(세션 이름일 수 있음)만 짐작으로 둔다.
				if (j === words.length - 1) out.push(...nested(startDir + words[j], depth, assigns).map((x) => (/\s/.test(words[j].trim()) && !paneProbe(x.argv) ? x : { ...x, guess: true })));
				// 여러 낱말로 준 명령도 시작 디렉터리에서 돈다(설계 검수 23회차 2번: tmux new -c 작업트리 bash run.sh).
				else if (startDir) out.push(...nested(startDir + words.slice(j).map(tmuxQuote).join(" "), depth, assigns).map((x) => ({ ...x, guess: true })));
				else out.push(...expandClause(words.slice(j), depth + 1, assigns).map((x) => ({ ...x, guess: true })));
			}
		}
	} else if (head === "watch") {
		// watch 는 옵션 뒤 위치 인자를 이어 붙여 sh -c 로 돌린다(-x 면 그대로 실행).
		let i = 0;
		while (i < rest.length && rest[i].startsWith("-")) i += /^(?:-n|--interval|-q|--equexit)$/.test(rest[i]) ? 2 : 1;
		if (i < rest.length) out.push(...nested(rest.slice(i).join(" "), depth, assigns));
	} else if (head === "screen") {
		let i = 0;
		while (i < rest.length && rest[i].startsWith("-")) i += /^-(?:S|c|t|Logfile)$/.test(rest[i]) ? 2 : 1;
		if (i < rest.length) out.push(...expandClause(rest.slice(i), depth + 1, assigns));
	}
	return out;
}

/**
 * The program a shell reads from stdin (design review round 11 hole 2: "bash <<'EOF'", "bash -s < f.sh",
 * "cat f.sh | bash" hid a deploy or agent run). undefined = the shell does not read a program from stdin
 * here (it runs -c text or a script file, or has no stdin source); null = it does, but the hook cannot read it.
 */
const READ_SUB = /^(?:\$\(\s*(?:cat\s+([^\s()<>|;&$`'"]+)|<\s*([^\s()<>|;&$`'"]+))\s*\)|`\s*cat\s+([^\s()<>|;&$`'"]+)\s*`|<\(\s*cat\s+([^\s()<>|;&$`'"]+)\s*\))$/;

function extractReadSubFile(word) {
	if (typeof word !== "string") return null;
	const m = word.match(READ_SUB);
	if (m) return { file: m[1] || m[2] || m[3] || m[4], isProcSub: word.startsWith("<(") };
	const proc = word.match(/^<\(\s*(?:cat(?:\s+--)?|<)\s+(?:'([^'$`\n]+)'|"([^"$`\n]+)"|([^\s()<>|;&$`'"]+))\s*\)$/);
	if (proc) return { file: proc[1] || proc[2] || proc[3], isProcSub: true };
	return null;
}

function readLocal(file, dir) {
	if (!file || /[$`*?]/.test(file)) return null;
	try {
		const p = path.resolve(dir || "/", file.replace(/^~(?=\/|$)/, require("os").homedir()));
		return readCachedText(p, 1024 * 1024, true);
	} catch {
		return null;
	}
}

function readInputFileWord(rawTarget, dir, root = "", dirKnown = true, written = null) {
	const sub = extractReadSubFile(rawTarget);
	if (sub) {
		const resolvedSub = resolvePathWord(sub.file, dir, root, dirKnown);
		if (!resolvedSub) return { ok: false, resolved: null, target: sub.file, reason: "unresolved-proc-sub" };
		return readInputFileWord(resolvedSub, "/", root, true, written);
	}
	if (!rawTarget || /^(?:\$\(|\`|<\(|>\()/.test(rawTarget) || /[*?]/.test(rawTarget)) {
		return { ok: false, resolved: null, target: rawTarget || "", reason: "dynamic-redirect" };
	}
	const resolved = resolvePathWord(rawTarget, dir, root, dirKnown);
	if (!resolved) return { ok: false, resolved: null, target: rawTarget, reason: "unresolved-redirect" };
	const fdSpec = fdStdinSpec(resolved, "/", root, true);
	if (fdSpec) return { ok: false, resolved, fdSpec, target: resolved, reason: "fd-target" };
	if (written && written.has(resolved)) {
		const val = written.get(resolved);
		if (val === null) return { ok: false, resolved, target: resolved, reason: "unknown-written-file" };
		return { ok: true, resolved, text: val };
	}
	const text = readLocal(resolved, "/");
	if (text === null) return { ok: false, resolved, target: resolved, reason: "unreadable-file" };
	return { ok: true, resolved, text };
}

function unescapeSimpleEscapes(s) {
	return s.replace(/\\(n|t|\\)/g, (_, k) => (k === "n" ? "\n" : k === "t" ? "\t" : "\\"));
}

const UNSAFE_PIPE_ESCAPE = /\\(?:x[0-9a-fA-F]|[0-7]{1,3}|u[0-9a-fA-F]|U[0-9a-fA-F]|c)/;

function formatPrintfPipe(args) {
	if (!args.length) return null;
	let i = 0;
	while (i < args.length && args[i] === "--") { i++; break; }
	if (args[i] === "-v" || /^-[a-zA-Z]*v/.test(args[i] || "")) return null;
	const fmt = args[i];
	if (fmt === undefined) return null;
	const rest = args.slice(i + 1);
	if (UNSAFE_PIPE_ESCAPE.test(fmt)) return null;
	// %s·%b·%% 와 단순 \n·\t 외의 형식 지정자나 이스케이프는 안전하게 복원할 수 없으므로 fail-closed 처리한다.
	const stripped = fmt.replace(/%%/g, "").replace(/%[sb]/g, "");
	if (/%/.test(stripped)) return null;
	const tokens = fmt.match(/%%|%[sb]|[^%]+/g) || [""];
	const specCount = tokens.filter((t) => t === "%s" || t === "%b").length;
	if (specCount === 0) return rest.length ? null : unescapeSimpleEscapes(fmt.replace(/%%/g, "%"));
	let argIdx = 0;
	const parts = [];
	for (let cycle = 0; cycle < 8; cycle++) {
		for (const tok of tokens) {
			if (tok === "%%") { parts.push("%"); continue; }
			if (tok === "%s") { parts.push(argIdx < rest.length ? rest[argIdx++] : ""); continue; }
			if (tok === "%b") {
				const v = argIdx < rest.length ? rest[argIdx++] : "";
				if (UNSAFE_PIPE_ESCAPE.test(v)) return null;
				parts.push(unescapeSimpleEscapes(v));
				continue;
			}
			parts.push(unescapeSimpleEscapes(tok));
		}
		if (argIdx >= rest.length) break;
		if (cycle === 7) return null;
	}
	return parts.join("");
}

function formatCatOrPrintPipe(prev, root, written) {
	if (!prev || !Array.isArray(prev.argv) || !prev.argv.length) {
		return { program: null, sourceFiles: [], reason: "unknown-pipe-producer" };
	}
	const head = path.basename(prev.argv[0]);
	const args = prev.argv.slice(1);
	if (head === "cat") {
		const files = [];
		let dashDash = false;
		for (let i = 0; i < args.length; i++) {
			const span = redirectSpan(args, i);
			if (span) {
				const m = args[i].match(/^(\d+|&)?(<<<|<<-|<<|<>|<&|>&|>\||>>|>|<)(.*)$/);
				const op = m && m[2];
				const rhs = span === 2 ? args[i + 1] : (m ? m[3] : "");
				if (op && /^(?:>|>>|>\||>&)$/.test(op) && (m[1] === "2" || rhs === "/dev/null" || /^&?\d+-?$/.test(rhs))) {
					i += span - 1; continue;
				}
				if (op === "<" && (!m[1] || m[1] === "0")) {
					files.push(rhs); i += span - 1; continue;
				}
				return { program: null, sourceFiles: [], reason: "unverified-cat-redirect" };
			}
			if (!dashDash && args[i] === "--") { dashDash = true; continue; }
			if (!dashDash && args[i].startsWith("-")) return { program: null, sourceFiles: [], reason: `unsupported-cat-flag:${args[i]}` };
			files.push(args[i]);
		}
		if (!files.length) return { program: null, sourceFiles: [], reason: "cat-without-files" };
		const parts = [];
		const sourceFiles = [];
		for (const f of files) {
			const res = readInputFileWord(f, prev.dir, root, prev.dirKnown !== false, written);
			if (res.resolved) sourceFiles.push(res.resolved);
			if (!res.ok) return { program: null, sourceFiles, unresolvedTarget: res.target, reason: res.reason };
			parts.push(res.text);
		}
		return { program: parts.join("\n"), sourceFiles };
	}
	if (head === "echo" || head === "printf") {
		const cleanArgs = [];
		for (let i = 0; i < args.length; i++) {
			const span = redirectSpan(args, i);
			if (span) {
				const m = args[i].match(/^(\d+|&)?(<<<|<<-|<<|<>|<&|>&|>\||>>|>|<)(.*)$/);
				const rhs = span === 2 ? args[i + 1] : (m ? m[3] : "");
				if (m && /^(?:>|>>|>\||>&)$/.test(m[2]) && (m[1] === "2" || rhs === "/dev/null" || /^&?\d+-?$/.test(rhs))) {
					i += span - 1; continue;
				}
				return { program: null, sourceFiles: [], reason: "unverified-print-redirect" };
			}
			cleanArgs.push(args[i]);
		}
		if (head === "echo") {
			let interpret = false;
			const words = [];
			let stopFlags = false;
			for (const a of cleanArgs) {
				if (!stopFlags && /^-[neE]+$/.test(a)) { if (a.includes("e")) interpret = true; continue; }
				stopFlags = true;
				words.push(a);
			}
			const joined = words.join(" ");
			if (interpret && UNSAFE_PIPE_ESCAPE.test(joined)) return { program: null, sourceFiles: [], reason: "unsafe-echo-escape" };
			return { program: joined.replace(/\\n/g, "\n"), sourceFiles: [] };
		}
		const formatted = formatPrintfPipe(cleanArgs);
		return formatted === null ? { program: null, sourceFiles: [], reason: "unverified-printf" } : { program: formatted, sourceFiles: [] };
	}
	return { program: null, sourceFiles: [], reason: `unverified-pipe:${head}` };
}

/** 셸 또는 source 가 표준입력·파일 설명자에서 읽을 프로그램 글과 원본 파일 경로를 구한다. */
function stdinProgramInfo(e, prev, dir, root = "", dirKnown = true, written = null, stFds = null) {
	const argv = Array.isArray(e?.argv) ? e.argv : [];
	if (!argv.length) return { program: undefined, sourceFiles: [] };
	const head = path.basename(argv[0] || "");
	const isShell = SHELLS.test(argv[0]);
	const isSource = head === "source" || head === ".";
	if (!isShell && !isSource) return { program: undefined, sourceFiles: [] };

	let targetFd = 0;
	let explicitRequired = false;
	let fdToken = argv[0];
	if (isShell) {
		const inv = shellInvocation(argv, { dir, root, dirKnown });
		if (inv.command >= 0 || inv.script >= 0 || inv.noexec) return { program: undefined, sourceFiles: [] };
		targetFd = inv.stdinFd ?? 0;
		explicitRequired = !!inv.readsStdin;
		if (inv.fdToken) fdToken = inv.fdToken;
	} else {
		const idx = sourceTargetIndex(argv);
		const spec = idx >= 0 ? fdStdinSpec(argv[idx], dir, root, dirKnown) : null;
		if (!spec) return { program: undefined, sourceFiles: [] };
		targetFd = spec.fd;
		explicitRequired = true;
		fdToken = spec.token;
	}

	const rest = argv.slice(1);
	const heredocs = Array.isArray(e.heredocs) ? e.heredocs : [];
	const heredocFds = Array.isArray(e.heredocFds) && e.heredocFds.length === heredocs.length ? e.heredocFds : heredocs.map(() => 0);
	const hdByFd = new Map();
	for (let hi = 0; hi < heredocs.length; hi++) {
		const fd = heredocFds[hi] ?? 0;
		if (!hdByFd.has(fd)) hdByFd.set(fd, []);
		hdByFd.get(fd).push(heredocs[hi]);
	}

	// 절 안의 리다이렉션을 왼->오른쪽 순서로 스캔(같은 FD 는 마지막 리다이렉션이 이긴다).
	const lastInputByFd = new Map();
	for (let i = 0; i < rest.length; i++) {
		const span = redirectSpan(rest, i);
		if (!span) continue;
		const m = rest[i].match(/^(\d+|&)?(<<<|<<-|<<|<>|<&|>&|>\||>>|>|<)(.*)$/);
		if (m) {
			const rfd = /^\d+$/.test(m[1] || "") ? Number(m[1]) : 0;
			const op = m[2];
			const rhs = span === 2 ? (rest[i + 1] ?? "") : m[3];
			if (op === "<<" || op === "<<-") {
				const q = hdByFd.get(rfd);
				lastInputByFd.set(rfd, { kind: "heredoc", body: q && q.length ? q.shift() : (heredocs.length === 1 && rfd === 0 ? heredocs[0] : null) });
			} else if (op === "<<<") {
				lastInputByFd.set(rfd, { kind: "herestring", body: rhs, rawEmpty: span === 2 && rest[i + 1] === undefined });
			} else if (op === "<" || op === "<>") {
				lastInputByFd.set(rfd, { kind: "redirect", rhs });
			} else if (op === "<&") {
				lastInputByFd.set(rfd, { kind: "dup", target: rhs });
			}
		}
		i += span - 1;
	}
	// moved 등으로 heredoc 토큰이 유실되었으나 heredocs가 해당 FD에 남아 있으면 보전한다.
	for (const [hfd, list] of hdByFd.entries()) {
		if (!lastInputByFd.has(hfd) && list.length) lastInputByFd.set(hfd, { kind: "heredoc", body: list[list.length - 1] });
	}

	const resolveFd = (fd, requiredHere, seenFds) => {
		if (seenFds.has(fd)) return { program: null, sourceFiles: [], reason: "cyclic-fd" };
		seenFds.add(fd);
		const redir = lastInputByFd.get(fd);
		if (redir) {
			if (redir.kind === "heredoc") {
				return redir.body === null ? { program: null, sourceFiles: [], reason: "missing-heredoc" } : { program: redir.body, sourceFiles: [] };
			}
			if (redir.kind === "herestring") {
				return redir.rawEmpty ? { program: null, sourceFiles: [], reason: "empty-herestring" } : { program: redir.body, sourceFiles: [] };
			}
			if (redir.kind === "dup") {
				if (redir.target === "-") return { program: null, sourceFiles: [], reason: "closed-fd" };
				if (/^\d+$/.test(redir.target)) return resolveFd(Number(redir.target), true, seenFds);
				return { program: null, sourceFiles: [], reason: `unknown-dup-fd:${redir.target}` };
			}
			if (redir.kind === "redirect") {
				const res = readInputFileWord(redir.rhs, dir, root, dirKnown, written);
				if (res.fdSpec) {
					if (res.fdSpec.fd !== fd) return resolveFd(res.fdSpec.fd, true, seenFds);
					return { program: null, sourceFiles: [], unresolvedTarget: res.target, reason: "self-fd-redirect" };
				}
				if (!res.ok) return { program: null, sourceFiles: res.resolved ? [res.resolved] : [], unresolvedTarget: res.target, reason: res.reason };
				return { program: res.text, sourceFiles: res.resolved ? [res.resolved] : [] };
			}
		}
		if (fd === 0 && e.piped) return formatCatOrPrintPipe(prev, root, written);
		if (stFds && stFds.has(fd)) return stFds.get(fd);
		if (requiredHere || fd > 0) return { program: null, sourceFiles: [], unresolvedTarget: fdToken, reason: `unbacked-stdin:${fdToken}` };
		return { program: undefined, sourceFiles: [] };
	};

	return resolveFd(targetFd, explicitRequired, new Set());
}

function stdinProgram(e, prev, dir, root = "", dirKnown = true, written = null, stFds = null) {
	return stdinProgramInfo(e, prev, dir, root, dirKnown, written, stFds).program;
}

function quoteArg(a) {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/**
 * 이 명령 안에서 변수 name 에 준 값들(값 안의 변수도 푼 것). undefined = 이 명령에서 정한 적 없음(프로필 환경의 $HOME 등),
 * null = 훅이 값을 알 수 없음. 변수 이름이 낱말 하나로 서 있는 곳(대입, read·for·export·local 등의 대상)만 센다.
 * "-E", "/S/", "x.PY" 는 변수가 아니다.
 */
/**
 * 글 안의 대입 자리마다 준 값(이름 → 값 목록). 글마다 한 번만 훑는다. 변수마다 스크립트 전체를 다시 훑어
 * 큰 스크립트에서 훅이 수십 초 걸렸다(구현 검수 2번). 돌려준 값은 읽기만 한다.
 */
function assignmentsOf(root) {
	const assigned = analysisCache?.assigned;
	if (assigned?.has(root)) return assigned.get(root);
	const map = new Map();
	const walk = (text, level) => {
		for (const c of shellClauses(text)) {
			// 대입 자리: 절 앞머리, export·local·declare·readonly·typeset·env 의 인자. 다른 인자의 "NAME=…" 은 글이다.
			let i = 0;
			while (i < c.length && RESERVED_LEAD.has(c[i])) i++;
			const at = (t) => {
				const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t);
				if (!m) return;
				if (!map.has(m[1])) map.set(m[1], []);
				map.get(m[1]).push(t.slice(m[0].length));
			};
			while (i < c.length && ASSIGN.test(c[i])) at(c[i++]);
			if (/^(?:export|local|declare|readonly|typeset|env)$/.test(c[i] || "")) for (const t of c.slice(i + 1)) at(t);
			for (const t of c) if (level < 3 && /\s/.test(t)) walk(t, level + 1); // bash -c '…' 처럼 글로 넘긴 명령 안의 대입
			if (level < 3) for (const h of [...(c.subs || []), ...(c.heredocs || [])]) walk(h, level + 1); // $(…)·bash <<EOF 본문 안의 대입
		}
	};
	walk(root, 0);
	if (assigned) assigned.set(root, map);
	return map;
}
// This computation depends only on source text, variable name and expansion
// depth. The guard resolves the same words repeatedly while inspecting files.
let literalValuesCache = null;
let analysisCache = null;
function withLiteralValuesCache(fn) {
	if (literalValuesCache) return fn();
	literalValuesCache = new Map();
	analysisCache = { files: new Map(), clauses: new Map(), assigned: new Map() };
	try { return fn(); } finally { literalValuesCache = null; analysisCache = null; }
}

// A cache exists only inside the outermost synchronous analysis.  Stat on each
// access so replacements and ordinary edits receive a different identity.
function readCachedText(file, maxSize = Infinity, regularOnly = true) {
	const fs = require("fs");
	const st = fs.statSync(file);
	if (st.size > maxSize || (regularOnly && !st.isFile())) return null;
	if (!st.isFile()) return fs.readFileSync(file, "utf8");
	if (!analysisCache) return fs.readFileSync(file, "utf8");
	let real;
	try { real = fs.realpathSync(file); } catch { return fs.readFileSync(file, "utf8"); }
	const fingerprint = (resolved, stat) => JSON.stringify([resolved, stat.size, stat.mtimeMs, stat.ino, stat.dev, stat.ctimeMs]);
	const key = fingerprint(real, st);
	if (analysisCache.files.has(key)) return analysisCache.files.get(key);
	const text = fs.readFileSync(file, "utf8");
	// A changed link or file during the read must never seed another lookup.
	try {
		if (key === fingerprint(fs.realpathSync(file), fs.statSync(file))) analysisCache.files.set(key, text);
	} catch {}
	return text;
}
function literalValues(name, root, depth = 0) {
	if (!literalValuesCache) return computeLiteralValues(name, root, depth);
	root = String(root);
	if (!literalValuesCache.has(root)) {
		if (literalValuesCache.size >= 64) literalValuesCache.clear();
		literalValuesCache.set(root, new Map());
	}
	const cache = literalValuesCache.get(root), key = `${depth}:${name}`;
	if (!cache.has(key)) cache.set(key, computeLiteralValues(name, root, depth));
	return cache.get(key);
}
function computeLiteralValues(name, root, depth = 0) {
	const occ = [...String(root).matchAll(new RegExp(`(?:^|[\\s;&|()'"])${name}(?=$|[\\s;&|()'"]|(\\+?=))`, "g"))];
	if (occ.length === 0) return undefined;
	if (occ.some((m) => m[1] !== "=")) return null; // read·for·export·+= 등 훅이 값을 알 수 없는 방법으로 정함
	const values = assignmentsOf(String(root)).get(name) || [];
	if (values.length < occ.filter((m) => m[1] === "=").length) return null; // 훅이 자리를 찾지 못한 대입
	const out = [];
	for (const v of new Set(values)) {
		const r = expandRefs(v, root, depth + 1);
		if (r === null) return null;
		out.push(...r);
	}
	return [...new Set(out)];
}

/**
 * 글 안의 $NAME·${NAME} 을 이 명령 안에서 준 값으로 푼 글들(Q=$D/../q.sh, ./deploy/$V/deploy.sh). 명령 밖 환경 변수는 그대로 둔다.
 * 명령 치환, ${X:-y} 같은 확장, $1·$@ 같은 특수 변수가 있거나 값을 알 수 없으면 null.
 */
function expandRefs(v, root, depth) {
	if (depth > 3 || /`|\$\(|\$\{(?![A-Za-z_][A-Za-z0-9_]*\})|\$(?![A-Za-z_{])/.test(v)) return null;
	let outs = [""];
	let last = 0;
	for (const m of v.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
		const vals = literalValues(m[1] || m[2], root, depth);
		if (vals === null) return null;
		const lit = v.slice(last, m.index);
		last = m.index + m[0].length;
		outs = outs.flatMap((o) => (vals === undefined ? [m[0]] : vals).map((x) => o + lit + x));
		if (outs.length > 16) return null;
	}
	return outs.map((o) => o + v.slice(last));
}

/**
 * 실행 중에 정해지는 낱말이 가리키는 것. undefined = 정해진 글자이거나 명령 밖 환경 변수, null = 알 수 없음,
 * { program } = <(cat F) 가 넘기는 파일 글, { words } = $(cat F) 의 글이나 변수를 푼 글들(낱말로 쪼개져 쓰임).
 */
function dynamicWord(word, root, dir, dirKnown = true, written = null) {
	if (typeof word !== "string") return undefined;
	if (/^(?:\$\(|`|<\()/.test(word)) {
		const sub = extractReadSubFile(word);
		if (!sub) return null;
		const resolved = resolvePathWord(sub.file, dir, root, dirKnown);
		if (!resolved) return null;
		const res = readInputFileWord(resolved, "/", root, true, written);
		if (!res.ok) return null;
		return sub.isProcSub ? { program: res.text, sourceFiles: [res.resolved] } : { words: [res.text] };
	}
	if (!word.includes("$")) return undefined;
	const words = expandRefs(word, root, 0);
	// 변수로 시작하는 낱말만 알 수 없을 때 막는다. 가운데의 변수는 풀 수 있을 때만 푼다(설계 검수 13회차 2번의 범위).
	if (words === null) return word.startsWith("$") ? null : undefined;
	if (words.length === 1 && words[0] === word) return undefined;
	return { words };
}

/**
 * 스크립트 경로와 cd 대상 낱말을 절대 경로로 푼다(설계 검수 17회차 2번). 명령 안에서 글자 그대로 정한 변수를 먼저 쓰고,
 * 명령이 정하지 않은 변수($HOME 등)는 훅의 환경에서 푼다(훅은 세션과 같은 프로필로 돈다). 못 풀면 null.
 * dirKnown 이 false 면(앞의 cd 대상을 몰랐으면) 상대 경로도 null 이다.
 */
function resolvePathWord(word, dir, root, dirKnown = true) {
	if (typeof word !== "string" || !word) return null;
	let w = word;
	if (w.includes("$")) {
		const ex = expandRefs(w, root || "", 0);
		if (!ex || ex.length !== 1) return null;
		w = ex[0];
	}
	if (/`|\$\(/.test(w)) return null;
	w = w.replace(/^~(?=\/|$)/, require("os").homedir());
	let missing = false;
	w = w.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a, b) => {
		// $PWD 는 명령이 따라간 디렉터리다. $OLDPWD 는 훅이 모른다(설계 검수 18회차 1번).
		const v = (a || b) === "PWD" ? (dirKnown ? dir : undefined) : (a || b) === "OLDPWD" ? undefined : process.env[a || b];
		if (v === undefined) missing = true;
		return v === undefined ? "" : v;
	});
	if (missing || w.includes("$")) return null;
	if (!path.isAbsolute(w) && !dirKnown) return null;
	return path.resolve(dir || "/", w);
}

/** 이 절이 실행하는 셸 스크립트 파일 자리의 낱말. 없으면 undefined. */
function scriptWord(argv, dir, root, dirKnown, afterWriters) {
	const head = path.basename(argv[0]);
	if (SHELLS.test(argv[0])) {
		const at = shellInvocation(argv, { dir, root, dirKnown }).script;
		return at >= 0 ? argv[at] : undefined;
	}
	if (head === "source" || head === ".") {
		const target = argv[sourceTargetIndex(argv)];
		return target && fdStdinSpec(target, dir, root, dirKnown) ? undefined : target;
	}
	if (argv[0].includes("/") && /\.(?:sh|bash)$/.test(argv[0])) return argv[0];
	// 확장자 없는 파일을 경로로 실행해도, 셸 shebang 이거나 shebang 없는 글 파일이면 셸이 돌리는 스크립트다(설계 검수 22회차 3번).
	// 같은 명령의 앞 절이 그 파일 이름을 적고 쓴 뒤 아직 없는 파일을 경로로 실행하면 그것도 스크립트로 본다(curl -o x … && ./x).
	// 이름을 적지 않은 앞 절(uv venv 뒤 .venv/bin/python)은 셈하지 않는다(22회차 과하게 조이기 재측정 7건).
	if (argv[0].includes("/") && dir !== undefined && !PROGRAM_FILE.test(argv[0])) {
		const f = resolvePathWord(argv[0], dir, root, dirKnown);
		if (!f) return undefined;
		const fs = require("fs");
		let b;
		try {
			if (!fs.statSync(f).isFile()) return undefined;
			const fd = fs.openSync(f, "r");
			b = Buffer.alloc(256);
			b = b.subarray(0, fs.readSync(fd, b, 0, 256, 0));
			fs.closeSync(fd);
		} catch { return afterWriters && afterWriters(f) ? argv[0] : undefined; }
		if (b.includes(0) || (b[0] === 0x7f && b.subarray(1, 4).toString() === "ELF")) return undefined;
		const line = shebangLine(f);
		if (!b.toString("utf8").startsWith("#!")) return argv[0];
		return line && SHELLS.test(line[0]) ? argv[0] : undefined;
	}
	return undefined;
}

/**
 * 이 절이 쓰는 파일과 그 글. [경로, 글|null] 목록(경로를 풀 수 있는 것만). 쓰기 리다이렉션(>, >>, >|, &>, <>)의 대상,
 * tee 의 파일, cp·mv·install·ln 의 목적지. cat·tee 가 heredoc 본문을 쓰면 그 본문이 파일 글이다(>> 는 지금 글 뒤에 붙음).
 * 같은 명령 안에서 쓴 뒤 실행하는 스크립트는 훅이 보는 순간의 파일 글과 실제로 도는 글이 다르다(설계 검수 17회차 뒤 자체 점검).
 */
function writtenPaths(argv, dir, root, dirKnown, heredocs, prior = new Map()) {
	const out = [];
	const head = path.basename(argv[0] || "");
	const body = (head === "cat" || head === "tee") && heredocs && heredocs.length ? heredocs.join("\n") : null;
	const add = (w, append) => {
		const r = resolvePathWord(w, dir, root, dirKnown);
		if (!r) return;
		if (body === null) out.push([r, null]);
		else if (!append) out.push([r, body]);
		else {
			// 같은 명령이 앞에서 쓴 글이 있으면 그 뒤에 붙는다. 없으면 디스크의 지금 글 뒤에.
			const now = prior.has(r) ? prior.get(r) : readLocal(r, "/");
			const unknown = prior.has(r) ? now === null : now === null && require("fs").existsSync(r);
			out.push([r, unknown ? null : now === null ? body : `${now}\n${body}`]);
		}
	};
	for (let i = 0; i < argv.length; i++) {
		const span = redirectSpan(argv, i);
		if (!span) continue;
		const m = argv[i].match(/^(?:\d+|&)?(<<<|<<-?|<>|<&|>&|>\||>>|>|<)(.*)$/);
		if (m && /^(?:>|>>|>\||<>)$/.test(m[1])) add(span === 2 ? argv[i + 1] : m[2], m[1] === ">>" || m[1] === "<>");
		// >& 파일 은 &> 파일 과 같은 쓰기다. >&2·>&-·2>&1 같은 번호 복제·닫기만 뺀다(운영 승인 관문 적대 검수 18회차).
		else if (m && m[1] === ">&") {
			const w = span === 2 ? argv[i + 1] : m[2];
			if (w && !/^\d+-?$|^-$/.test(w)) add(w, false);
		}
		i += span - 1;
	}
	const args = argv.slice(1).filter((a, i, all) => !a.startsWith("-") && !redirectSpan(all, i) && !(i > 0 && REDIR_OP.test(all[i - 1])));
	if (head === "tee") args.forEach((a) => add(a, argv.includes("-a") || argv.includes("--append")));
	// sed -i 는 파일을 고친다. 단순한 s 명령이면 고친 뒤 글을 셈해 두고, 셈할 수 없으면 글을 모르게 쓴 것으로 둔다(설계 검수 22회차 4번).
	if (/^g?sed$/.test(head) && argv.slice(1).some((a) => (/^-[A-Za-z]*i/.test(a) && !a.startsWith("--")) || /^--in-place(?:=|$)/.test(a))) {
		const ed = sedInPlace(argv);
		// 편집 글 자체에 관문 낱말이 있으면 셈한 글을 믿지 않고 글을 모르게 쓴 것으로 둔다(설계 검수 23회차 1번, 22회차 전의 검사 유지).
		if (GATED_SIGNAL.test(withUnescaped(argv.slice(1).join(" ")))) ed.apply = null;
		for (const w of ed.files) {
			const r = resolvePathWord(w, dir, root, dirKnown);
			if (!r) continue;
			const now = prior.has(r) ? prior.get(r) : readLocal(r, "/");
			out.push([r, now === null || !ed.apply ? null : ed.apply(now)]);
		}
	}
	if (/^(?:cp|mv|install|ln)$/.test(head) && args.length >= 2) {
		const dest = resolvePathWord(args[args.length - 1], dir, root, dirKnown);
		if (dest) {
			out.push([dest, null]);
			for (const src of args.slice(0, -1)) out.push([path.join(dest, path.basename(src)), null]);
		}
	}
	return out;
}


/**
 * sed 정규식과 바꿀 글이 JavaScript 에서도 같은 뜻인지(설계 검수 23회차 1번). 같다고 증명된 문법만 받는다.
 * 패턴: 글자, . * ^(맨 앞) $(맨 끝), [:·[=·[.·역슬래시가 없는 대괄호, BRE \( \) \{ \} \+ \?, ERE ( ) { } + ?, 기호를 이스케이프한 글자.
 * 고를 것(| \|)은 sed 가 가장 긴 것을 고르고 JavaScript 는 앞의 것을 골라 받지 않는다. 바꿀 글: \1–\9, &, \&, \n, \\.
 */
function sedSameMeaning(pat, rep, ere) {
	const metaEsc = ere ? /^[.*[\]^$\\/(){}+?]$/ : /^[.*[\]^$\\/(){}+?]$/;
	for (let k = 0; k < pat.length; k++) {
		const c = pat[k];
		if (c === "\\") {
			const n = pat[k + 1];
			if (n === undefined || !metaEsc.test(n)) return false;
			k++;
			continue;
		}
		if (c === "[") {
			let e = k + 1;
			if (pat[e] === "^") e++;
			if (pat[e] === "]") e++;
			while (e < pat.length && pat[e] !== "]") {
				if (pat[e] === "\\" || (pat[e] === "[" && /[:=.]/.test(pat[e + 1] || ""))) return false;
				e++;
			}
			if (e >= pat.length) return false;
			k = e;
			continue;
		}
		if (c === "|" && ere) return false;
		if (c === "^" && k !== 0) return false;
		if (c === "$" && k !== pat.length - 1) return false;
		if (ere && c === "(" && pat[k + 1] === "?") return false;
	}
	if (!ere && /\\\|/.test(pat)) return false;
	for (let k = 0; k < rep.length; k++) {
		if (rep[k] !== "\\") continue;
		if (!/^[1-9n&\\/]$/.test(rep[k + 1] || "")) return false;
		k++;
	}
	return true;
}

/** sed -i 인자를 풀어 고칠 파일과, 셈할 수 있으면 고치는 함수를 돌려준다. s 명령(구분자, g·i·숫자 깃발)만 셈한다. */
function sedInPlace(argv) {
	const scripts = [], files = [];
	let ere = false, i = 1, bad = false;
	for (; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") { i++; break; }
		if (a === "-e" || a === "--expression") { scripts.push(argv[++i] ?? ""); continue; }
		if (/^--expression=/.test(a)) { scripts.push(a.slice(13)); continue; }
		if (a === "-f" || a === "--file" || /^--file=/.test(a)) { bad = true; if (!a.includes("=")) i++; continue; }
		if (/^(?:-E|-r|--regexp-extended)$/.test(a)) { ere = true; continue; }
		// -i 뒤 글자는 백업 접미사다(-iE 는 확장 정규식이 아니다). 앞의 E·r 만 깃발로 받는다.
		const cl = a.match(/^-([Er]*)i(.*)$/);
		if (cl) { if (cl[1]) ere = true; continue; }
		if (/^-[Er]+$/.test(a)) { ere = true; continue; }
		if (/^--in-place(?:=.*)?$/.test(a)) continue;
		// 그 밖의 옵션(-z, -n, -s, --posix …)은 결과 글이 달라질 수 있어 셈하지 않는다(설계 검수 23회차 1번).
		if (a.startsWith("-")) { bad = true; continue; }
		break;
	}
	const rest = argv.slice(i).filter((a) => !a.startsWith("-") && !redirectSpan([a], 0));
	if (!scripts.length && rest.length) scripts.push(rest.shift());
	files.push(...rest);
	if (bad) return { files, apply: null };
	const subs = [];
	for (const sc of scripts) {
		for (const part of sc.split(/\n|;(?=\s*s)/).map((x) => x.trim()).filter(Boolean)) {
			const d = part[1];
			if (part[0] !== "s" || !d || /[\w\s\\]/.test(d)) return { files, apply: null };
			const bits = [];
			let cur = "";
			for (let k = 2; k < part.length; k++) {
				if (part[k] === "\\" && k + 1 < part.length) { cur += part[k + 1] === d ? d : part[k] + part[k + 1]; k++; continue; }
				if (part[k] === d) { bits.push(cur); cur = ""; continue; }
				cur += part[k];
			}
			bits.push(cur);
			if (bits.length !== 3 || !/^[gIi]*$/.test(bits[2])) return { files, apply: null };
			// 구분자를 이스케이프해 쓴 글은 / 일 때만 받는다(다른 구분자는 정규식 기호와 겹칠 수 있다).
			if (d !== "/" && part.includes(`\\${d}`)) return { files, apply: null };
			if (!sedSameMeaning(bits[0], bits[1], ere)) return { files, apply: null };
			let src = bits[0];
			if (!ere) src = src.replace(/\\([(){}+?|])|([(){}+?|])/g, (m, esc, bare) => (esc ? esc : `\\${bare}`));
			let re;
			try { re = new RegExp(src, (/g/.test(bits[2]) ? "g" : "") + (/[Ii]/.test(bits[2]) ? "i" : "")); } catch { return { files, apply: null }; }
			const to = bits[1].replace(/\$/g, "$$$$").replace(/\\(\d)|\\n|\\&|&|\\(.)/g, (m, n, o) => (n ? `$${n}` : m === "\\n" ? "\n" : m === "\\&" ? "&" : m === "&" ? "$&" : o));
			subs.push([re, to]);
		}
	}
	if (!subs.length) return { files, apply: null };
	return { files, apply: (text) => subs.reduce((t, [re, to]) => t.split("\n").map((l) => l.replace(re, to)).join("\n"), text) };
}

/** 셸이 아닌 해석기(node, python …)가 돌리는 프로그램. { file } | { text } | undefined(프로그램 없음이거나 문법 검사만). */
const INTERP = /(?:^|\/)(?:node|nodejs|python(?:\d+(?:\.\d+)?)?|deno|bun|tsx|ts-node|perl|ruby)$/;
/** 해석기 이름에 맞는 인라인 코드 옵션. 한 글자 옵션을 묶어 쓴 꼴(-pe, -Bc, -uc, -ne)도 받는다(설계 검수 22회차 5번). */
function codeFlag(head) {
	if (/^python/.test(head)) return /^-[A-Za-z]*c$/;
	if (/^(?:node|nodejs|deno|bun|tsx|ts-node)$/.test(head)) return /^(?:-[A-Za-z]*[ep]|--eval|--print)$/;
	return /^-[A-Za-z]*[eE]$/;
}
function interpreterProgram(argv, heredocs, stdinFrom) {
	if (!INTERP.test(argv[0])) return undefined;
	// 표준 입력으로 받는 프로그램: "< 파일", "cat 파일 |" (설계 검수 18회차 뒤 자체 점검: python3 < run.py 가 읽히지 않았다)
	let stdinFile = stdinFrom;
	argv.forEach((x, k) => {
		if (x === "<" && argv[k + 1] !== undefined) stdinFile = argv[k + 1];
		else if (/^<[^<>&(]/.test(x)) stdinFile = x.slice(1);
	});
	const head = path.basename(argv[0]);
	const py = head.startsWith("python");
	const code = codeFlag(head);
	let i = (head === "deno" || head === "bun") && argv[1] === "run" ? 2 : 1;
	for (; i < argv.length; i++) {
		const a = argv[i];
		const r = redirectSpan(argv, i);
		if (r) {
			if (a === "<") stdinFile = argv[i + 1];
			else if (/^<[^<>&(]/.test(a)) stdinFile = a.slice(1);
			i += r - 1;
			continue;
		}
		if (code.test(a)) return { text: argv[i + 1] ?? "" };
		if ((py && /^-[A-Za-z]*m$/.test(a)) || (!py && /^(?:-c|--check)$/.test(a))) return undefined;
		if (a === "-") return heredocs && heredocs.length ? { text: heredocs.join("\n") } : stdinFile ? { file: stdinFile } : undefined;
		if (a === "--") { i++; break; }
		if (a.startsWith("-")) {
			if (/^(?:-r|--require|--import|--loader|--experimental-loader|-W|-X)$/.test(a)) i++;
			continue;
		}
		return { file: a };
	}
	if (i < argv.length) return { file: argv[i] };
	if (heredocs && heredocs.length) return { text: heredocs.join("\n") };
	if (stdinFile) return { file: stdinFile };
	return undefined;
}

/** 글자 그대로의 문자열 하나를 읽는다. 끼워 넣은 값은 불명 표식으로 둔다. */
function readLiteral(t, i, unknown = "$X") {
	const m = t.slice(i).match(/^([rRbBfFuU]{0,2})("""|\x27\x27\x27|["'`])/);
	if (!m) return null;
	const f = /f/i.test(m[1]) || m[2] === "`";
	const q = m[2];
	let k = i + m[0].length;
	let v = "";
	while (k < t.length) {
		if (t.startsWith(q, k)) return [v, k + q.length];
		const c = t[k];
		if (c === "\\") { v += t[k + 1] ?? ""; k += 2; continue; }
		if (f && ((q === "`" && c === "$" && t[k + 1] === "{") || (q !== "`" && c === "{" && t[k + 1] !== "{"))) {
			let d = 0;
			for (; k < t.length; k++) { if (t[k] === "{") d++; else if (t[k] === "}" && --d === 0) break; }
			v += unknown;
			k++;
			continue;
		}
		v += c;
		k++;
	}
	return null;
}

/** 여는 괄호 다음(i)부터 짝이 맞는 닫는 괄호까지의 글. */
function balanced(t, i, open, close) {
	let d = 1;
	for (let k = i; k < t.length && k < i + 4000; k++) {
		const lit = /["'`]/.test(t[k]) ? readLiteral(t, k) : null;
		if (lit) { k = lit[1] - 1; continue; }
		if (t[k] === open) d++;
		else if (t[k] === close && --d === 0) return t.slice(i, k);
	}
	return null;
}

/** 목록 글("a", "b", x)의 원소. 글자 그대로가 아니면 불명 표식. */
function listItems(t, unknown = "$X") {
	const items = [];
	let k = 0;
	while (k < t.length) {
		while (k < t.length && /[\s,]/.test(t[k])) k++;
		if (k >= t.length) break;
		const lit = readLiteral(t, k, unknown);
		let end = k;
		let d = 0;
		for (; end < t.length; end++) {
			const l = /["'`]/.test(t[end]) ? readLiteral(t, end) : null;
			if (l) { end = l[1] - 1; continue; }
			if ("([{".includes(t[end])) d++;
			else if (")]}".includes(t[end])) d--;
			else if (t[end] === "," && d === 0) break;
		}
		items.push(lit && !t.slice(lit[1], end).trim() ? lit[0] : unknown);
		k = end + 1;
	}
	return items;
}

/**
 * 해석기 프로그램 글에서 다른 프로그램을 띄우는 자리(subprocess.run, os.system, spawn, execSync …)를 찾아 셸 명령 글로 옮긴다.
 * 첫 인자가 글자 그대로의 문자열이면 그 문자열(셸 명령)이나, 뒤따르는 목록과 합친 argv 다. 목록이면 그 원소들이다(설계 검수 18회차 3번).
 */
const GENERIC_CALL = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/y;
const GATED_HEAD = /^(?:agy|gemini|grok|qwen|opencode|aider|goose|cursor-agent|crush|kimi|droid|claude|codex|az|[\w.-]*deploy[\w.-]*)$/;
const SPAWN_CALL = /(?:asyncio\.create_subprocess_(?:exec|shell)|create_subprocess_(?:exec|shell)|subprocess\.(?:run|call|Popen|check_output|check_call|getoutput|getstatusoutput)|os\.(?:system|popen|exec[lv]p?e?)|spawnSync|spawn|execFileSync|execFile|execSync|exec|execa(?:Sync|Command|CommandSync)?|Bun\.spawn(?:Sync)?|Deno\.Command|pexpect\.spawn)\s*\(/y;
/** 코드 자리(문자열·주석 밖)에 있는 호출만 센다. 예시 글 속의 "execSync('agy …')" 는 호출이 아니다. */
// 프로세스를 띄우는 모듈에서 가져온 이름(별명 포함)을 모은다(설계 검수 21회차 3번: from subprocess import run, import subprocess as sp, { execSync: sh }).
function spawnAliases(text, py) {
	const names = new Set(), prefixes = new Set();
	const t = String(text || "");
	if (py) {
		for (const m of t.matchAll(/^\s*import\s+(?:subprocess|os|asyncio|pexpect|sh|plumbum)\s+as\s+(\w+)/gm)) prefixes.add(m[1]);
		for (const m of t.matchAll(/^\s*from\s+(?:subprocess|os|asyncio(?:\.subprocess)?|pexpect|sh)\s+import\s+\(?([^)\n]+)\)?/gm)) {
			for (const part of m[1].split(",")) { const w = part.trim().split(/\s+as\s+/); const n = (w[1] || w[0]).trim(); if (/^\w+$/.test(n)) names.add(n); }
		}
	} else {
		const mod = `["'](?:node:)?(?:child_process|execa|zx|shelljs|cross-spawn)["']`;
		for (const m of t.matchAll(new RegExp(`\\{([^}]*)\\}\\s*=\\s*(?:await\\s+import\\(|require\\()\\s*${mod}`, "g"))) for (const part of m[1].split(",")) { const w = part.split(":"); const n = (w[1] || w[0]).trim(); if (/^[\w$]+$/.test(n)) names.add(n); }
		for (const m of t.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${mod}`, "g"))) for (const part of m[1].split(",")) { const w = part.trim().split(/\s+as\s+/); const n = (w[1] || w[0]).trim(); if (/^[\w$]+$/.test(n)) names.add(n); }
		for (const m of t.matchAll(new RegExp(`import\\s+(?:\\*\\s+as\\s+)?([\\w$]+)\\s+from\\s*${mod}`, "g"))) { prefixes.add(m[1]); names.add(m[1]); }
		for (const m of t.matchAll(new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*(?:await\\s+import\\(|require\\()\\s*${mod}\\s*\\)`, "g"))) prefixes.add(m[1]);
		for (const m of t.matchAll(new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*require\\(\\s*${mod}\\s*\\)\\.[\\w$]+`, "g"))) names.add(m[1]);
	}
	const esc = (x) => x.replace(/[$]/g, "\\$");
	const parts = [...[...names].map(esc), ...[...prefixes].map((p) => `${esc(p)}\\.[\\w$]+`)];
	return parts.length ? new RegExp(`(?:${parts.join("|")})\\s*\\(`, "y") : null;
}
function codeCalls(text, py) {
	const found = [];
	const alias = spawnAliases(text, py);
	for (let k = 0; k < text.length; k++) {
		const c = text[k];
		if (py ? c === "#" : text.startsWith("//", k)) { const nl = text.indexOf("\n", k); k = nl < 0 ? text.length : nl; continue; }
		if (!py && text.startsWith("/*", k)) { const e = text.indexOf("*/", k + 2); k = e < 0 ? text.length : e + 1; continue; }
		// python 세 겹 따옴표 글(편집 도구가 품은 코드 조각)은 통째로 글이다.
		if (py && (text.startsWith("'''", k) || text.startsWith('"""', k))) { const e = text.indexOf(text.slice(k, k + 3), k + 3); k = e < 0 ? text.length : e + 2; continue; }
		if (c === "'" || c === '"' || c === "`") { const l = readLiteral(text, k); k = l ? l[1] - 1 : text.length; continue; }
		if (k > 0 && /[\w$]/.test(text[k - 1])) continue;
		// 다른 객체의 메서드(RE.exec, db.exec)는 프로그램을 띄우지 않는다. child_process 쪽 이름만 받는다(설계 검수 19회차 약점).
		if (text[k - 1] === "." && !/(?:child_process|childProcess|child|cp|proc|\))\.$/.test(text.slice(Math.max(0, k - 20), k))) {
			GENERIC_CALL.lastIndex = k;
			const g = GENERIC_CALL.exec(text);
			if (g) { found.push({ index: k, length: g[0].length, generic: true }); k += g[0].length - 1; }
			continue;
		}
		SPAWN_CALL.lastIndex = k;
		let m = SPAWN_CALL.exec(text);
		if (!m && alias) { alias.lastIndex = k; m = alias.exec(text); }
		if (m) { found.push({ index: k, length: m[0].length }); k += m[0].length - 1; continue; }
		// 이름을 모르는 호출이라도 첫 인자가 관문 프로그램(에이전트, az, 배포 스크립트)으로 시작하는 목록이나 여러 글자 인자면 띄우기로 본다.
		GENERIC_CALL.lastIndex = k;
		const g = GENERIC_CALL.exec(text);
		if (g) { found.push({ index: k, length: g[0].length, generic: true }); k += g[0].length - 1; }
	}
	return found;
}
function spawnedCommands(text, py = false, cwd = process.cwd()) {
	const out = [];
	text = String(text || "");
	const targetMarker = word => {
		let base = path.basename(word || "");
		if (word && word.includes("/")) {
			try { base = path.basename(require("fs").realpathSync(path.resolve(cwd, word))); } catch {}
		}
		return /^(?:git|systemctl)$/.test(base) ? "$?" : "$X";
	};
	for (const m of codeCalls(text, py)) {
		const args = balanced(text, m.index + m.length, "(", ")");
		if (args === null) continue;
		const a = args.trimStart();
		let argv = null;
		if (a.startsWith("[")) {
			const list = balanced(a, 1, "[", "]");
			if (list !== null) {
				argv = listItems(list);
				if (targetMarker(argv[0]) !== "$X") argv = listItems(list, "$?");
			}
		} else {
			const lit = readLiteral(a, 0);
			if (!lit) continue;
			const rest = a.slice(lit[1]);
			const li = rest.indexOf("[");
			const list = li >= 0 && /^\s*,\s*\[/.test(rest) ? balanced(rest, li + 1, "[", "]") : null;
			// 인자를 하나씩 넘기는 호출(create_subprocess_exec("agy", "-p", x))은 글자 인자를 모두 argv 로 잇는다. 이름 붙은 인자(shell=True)에서 멈춘다.
			const marker = targetMarker(lit[0]);
			const varargs = /^\s*,/.test(rest) && list === null ? listItems(rest.replace(/^\s*,/, ""), marker).filter((x, i, all) => true) : [];
			const kw = rest.replace(/^\s*,/, "").split(",").findIndex((x) => /^\s*[\w$]+\s*=[^=]/.test(x));
			const positional = kw >= 0 ? varargs.slice(0, kw) : varargs;
			if (list !== null && !/\s/.test(lit[0].trim())) argv = [lit[0], ...listItems(list, marker)];
			else if (positional.length && !/\s/.test(lit[0].trim())) argv = [lit[0], ...positional];
			else if (m.generic) continue;
			else { out.push(lit[0]); continue; }
		}
		// 이름 모르는 호출은 명령 모양일 때만 띄우기로 본다: 관문 프로그램 이름 뒤에 옵션(-p …)이 있는 목록이나 인자들이다.
		// open(".../grok", "rb"), 편집 도구의 replace("agy", …), 이름 목록 ["grok", "claude"] 은 아니다.
		if (m.generic && !(argv && argv.length && GATED_HEAD.test(path.basename(argv[0])) && !argv[0].includes("/") && argv.slice(1).some((x) => /^-/.test(x)))) continue;
		if (argv && argv.length && argv[0] !== "$X" && argv[0] !== "$?") out.push(argv.map((v) => (v === "$X" || v === "$?" ? `"${v}"` : quoteArg(v))).join(" "));
	}
	return out;
}

/** 같은 명령의 앞 절이 이 파일 이름을 낱말로 품고 있는가(sed -i, git checkout --, curl -o, 생성기 코드 …). */
const NOT_WRITER = /^(?:cat|ls|head|tail|wc|stat|file|grep|rg|egrep|fgrep|test|\[|echo|printf|chmod|sha256sum|sha1sum|md5sum|diff|cmp|less|more|shellcheck|realpath|readlink|dirname|basename|true|false|:|mkdir|rmdir|rm|export|declare|typeset|local|readonly|unset|cd|pushd|popd|pwd|sleep|date|which|type|hash|wait|kill|ps|pgrep|du|df|id|whoami|hostname|uname)$/;
const GIT_WRITER = new Set(["checkout", "restore", "switch", "reset", "apply", "am", "pull", "merge", "rebase", "stash", "cherry-pick", "revert", "mv", "rm", "clone", "worktree", "clean", "read-tree", "checkout-index"]);
function mayWrite(argv) {
	const head = path.basename(argv[0] || "");
	if (NOT_WRITER.test(head)) return false;
	if (head === "git") return argv.slice(1).some((a) => GIT_WRITER.has(a));
	// 걸러 내기만 하는 도구는 파일을 바꾸지 않는다. 그 출력이 파일로 가면 쓰기 리다이렉션으로 따로 센다(writtenPaths).
	// perl -0pi, -0777pi 처럼 숫자 옵션과 묶인 -i 도 제자리 편집이다(설계 검수 26회차 3번).
	if (/^(?:sed|gsed|perl|ruby)$/.test(head)) return argv.slice(1).some((a) => /^-[a-zA-Z0-9]*i|^--in-place/.test(a));
	if (/^(?:awk|gawk)$/.test(head)) return argv.slice(1).some((a) => /inplace/.test(a));
	if (/^(?:cat|head|tail|tee|echo|printf|sort|uniq|cut|tr|jq|column|xargs)$/.test(head)) return false;
	if (head === "curl") return argv.slice(1).some((a) => /^-[a-zA-Z]*[oO]|^--output|^--remote-name/.test(a));
	if (SHELLS.test(argv[0]) && (shellInvocation(argv).noexec || shellInvocation(argv).command >= 0)) return false;
	// 문법만 검사하는 해석기(node --check, python -m py_compile)는 프로그램 파일을 바꾸지 않는다.
	if (/^node$/.test(head) && argv.slice(1).some((a) => a === "--check" || a === "-c")) return false;
	if (/^python[0-9.]*$/.test(head) && argv[1] === "-m" && /^(?:py_compile|compileall|pyflakes)$/.test(argv[2] || "")) return false;
	// 글로 받은 프로그램을 돌리는 도구는 그 글의 절들이 따로 나오므로 도구 자체는 쓰는 절이 아니다(설계 검수 19회차 약점: bash -c 가 제 안의 스크립트를 막음).
	if (/^(?:eval|tmux|watch|script|su|runuser|screen)$/.test(head)) return false;
	return true;
}
/**
 * 앞 절이 바꾼 글을 명령 글에서 알 수 있는 부류: 글을 명령에 적어 넘기는 편집기(sed, awk, perl, tee, echo, printf, cat)와
 * 프로그램 글을 읽을 수 있는 해석기. 나머지(curl, wget, git checkout, cp, rsync, make …)는 바뀐 글을 명령에서 알 수 없다.
 */
const INLINE_EDITOR = /^(?:sed|gsed|awk|gawk|perl|tee|echo|printf|cat|head|tail|ed|ex)$/;
/** 바깥에서 글을 가져와 여러 파일을 바꾸는 부류(git pull·checkout, 내려받기, 압축 풀기, 동기화). 파일 이름을 적지 않아도 뒤의 로컬 프로그램을 바꿨을 수 있다. */
function fetches(argv) {
	const head = path.basename(argv[0] || "");
	if (head === "git") return argv.slice(1).some((a) => GIT_WRITER.has(a));
	if (head === "gh") return argv.slice(1, 3).some((a) => /^(?:clone|download|checkout)$/.test(a));
	return /^(?:curl|wget|tar|unzip|rsync|scp|sftp|bsdtar|7z)$/.test(head);
}
/** 에이전트 프로그램, az 앱·VM 명령, 배포·운영을 가리키는 낱말. 앞 절의 편집 글에 이것이 있으면 바뀐 파일이 관문에 걸리는 일을 할 수 있다. */
const GATED_SIGNAL = /(?:^|[^\w.-])(?:agy|gemini|grok|qwen|opencode|aider|goose|cursor-agent|crush|kimi|droid)(?![\w.-])|\bclaude\s+(?:-p|--print)\b|\bcodex\s+exec\b|\baz(?:["'`,\s]+)(?:containerapp|webapp|functionapp|staticwebapp|vm|vmss|aks|spring)\b|deploy|(?<![a-z])prod(?:uction)?(?![a-z])/i;
// 해석기 코드가 가리키는 파일 글은 명령 자리에 관문 낱말이 있을 때만 셈한다(틀 파일의 "timeout 2700 agy …", 코드 틀의 spawn 호출).
// 산문(scope.md 의 "deploy 절차")이나 시험 파일의 예시 글은 명령 자리가 아니므로 편집 뒤 시험 흐름을 막지 않는다(19회차 과하게 조이기 재측정).
const CLAUSE_LEAD_WRAPPERS = new Set(["then", "do", "else", "!"]);
function isLineWrapper(word) {
	return CLAUSE_LEAD_WRAPPERS.has(word) || ARGV_WRAPPERS.has(path.basename(word || ""));
}
function timeoutWrapperArgument(words, index) {
	for (let start = index - 1; start >= 0 && index - start <= 12; start--) {
		if (path.basename(words[start] || "") !== "timeout") continue;
		let i = start + 1;
		while (i < index && words[i].startsWith("-")) {
			if (words[i] === "--") { i++; break; }
			if (VALUE_OPTS.timeout.test(words[i])) {
				if (i === index || i + 1 === index) return true;
				i += 2;
			} else i++;
		}
		if (i === index) return true;
		return false;
	}
	return false;
}
function wrapperValue(words, index) {
	return (index > 0 && isLineWrapper(words[index - 1]) && /^(?:-\S+|\d+\S*)$/.test(words[index])) || timeoutWrapperArgument(words, index);
}
// 파일 종류로 나눈다. 셸·틀 파일은 줄의 명령 자리, 프로그램 파일은 spawn 호출만, 자료 파일(json, md, yaml, html …)은 보지 않는다.
// 설계 검수 20회차 3번: 틀 확장자 목록(.tpl …)은 .hbs·.ejs 같은 틀을 놓친다. 자료 파일만 빼고 나머지는 모두 틀로 본다.
const DATA_EXT = /\.(?:json|jsonl|md|markdown|ya?ml|html?|csv|tsv|lock|xml|svg|log|png|jpe?g|gif|webp|pdf)$/i;
const PROGRAM_EXT = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|py|rb|pl)$/i;
function commandShaped(files) {
	return (files || []).some(({ f, t }) => {
		if (DATA_EXT.test(f)) return false;
		if (PROGRAM_EXT.test(f)) return spawnedCommands(t, /\.py$/i.test(f)).some((c) => GATED_SIGNAL.test(c));
		return commandLines(t) || spawnedCommands(t, false).concat(spawnedCommands(t, true)).some((c) => GATED_SIGNAL.test(c));
	});
}
function commandLines(text) {
	const t = String(text || "");
	for (const seg of t.split(/\n|&&|\|\||[;|]|\$\(|`/)) {
		const words = seg.trim().replace(/^[({"']+/, "").split(/\s+/).filter(Boolean);
		let i = 0;
		while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || isLineWrapper(words[i]) || wrapperValue(words, i))) i++;
		if (i >= words.length) continue;
		if (GATED_SIGNAL.test(` ${path.basename(words[i])}`) && !/^(?:prod|production)$/i.test(words[i])) return true;
		if (/^(?:claude\s+(?:-p|--print)|codex\s+exec|az\s+(?:containerapp|webapp|functionapp|staticwebapp|vm|vmss|aks|spring))\b/.test(words.slice(i, i + 2).join(" "))) return true;
	}
	return false;
}
/**
 * 주석 표시(#, //, *, --)나 출력 명령(echo, printf, print, console.log) 뒤에 숨은 관문 명령이 있는지(설계 검수 25회차 1번).
 * 편집이 그 앞머리만 지우면 명령이 된다. 파일 전체에서 관문 낱말을 찾으면 시험 파일의 예시 글과 설명 주석까지 걸려 평소 흐름 85건이 막혔다(25회차 재측정).
 */
function hiddenCommand(f, t, depth = 0) {
	if (!t || DATA_EXT.test(f || "")) return false;
	// 블록 주석(/* … */)과 python 세 겹 따옴표로 감싼 띄우기 호출도 감싸개만 지우면 돈다(설계 검수 26회차 3번).
	if (spawnedCommands(String(t).replace(/\/\*|\*\//g, "").replace(/'''|"""/g, ""), /\.py$/i.test(f || "")).some((c) => GATED_SIGNAL.test(c))) return true;
	const hidden = [];
	const raw = [];
	for (const line of String(t).split("\n")) {
		let u = line;
		let before;
		do {
			before = u;
			u = u.replace(/^\s*(?:#+!?|\/\/+|\/\*+|\*+\/?|--|;+|rem\b|:\s)\s*/i, "").replace(/^\s*(?:echo|printf|print|puts|console\.(?:log|error|info)|logger|say)\b\s*\(?\s*(?:-\w+\s+)*["'`]?/, "");
		} while (u !== before);
		if (u.trim() && u.trim() !== line.trim()) raw.push(u), hidden.push(u.replace(/["'`);]+\s*$/, ""));
	}
	if (!hidden.length) return false;
	// 끝 따옴표를 지운 줄은 명령 모양을 보고, 지우지 않은 줄은 spawn 호출(주석 처리된 subprocess.run([...]))을 본다.
	// 숨은 줄 어디에든 에이전트·az 부르는 모양이 있으면(echo "DRY RUN: agy -p …", echo + agy …) 명령이다(설계 검수 26회차 3번).
	if (hidden.some((u) => hiddenLineIsCommand(u) || GATED_CALL.test(u))) return true;
	if (spawnedCommands(raw.join("\n"), /\.py$/i.test(f || "")).some((c) => GATED_SIGNAL.test(c))) return true;
	// 숨은 줄이 로컬 스크립트를 부르면(# ./steps/02-agent.sh) 그 스크립트 글을 본다. 두 단계까지만 따라간다.
	if (depth < 2 && f) {
		for (const u of hidden) {
			const words = u.trim().split(/\s+/);
			let i = 0;
			while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || isLineWrapper(words[i]) || SHELLS.test(words[i]) || /^(?:node|python3?|source|\.)$/.test(words[i]) || (i > 0 && /^(?:-\S+|\d+\S*)$/.test(words[i])) || timeoutWrapperArgument(words, i))) i++;
			const w = (words[i] || "").replace(/^["']|["']$/g, "");
			if (!w || !/[/.]/.test(w) || /[$`*?]/.test(w)) continue;
			const target = path.resolve(path.dirname(f), w);
			const text = require("fs").existsSync(target) ? readLocal(target, "/") : null;
			if (text && (commandShaped([{ f: target, t: text }]) || hiddenCommand(target, text, depth + 1))) return true;
		}
	}
	return false;
}
/**
 * 숨은 줄이 명령 모양인지. 설명 주석("Gemini 2.5 may spend", "opencode 플러그인은 …")은 명령이 아니다(25회차 재측정 38건).
 * 명령 이름은 소문자 낱말이고, 뒤에 옵션(-p, --yes)이 오거나, 경로·파일 이름(./deploy.sh)이거나, 이름 하나뿐이다.
 */
function hiddenLineIsCommand(u) {
	const words = String(u).trim().split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || isLineWrapper(words[i]) || wrapperValue(words, i))) i++;
	const w0 = words[i] || "";
	if (!/^[a-z0-9_./~-]+$/.test(w0)) return false;
	if (/^(?:claude\s+(?:-p|--print)|codex\s+exec|az\s+(?:containerapp|webapp|functionapp|staticwebapp|vm|vmss|aks|spring))\b/.test(words.slice(i, i + 2).join(" "))) return true;
	if (!GATED_SIGNAL.test(` ${path.basename(w0)}`) || /^(?:prod|production)$/.test(w0)) return false;
	return /[/.]/.test(w0) || words.length === i + 1 || words.slice(i + 1).some((x) => /^-{1,2}[a-zA-Z]/.test(x));
}
/** 프로그램 글이 부르는 도움 파일 가운데 앞 절이 바꿨을 수 있고 관문 낱말과 닿는 것. 없으면 null. */
// 같은 프로그램을 앞 절에서 한 번 더 돌린 것은 도움 파일을 고친 것으로 치지 않는다(부르는 쪽이 넘긴다). 그 프로그램 글이 도움 파일 이름을 품는 것은 평소 모양이다.
// 도움 파일을 고치는 글은 관문 명령을 부르는 모양일 때만 셈한다. 설명 글의 이름(OpenCode, Gemini)까지 세면 모듈을 고치고 시험을 돌리는 평소 흐름 20건이 막혔다(25회차 재측정).
// 에이전트·az 를 부르는 모양(이름 뒤 옵션, claude -p, codex exec, az containerapp …). 배포 파일 이름은 빼고 숨은 줄 검사에 쓴다.
const GATED_CALL = /(?:^|[^\w.-])(?:agy|gemini|grok|qwen|opencode|aider|goose|cursor-agent|crush|kimi|droid)["'`,\s]+-{1,2}[a-zA-Z]|\bclaude["'`,\s]+(?:-p|--print)\b|\bcodex["'`,\s]+exec\b|\baz["'`,\s]+(?:containerapp|webapp|functionapp|staticwebapp|vm|vmss|aks|spring)\b/;
const GATED_INVOKE = /(?:^|[^\w.-])(?:agy|gemini|grok|qwen|opencode|aider|goose|cursor-agent|crush|kimi|droid)["'`,\s]+-{1,2}[a-zA-Z]|\bclaude["'`,\s]+(?:-p|--print)\b|\bcodex["'`,\s]+exec\b|\baz["'`,\s]+(?:containerapp|webapp|functionapp|staticwebapp|vm|vmss|aks|spring)\b|[\w./-]*deploy[\w./-]*\.(?:sh|mjs|js|py)\b/;
function helperEdited(text, fileDir, dir, earlier, written = new Map(), writtenBy = new Map()) {
	// 스크립트 자기 디렉터리($(dirname "$0"), BASH_SOURCE, __dirname)와 글자 그대로 준 경로 변수(LIB=/abs/lib)를 풀어 이름을 찾는다(설계 검수 26회차 4번).
	const vars = new Map();
	for (const m of String(text).matchAll(/^\s*(?:export\s+|readonly\s+|local\s+|declare\s+)?([A-Za-z_]\w*)=(.*)$/gm)) {
		if (/dirname\s+["']?\$\{?(?:0|BASH_SOURCE)/.test(m[2])) vars.set(m[1], path.resolve(fileDir, `.${(m[2].match(/dirname\s+["']?\$\{?(?:0|BASH_SOURCE)[^)]*\)["']?((?:\/\.\.)+)/) || [])[1] || ""}`));
		else { const v = m[2].trim().match(/^(["']?)([^"'`$\s;]+)\1\s*(?:#.*)?$/); if (v) vars.set(m[1], v[2].startsWith("/") ? v[2] : path.resolve(fileDir, v[2])); }
	}
	text = String(text).replace(/\$\(\s*dirname\s+["']?\$\{?(?:0|BASH_SOURCE(?:\[0\])?)\}?["']?\s*\)/g, fileDir).replace(/\b__dirname\b/g, fileDir)
		.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, n) => (vars.has(n) ? vars.get(n) : all));
	const words = new Set(String(text).match(/[\w./~-]+\.(?:sh|bash|zsh|[cm]?js|[cm]?ts|py|rb|pl)\b/g) || []);
	for (const w of words) {
		const f = [path.resolve(fileDir, w), path.resolve(dir, w)].find((x) => require("fs").existsSync(x)) || path.resolve(fileDir, w);
		// 같은 명령이 리다이렉션·heredoc·tee 로 쓴 도움 파일은 쓴 글로 판단한다. 글을 모르면 막는다(설계 검수 27회차 1번).
		if (written.has(f)) {
			const t = written.get(f);
			// 글을 모르게 쓴 것은 실행 파일과 같은 기준이다. 쓴 명령이 바깥 글을 가져오거나 그 글에 관문 낱말이 있을 때만 막는다(printf 'SLICE=l14' > env.sh 는 평소 흐름).
			const by = writtenBy.get(f);
			if (t === null ? !by || !by.known || GATED_SIGNAL.test(by.blob) || commandShaped(by.refs) : commandShaped([{ f, t }]) || hiddenCommand(f, t)) return w;
			continue;
		}
		const touching = earlier.filter((b) => b.self !== f && mentions(b.blob, f));
		if (!touching.length) continue;
		const cur = readLocal(f, "/") || "";
		if (touching.some((b) => !b.known) || commandShaped([{ f, t: cur }]) || hiddenCommand(f, cur) || GATED_INVOKE.test(touching.map((b) => b.blob).join("\n"))) return w;
	}
	return null;
}
/** 쓰는 글 속 역슬래시 줄바꿈(\\n, \\t)을 빈칸으로 푼 글을 덧붙인다. printf 'set -e\\nagy …' 의 이름을 낱말로 보게 한다(설계 검수 27회차 2번). */
function withUnescaped(b) {
	const t = String(b || "");
	return /\\[ntrvf0\\]/.test(t) ? `${t}\n${t.replace(/\\[ntrvf0\\]/g, " ")}` : t;
}
function mentions(blob, file) {
	const b = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[^\\w.-])${b}(?![\\w-]|\\.\\w)`).test(blob);
}

/**
 * 이 절이 돌리는 프로그램 파일을 한 곳에서 정한다(설계 검수 19회차 2번). 해석기 이름 뒤의 파일, 실행기(uv run, npx, pnpm exec …) 뒤의 해석기,
 * 경로로 실행하는 파일의 shebang(node·python 이면 해석기 프로그램). 돌려주는 값은 interpreterProgram 과 같고 py 표시를 단다.
 */
const RUNNERS = { uv: "run", poetry: "run", pipenv: "run", pdm: "run", hatch: "run", rye: "run", pnpm: /^(?:exec|dlx)$/, yarn: "exec", npm: "exec" };
const RUNNER_HEAD = /^(?:npx|bunx|uv|uvx|poetry|pipenv|pdm|hatch|rye|pnpm|pnpx|yarn|npm)$/;
const PROGRAM_FILE = /\.(?:[cm]?js|[cm]?ts|py)$/i;
/** shebang 줄을 낱말로(env 와 -S 는 뺀다). 없으면 null. */
function shebangLine(f) {
	const m = (readLocal(f, "/") || "").slice(0, 300).match(/^#!\s*(.+)/);
	if (!m) return null;
	let w = m[1].trim().split(/\s+/);
	if (path.basename(w[0]) === "env") { w = w.slice(1); while (w.length && w[0].startsWith("-")) w = w.slice(1); }
	return w.length ? w : null;
}
function shebangInterp(f) { const l = shebangLine(f); return l && INTERP.test(l[0]) ? l[0] : null; }
// 실행기·해석기 뒤에서 파일만 다루고 실행하지 않는 도구(포맷터, 린터, 타입 검사기). 이 도구가 먼저 나오면 뒤 파일을 프로그램으로 읽지 않는다.
// 모르는 도구는 실행하는 쪽으로 본다(목록에 없으면 더 읽을 뿐 덜 막지 않는다).
const NON_EXEC_TOOL = /^(?:prettier|eslint|biome|tsc|vue-tsc|oxlint|stylelint|ruff|black|isort|mypy|pyright|flake8|pylint|markdownlint|cspell|knip|dprint)$/;
const DIR_OPT = /^(?:-C|--dir|--directory|--prefix|--cwd|--project|--root)$/;
/**
 * 실행기(npx, uv, pnpm …)나 해석기(node, python …) 절의 낱말 가운데 프로그램 파일로 읽을 것을 모두 모은다(설계 검수 21회차 1·4번).
 * 옵션이 값을 받는지 짐작하지 않는다. 디렉터리 옵션 값(-C, --directory …)도 찾는 자리로 쓴다. 해석기 이름 뒤 인라인 코드(-e, -c)도 모은다.
 * 글자 그대로의 프로그램 파일 이름을 어느 자리에서도 찾지 못하면 missing 으로 알린다(실행기일 때만. 해석기만이면 없는 파일은 실패할 뿐이다).
 */
function programWords(argv, dir, root, dirKnown) {
	const h = path.basename(argv[0] || "");
	const runner = RUNNER_HEAD.test(h);
	if (!runner && !INTERP.test(argv[0] || "")) return null;
	const bases = [dir];
	argv.forEach((w, i) => {
		const m = w.match(/^(--dir|--directory|--prefix|--cwd|--project|--root)=(.+)$/);
		const v = DIR_OPT.test(w) ? argv[i + 1] : m ? m[2] : undefined;
		const r = v !== undefined ? resolvePathWord(v, dir, root, dirKnown) : null;
		if (r) bases.push(r);
	});
	const firstPositional = argv.slice(1).find((w, i) => !w.startsWith("-") && !(i === 0 && /^(?:run|exec|dlx|x)$/.test(w)) && !(i > 0 && argv[i].startsWith("-") && !argv[i].includes("=")));
	if (runner && firstPositional && NON_EXEC_TOOL.test(path.basename(firstPositional))) return { files: [], code: [], missing: null };
	const files = [], code = [];
	let missing = null, sawInterp = !runner, interpHead = runner ? "" : h;
	for (let i = 1; i < argv.length; i++) {
		const w = argv[i];
		if (INTERP.test(w)) { sawInterp = true; interpHead = path.basename(w); continue; }
		const py = /^python/.test(interpHead);
		if (sawInterp && codeFlag(interpHead).test(w) && argv[i + 1] !== undefined) { code.push({ text: argv[i + 1], py }); i++; continue; }
		if (w.startsWith("-") || w.includes("$")) continue;
		let found = null;
		for (const b of bases) {
			const f = resolvePathWord(w, b, root, b === dir ? dirKnown : true);
			if (f && require("fs").existsSync(f) && require("fs").statSync(f).isFile() && (PROGRAM_FILE.test(f) || shebangInterp(f))) { found = f; break; }
		}
		if (found) files.push({ word: w, path: found, py: /\.py$/i.test(found) || /python/.test(shebangInterp(found) || "") });
		// 해석기 이름(tsx, node, python …) 뒤의 글자 그대로인 프로그램 파일만 "찾을 수 없음"으로 본다. 시험 실행기(pytest, vitest …)의 대상과 glob 은 아니다.
		else if (runner && sawInterp && PROGRAM_FILE.test(w) && !/[*?[\]{}]/.test(w) && !missing) missing = w;
	}
	return { files, code, missing: files.length || code.length ? null : missing };
}
function programOf(argv, heredocs, catFile, dir, root, dirKnown, depth = 0) {
	const words = programWords(argv, dir, root, dirKnown);
	const base = programOfFirst(argv, heredocs, catFile, dir, root, dirKnown, depth);
	if (!words) return base;
	// 해석기만 쓴 절에서 해석기가 프로그램을 돌리지 않는다고 본 경우(node --check, python -m, 대화형)는 그대로 둔다.
	if (!RUNNER_HEAD.test(path.basename(argv[0] || "")) && base === undefined) return undefined;
	// 맨 앞 프로그램이 프로그램 파일로 풀리지 않으면(값을 받는 옵션을 파일로 짚음 등) 찾은 첫 프로그램 파일을 맨 앞으로 삼는다.
	let it = base;
	const mainPath = it && it.file !== undefined ? words.files.find((f) => f.word === it.file) : null;
	// 파일은 찾은 절대 경로로 넘긴다(디렉터리 옵션 아래에서 찾은 파일을 현재 디렉터리에서 다시 풀지 않게).
	if (mainPath) it = { ...it, file: mainPath.path };
	else if ((!it || it.file !== undefined) && words.files.length) it = { file: words.files[0].path, py: words.files[0].py };
	if (!it && words.code.length) it = { text: words.code[0].text, py: words.code[0].py };
	if (!it && !words.missing) return undefined;
	const extra = [...words.files.filter((f) => !it || f.path !== it.file).map((f) => ({ text: readLocal(f.path, "/") || "", py: f.py })), ...words.code.filter((c) => !it || c.text !== it.text)];
	return { ...(it || {}), extra, missing: words.missing };
}
function programOfFirst(argv, heredocs, catFile, dir, root, dirKnown, depth = 0) {
	let a = argv;
	const h = path.basename(a[0] || "");
	// 실행기 뒤에서 해석기 이름이나 로컬 프로그램 파일이 나오는 첫 자리를 찾는다(설계 검수 20회차 2번: uv run x.py, uv run --with r python x.py, pnpm tsx x.mjs, npx -p tsx tsx x.mjs).
	// 옵션 뒤 낱말은 그 옵션의 값일 수 있어 건너뛰고, 다른 도구 이름(prettier 등)이 먼저 나오면 그 도구의 인자이므로 멈춘다.
	if (RUNNER_HEAD.test(h)) {
		const localProgram = (w) => { const f = resolvePathWord(w, dir, root, dirKnown); return f && require("fs").existsSync(f) && (PROGRAM_FILE.test(f) || shebangInterp(f)) ? f : null; };
		let found;
		for (let i = 1; i < a.length; i++) {
			const w = a[i];
			if (i === 1 && /^(?:run|exec|dlx|x)$/.test(w)) continue;
			if (!w.startsWith("-") && localProgram(w)) { const f = localProgram(w); const sh = shebangInterp(f); return { file: w, py: /\.py$/i.test(f) || /python/.test(sh || "") }; }
			if (w.startsWith("-")) continue;
			if (a[i - 1].startsWith("-") && !a[i - 1].includes("=") && i > 1) continue;
			if (INTERP.test(w)) { found = i; break; }
			if (w === "--") continue;
			break;
		}
		if (found === undefined) return undefined;
		a = a.slice(found);
	}
	if (!a.length) return undefined;
	const it = interpreterProgram(a, heredocs, catFile);
	if (it) return { ...it, py: path.basename(a[0]).startsWith("python") };
	if (a[0].includes("/") && !/\.(?:sh|bash)$/.test(a[0])) {
		const f = resolvePathWord(a[0], dir, root, dirKnown);
		const line = f ? shebangLine(f) : null;
		if (line) {
			// shebang 줄 전체를 명령으로 다시 본다(#!/usr/bin/env -S uv run --script). 해석기면 이 파일이 프로그램이다.
			if (INTERP.test(line[0])) return { file: a[0], py: /python/.test(line[0]) };
			// 실행기 shebang 파일은 그 파일 자신이 프로그램이다(확장자가 없어도. 21회차 코드 탐침).
			if (depth < 1 && RUNNER_HEAD.test(path.basename(line[0]))) { const it = programOf([...line, a[0]], heredocs, catFile, dir, root, dirKnown, depth + 1); return it || { file: a[0], py: /^(?:uv|uvx|poetry|pipenv|pdm|hatch|rye)$/.test(path.basename(line[0])) }; }
			// 모르는 해석기(zx, vite-node …)라도 프로그램 확장자면 그 파일의 띄우기 호출을 읽는다(설계 검수 21회차 4번).
			if (!SHELLS.test(line[0]) && PROGRAM_FILE.test(f)) return { file: a[0], py: /\.py$/i.test(f) };
		}
	}
	return undefined;
}

/** 해석기 코드가 글자 그대로 가리키는 로컬 파일들의 글(틀 파일 등). 해석기가 쓰는 파일의 글을 관문 낱말 검사에 넣는다(설계 검수 19회차 1번). */
// 고치는 파일 자신의 지금 글은 빼고 본다(except). 편집하고 곧바로 시험하는 흐름에서 옛 글이 관문 낱말을 품었다고 막지 않는다.
function literalFileTexts(text, dir, except) {
	const out = [];
	const skip = [...(except || [])].filter(Boolean);
	for (const m of String(text || "").matchAll(/["'`]([^"'`\s$]{1,200})["'`]/g)) {
		if (out.length >= 10) break;
		const rel = m[1].replace(/^\.\//, "");
		const f = path.resolve(dir || "/", m[1]);
		// 앞 절의 디렉터리를 모를 때도 실행하는 파일 자신은 경로 끝이 같으면 뺀다.
		if (skip.some((e) => e === f || e.endsWith(`/${rel}`))) continue;
		const t = readLocal(f, "/");
		if (t !== null) out.push({ f, t });
	}
	return out;
}

/** Every real command in a whole command string, with the cd-tracked directory it runs in. */
function effectiveCommands(command, cwd, depth = 0, root = command, spawned = false, inherited = null) {
	return withLiteralValuesCache(() => effectiveCommandsInner(command, cwd, depth, root, spawned, inherited));
}
function effectiveCommandsInner(command, cwd, depth, root, spawned, inherited) {
	// 치환이 끝없이 겹친 명령은 읽지 않고 막는다. 스택이 넘쳐 훅이 예외로 끝나면 통과가 되기 때문이다(구현 검수 1번).
	if (depth > 40) return [{ argv: ["<too-deep>"], assigns: [], dir: cwd, clause: [], opaque: "명령 치환이 너무 깊게 겹친 명령. 나눠서 실행할 것" }];
	const out = [];
	// 디렉터리는 서브셸마다 따로 따라간다. 서브셸이 처음 열리면 바깥 상태를 복사하고, 닫히면 버린다(설계 검수 18회차 2번).
		const scopes = new Map([["", shellState(inherited, cwd)]]);
	const scopeOf = (key) => {
		if (!scopes.has(key)) {
			const parent = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : "";
			const inherited = scopeOf(parent);
			scopes.set(key, shellBodyState(inherited,"subshell"));
		}
		return scopes.get(key);
	};
	const written = new Map();
	const writtenBy = new Map();
	// 앞 절들이 품은 글(인자, heredoc 본문, 돌린 로컬 프로그램 파일의 글). 뒤에서 실행하는 파일 이름이 여기 있으면 바뀌었을 수 있다.
	const earlier = [];
	let prev = null;
	const clauses = shellClauses(String(command || ""));
	// 따옴표가 닫히지 않은 명령은 bash 가 실행하지 않는다. 파서가 bash 와 다르게 읽었을 수 있으므로 표시만 남긴다(설계 검수 11회차 1번).
	if (clauses.unbalanced) out.push({ argv: ["<unbalanced-quote>"], assigns: [], dir: cwd, clause: [], opaque: "따옴표가 닫히지 않은 명령" });
	for (let clauseIndex=0;clauseIndex<clauses.length;clauseIndex++) {
		const clause=clauses[clauseIndex];
		const parent = scopeOf(clause.scope || "");
		const outer = clause.piped || clauses[clauseIndex+1]?.piped ? shellBodyState(parent,"subshell") : parent;
		const substitutionScope = shellBodyState(outer, "substitution");
		let scratch = null;
		// Track shell assignments and exported environment across preceding clauses.
		const words = Array.from(clause);
		const expanded = expandClause(clause);
		const stateWords=words.every(w=>ASSIGN.test(w)) ? words : expanded[0]?.argv || [];
		if(/^(?:if|for|while|until|select)$/.test(words[0])) outer.flowDepth=(outer.flowDepth||0)+1;
		if(/^(?:fi|done)$/.test(words[0])) outer.flowDepth=Math.max(0,(outer.flowDepth||0)-1);
		const conditional=(outer.flowDepth||0)>0 && (/^(?:export|declare|typeset|local|readonly|unset|set|shopt)$/.test(stateWords[0]) || stateWords.some(w=>/^(?:PATH|GIT_DIR|GIT_WORK_TREE|BASH_ENV|ENV)=/.test(w)));
		const before=conditional ? JSON.stringify([outer.vars,outer.exported,outer.autoExport]) : "";
		updateShellState(stateWords, outer);
		if(conditional && before !== JSON.stringify([outer.vars,outer.exported,outer.autoExport])) outer.uncertain=true;
		// Environment wrappers and state-changing builtins outside this evaluator
		// must not silently erase an inherited setting.
		if (words.includes("env") && words.some(w=>/^-(?:i|u)$|^--(?:ignore-environment|unset)(?:=|$)/.test(w))) outer.uncertain=true;
		// $(…)·역따옴표·<(…) 안의 명령도 실행된다(설계 검수 12회차 2번).
		for (const sub of clause.subs || []) out.push(...effectiveCommands(sub, outer.dir, depth + 1, root, false, substitutionScope));
		const shellCommand = expanded[0] && SHELLS.test(expanded[0].argv[0]) && shellInvocation(expanded[0].argv).command >= 0;
		for (const e of expanded.filter((e,i) => !shellCommand || i === 0)) {
			const st = e.nested ? (scratch = scratch || {...shellBodyState(outer,"wrapper"),uncertain:true}) : outer;
			const { argv } = e;
			const prefixAssigns = e.assigns.map(a => a.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_,a,b) => shellValue(st,a || b)));
			const assigns = [...Object.entries(st.exported).filter(([k,v])=>v !== null && st.explicitExports[k]).map(([k, v]) => `${k}=${v}`), ...prefixAssigns];
			const dir = st.dir;
			const dirKnown = st.dirKnown;
			if (e.envProgramVariable) {
				out.push({ argv: ["<dynamic-program>"], assigns: [], dir, dirKnown, clause, opaque: `env 뒤의 프로그램 변수를 확인할 수 없음(${argv[0]})` });
				prev = { ...e, dir, dirKnown };
				continue;
			}
			// 실행 중에 만들어지는 프로그램(설계 검수 13회차 2번).
			const head = path.basename(argv[0]);
			const target = head === "source" || head === "." ? sourceTargetIndex(argv)
				: SHELLS.test(argv[0]) ? shellInvocation(argv, { dir, root, dirKnown }).script : 0;
			const dyn = target >= 0 && depth < 4 ? dynamicWord(argv[target], root, dir, dirKnown, written) : undefined;
			if (dyn === null) {
				const sub = extractReadSubFile(argv[target]);
				const resolvedSub = sub ? resolvePathWord(sub.file, dir, root, dirKnown) || sub.file : argv[target];
				out.push({ argv: ["<dynamic-program>"], assigns: [], dir, dirKnown, clause, stdinTarget: resolvedSub, stdinSourceFiles: sub && resolvedSub ? [resolvedSub] : [], opaque: `실행 중에 정해지는 프로그램(${argv[target]}). 훅이 읽은 글과 실제로 도는 글이 다를 수 있음` });
				prev = { ...e, dir, dirKnown };
				continue;
			}
			if (dyn) {
				if (dyn.sourceFiles && dyn.sourceFiles.length) {
					out.push({ argv, assigns, prefixAssigns, dir, dirKnown, shellPath: st.vars.PATH ?? undefined, shellState: shellBodyState(st, "source"), environment: { ...st.exported }, clause, heredocs: e.heredocs, heredocFds: e.heredocFds, piped: e.piped, stdinSourceFiles: dyn.sourceFiles, syntheticStdinHolder: true });
				}
				const lead = argv.slice(0, target).map(quoteArg);
				const tail = argv.slice(target + 1).map(quoteArg);
				const program = dyn.program !== undefined ? dyn.program : dyn.words.map((v) => [...lead, v, ...tail].join(" ")).join("\n");
				out.push(...effectiveCommands(program, dir, depth + 1, `${root}\n${program}`, false, shellBodyState({...st,prefixAssigns}, head === "source" || head === "." ? "source" : "exec")));
				prev = { ...e, dir, dirKnown };
				continue;
			}
			// cd·pushd 는 한 부류로 따라간다. 옵션(-P, -L)과 --, $HOME 같은 변수를 풀고, 대상을 모르면(cd -, popd, 풀 수 없는 변수)
			// 그 뒤의 상대 경로 스크립트는 읽을 수 없는 것으로 본다(설계 검수 17회차 2번).
			if (argv[0] === "cd" || argv[0] === "pushd" || argv[0] === "popd") {
				let i = 1;
				while (argv[i] && /^-[LPe@]+$/.test(argv[i])) i++;
				if (argv[i] === "--") i++;
				const t = argv[i];
				if (argv[0] === "popd" || t === "-" || /^[+-]\d+$/.test(t || "") || (t === undefined && argv[0] === "pushd")) st.dirKnown = false;
				else {
					const r = t === undefined ? require("os").homedir() : resolvePathWord(t, dir, root, dirKnown);
					if (r) { st.dir = r; st.dirKnown = true; } else st.dirKnown = false;
				}
				prev = null;
				continue;
			}
			const entry = { argv, assigns, prefixAssigns, dir, dirKnown, shellPath: st.vars.PATH ?? undefined, shellState: shellBodyState(st,"source"), environment: {...st.exported}, clause, heredocs:e.heredocs, heredocFds:e.heredocFds, piped: e.piped, ...(spawned ? { spawned: true } : {}), ...(e.guess ? { guess: true } : {}) };
			out.push(entry);
			if (shellCommand) {
				const body = argv[shellInvocation(argv).command];
				out.push(...effectiveCommands(body,dir,depth+1,`${root}\n${body}`,false,shellBodyState(entry,"command")));
			}
			// 로컬 프로그램 파일(셸 스크립트, 해석기 파일)을 실행하면, 게이트가 읽은 글이 실제로 도는 글이어야 한다(설계 검수 17·18회차).
			// 경로를 풀 수 없거나, 아직 없거나, 같은 명령의 앞 절이 글을 모르게 썼거나 이름을 품고 있으면(바꿨을 수 있음) 읽을 수 없는 명령이다.
			// 같은 명령이 heredoc 으로 쓴 스크립트는 그 본문을 프로그램으로 읽는다. 같은 명령이 쓴 파일을 경로로 실행하면 확장자와 상관없이 스크립트다.
			const catFile = e.piped && prev && path.basename(prev.argv[0]) === "cat" && prev.argv.length === 2 ? prev.argv[1] : undefined;
			const interp = programOf(argv, e.heredocs, catFile, dir, root, dirKnown);
			const sw = scriptWord(argv, dir, root, dirKnown, (f) => earlier.some((b) => mentions(b.blob, f))) ?? (interp && interp.file !== undefined ? interp.file : undefined)
				?? (argv[0].includes("/") && written.has(resolvePathWord(argv[0], dir, root, dirKnown)) ? argv[0] : undefined);
			const noexec = SHELLS.test(argv[0]) && shellInvocation(argv).noexec;
			const swPath = sw === undefined ? undefined : /^(?:source|\.)$/.test(argv[0]) ? sourceFile(sw,dir,root,dirKnown,[...prefixAssigns].reverse().find(a=>a.startsWith("PATH="))?.slice(5) ?? st.vars.PATH) : resolvePathWord(sw, dir, root, dirKnown);
			let programText;
			// 해석기 프로그램이 띄우는 명령(spawned)은 인자를 모르는 것이 보통이다. 거기서는 글자 그대로 있는 파일만 읽고 막지는 않는다(설계 검수 19회차 2번).
			if (sw !== undefined && !noexec && spawned) {
				const f = swPath && [swPath, ...(interp ? [".js", ".mjs", ".cjs", ".ts", ".py"].map((x) => swPath + x) : [])].find((x) => require("fs").existsSync(x));
				if (f) programText = readLocal(f, "/") ?? undefined;
			} else if (sw !== undefined && !noexec) {
				const opaque = (why) => out.push({ argv: ["<unread-program>"], assigns: [], dir, clause, opaque: `${why}(${sw})` });
				// 해석기 파일은 읽을 수 있을 때만 읽는다(for 반복 변수 같은 경로는 평소 모양이다). 셸 스크립트는 경로를 모르면 막는다.
				// 디렉터리를 모르는 해석기 파일(cd "$(git rev-parse --show-toplevel)" 뒤 node scripts/x.mjs)은 마지막으로 안 디렉터리에서 찾아 읽는다(설계 검수 22회차 2번).
				// 막지는 않는다. 막으면 반복문의 cd "$d" 같은 평소 흐름 20건(14,649건 중)이 새로 막혔다(22회차 과하게 조이기 재측정). 남는 틈은 보고서에 적는다.
				if (!swPath) {
					if (!interp) opaque("실행하는 프로그램 파일 경로를 알 수 없음. 경로를 글자 그대로 적을 것");
					else if (!dirKnown && !/[$`*?[\]{}]/.test(sw) && !/^[~/]/.test(sw)) {
						const guess = resolvePathWord(sw, dir, root, true);
						const t = guess ? readLocal(guess, "/") : null;
						if (t !== null) programText = t;
					}
				}
				else if (written.has(swPath)) {
					const text = written.get(swPath);
					// 글을 모르게 쓴 파일: 쓴 명령이 바깥 글을 가져오는 부류이거나, 쓴 명령과 그 원본 파일 글에 관문 낱말이 있으면 막는다.
					const by = writtenBy.get(swPath);
					if (text === null && (!by || !by.known || GATED_SIGNAL.test(by.blob) || commandShaped(by.refs))) opaque("같은 명령이 쓰고 곧바로 실행하는 파일. 쓰는 명령과 실행하는 명령을 나눌 것");
					// 고친(새로 쓴 것이 아닌) 파일은 고치기 전 글의 명령 자리에 관문 명령이 있으면 막는다. 셈한 sed 글이 실제와 달라도 새지 않게 한다(설계 검수 24회차 1·2번).
					// 주석이나 echo 뒤에 숨은 관문 명령도 앞 절이 풀어 명령으로 만들 수 있다. 고친 파일은 고치기 전·뒤 글에서 그런 줄을 본다(설계 검수 25회차 1번).
					else if (text !== null && by && by.edited && (commandShaped([{ f: swPath, t: by.before || "" }]) || hiddenCommand(swPath, by.before) || hiddenCommand(swPath, text) || helperEdited(text, path.dirname(swPath), dir, earlier.filter((b) => b.self !== swPath), written, writtenBy))) opaque("같은 명령의 앞 절이 바꿨을 수 있는 파일. 바꾸는 명령과 실행하는 명령을 나눌 것");
					else if (text !== null) programText = text;
				} else {
					const found = [swPath, ...(interp ? [".js", ".mjs", ".cjs", ".ts", ".py"].map((x) => swPath + x) : [])].find((f) => require("fs").existsSync(f));
					const old = found ? readLocal(found, "/") : "";
					// 앞 절이 이 파일을 바꿨거나 만들었을 수 있다. 앞 절이 없으면 없는 파일은 실행될 때도 없다(bash 가 실패할 뿐).
					// 파일 이름을 적지 않은 가져오기(git pull 등)는 셈하지 않는다. 이미 커밋된 글이고, 평소 흐름(git pull 뒤 대기열 도구)을 막지 않는다.
					const touching = earlier.filter((b) => b.self !== swPath && (!found || mentions(b.blob, swPath)));
					// 바뀐 글을 명령에서 알 수 없거나(curl, git checkout, cp …), 앞 절의 글(해석기면 그 코드가 가리키는 틀 파일 글까지)에 관문에 걸리는 낱말이 있으면 막는다.
					// 편집하고 곧바로 시험을 돌리는 평소 흐름(python heredoc 으로 고치고 node 시험)은 막지 않는다(설계 검수 18회차 1번, 과하게 조이지 않기).
					// 앞 절이 이 파일을 바꿨을 수 있으면, 편집 글과 함께 파일 자신의 지금 글도 본다. 편집 글에 낱말이 없어도(perl -i, python replace) 파일의 관문 명령을 바꿀 수 있다(설계 검수 24회차 1번).
					const risky = touching.length && (touching.some((b) => !b.known) || GATED_SIGNAL.test(touching.map((b) => b.blob).join("\n")) || touching.some((b) => b.code && commandShaped(literalFileTexts(b.code, b.dir, new Set([swPath, found])))) || (found && (commandShaped([{ f: found, t: old || "" }]) || hiddenCommand(found, old))));
					// 실행하는 파일이 부르거나 읽어 들이는 도움 파일(source lib.sh, bash step.sh, python helper.py)을 앞 절이 바꿨을 수 있다(설계 검수 25회차 4번).
					// 한 단계만 본다. 앞 절 글이 도움 파일 이름을 품고, 바꾼 글을 모르거나 도움 파일·앞 절 글에 관문 낱말이 있으면 막는다.
					const helper = !risky && found && old && (earlier.length || written.size) ? helperEdited(old, path.dirname(found), dir, earlier.filter((b) => b.self !== found && b.self !== swPath), written, writtenBy) : null;
					if (risky) opaque(found ? "같은 명령의 앞 절이 바꿨을 수 있는 파일. 바꾸는 명령과 실행하는 명령을 나눌 것" : "아직 없는 파일. 파일을 만드는 명령과 실행하는 명령을 나눌 것");
					else if (helper) opaque(`같은 명령의 앞 절이 바꿨을 수 있는 도움 파일(${helper}). 바꾸는 명령과 실행하는 명령을 나눌 것`);
					else if (found) programText = old ?? undefined;
				}
			}
			if (interp && interp.text !== undefined) programText = interp.text;
			if (/^(?:source|\.)$/.test(argv[0]) && programText && /(?:^|[\s;])(?:export|unset|declare|typeset|local|readonly|set|source|\.|[A-Za-z_]\w*=)/m.test(programText)) st.uncertain=true;
			if (interp && interp.missing && !interp.file && interp.text === undefined) out.push({ argv: ["<unread-program>"], assigns: [], dir, clause, opaque: `실행기가 돌리는 프로그램 파일을 찾을 수 없음(${interp.missing}). 그 파일이 있는 디렉터리로 cd 한 뒤 실행할 것` });
			if (interp && interp.extra && interp.extra.length && depth < 4) {
				const more = interp.extra.flatMap((x) => spawnedCommands(x.text, !!x.py, dir)).join("\n");
				if (more) out.push(...effectiveCommands(more, dir, depth + 1, `${root}\n${more}`, true, shellBodyState({...entry,bodyText:interp.extra.map(x=>x.text).join("\n")},"generated")));
			}
			if (programText !== undefined && depth < 4) {
				// 셸 스크립트 파일 안은 분류기와 에이전트 관문이 따로 읽는다. 여기서는 같은 명령이 쓴 글과 해석기 프로그램만 편다.
				if (interp) {
					const spawned = spawnedCommands(programText, !!interp.py, dir).join("\n");
					if (spawned) out.push(...effectiveCommands(spawned, dir, depth + 1, `${root}\n${spawned}`, true, shellBodyState({...entry,bodyText:programText,generatedInline:interp.text !== undefined},"generated")));
				} else if (swPath && written.has(swPath)) out.push(...effectiveCommands(programText, dir, depth + 1, `${root}\n${programText}`,false,shellBodyState(entry,/^(?:source|\.)$/.test(argv[0]) ? "source" : "file")));
			}
			for (const [w, text] of writtenPaths(argv, dir, root, dirKnown, e.heredocs, written)) {
				const before = written.has(w) ? written.get(w) : readLocal(w, "/");
				written.set(w, text);
				if (text !== null && /^g?sed$/.test(head)) writtenBy.set(w, { edited: true, known: true, before: before || "", blob: "" });
				if (text === null) {
					// 원본 파일 글도 본다(sed s/a/b/ in.sh > out.sh 의 in.sh).
					// 파이프로 받은 글(printf … | tee f)은 앞 절의 인자다(설계 검수 27회차 1번).
					const src = argv.slice(1).filter((a) => !a.startsWith("-")).slice(0, 6).map((a) => readLocal(a, dir) || "").join("\n");
					const by = { known: (INLINE_EDITOR.test(head) || !!interp) && !fetches(argv), blob: withUnescaped([argv.join(" "), ...(e.heredocs || []), programText || "", src, e.piped && prev ? prev.argv.join(" ") : ""].join("\n")), refs: interp ? literalFileTexts(programText, dir, new Set([w])) : [] };
					// 앞 절도 이 파일을 글을 모르게 썼으면 그 쓴 글을 잃지 않는다. 두 sed 가 나눠 만든 관문 명령(az vm → containerapp update)을 합쳐 본다.
					const was = before === null && writtenBy.get(w);
					writtenBy.set(w, was && !was.edited ? { known: was.known && by.known, blob: `${was.blob}\n${by.blob}`, refs: [...(was.refs || []), ...by.refs] } : by);
				}
			}
			// 파일을 실행하는 것은 그 파일을 바꾸는 것이 아니다. 실행한 파일 자리의 낱말은 빼고, 그 파일이 스스로를 가리키는 글도 셈하지 않는다.
			if (!e.guess && mayWrite(argv)) earlier.push({ self: swPath, known: (INLINE_EDITOR.test(head) || !!interp) && !fetches(argv), fetch: fetches(argv), code: interp ? programText || "" : "", dir, blob: withUnescaped([argv.filter((a, k) => a !== sw && !(k === 0 && a.includes("/"))).join(" "), ...(e.heredocs || []), programText || ""].join("\n")) });
			if (clause && path.basename(String(clause[0] || "")) === "exec") {
				let allRedirs = argv.length > 0;
				for (let ri = 0; ri < argv.length;) {
					const sp = redirectSpan(argv, ri);
					if (!sp) { allRedirs = false; break; }
					ri += sp;
				}
				if (allRedirs) {
					for (let ri = 0; ri < argv.length;) {
						const sp = redirectSpan(argv, ri);
						const m = argv[ri].match(/^(\d+)?(<<<|<<-|<<|<>|<&|<)(.*)$/);
						const rhs = sp === 2 ? (argv[ri + 1] ?? "") : (m ? m[3] : "");
						if (m) {
							const rfd = m[1] ? Number(m[1]) : 0;
							if (m[2] === "<" || m[2] === "<>") {
								const res = readInputFileWord(rhs, dir, root, dirKnown, written);
								if (res.ok) st.fds.set(rfd, { program: res.text, sourceFiles: res.resolved ? [res.resolved] : [] });
								else st.fds.set(rfd, { program: null, sourceFiles: res.resolved ? [res.resolved] : [], unresolvedTarget: res.target, reason: res.reason });
							} else if (m[2] === "<&") {
								st.fds.set(rfd, rhs === "-" ? { program: null, sourceFiles: [], reason: "closed-fd" } : (/^\d+$/.test(rhs) ? (st.fds.get(Number(rhs)) || { program: null, sourceFiles: [], reason: "unbacked-fd" }) : { program: null, sourceFiles: [], reason: "unknown-dup-fd" }));
							}
						}
						ri += sp;
					}
				}
			}
			if ((SHELLS.test(argv[0]) || head === "source" || head === ".") && depth < 4) {
				const info = stdinProgramInfo(e, prev, dir, root, dirKnown, written, st.fds);
				if (info.sourceFiles && info.sourceFiles.length) entry.stdinSourceFiles = info.sourceFiles;
				if (info.unresolvedTarget) entry.stdinUnresolvedTarget = info.unresolvedTarget;
				if (info.program === null) {
					entry.stdinError = info.reason || "unverified-stdin";
					out.push({
						argv: ["<shell-stdin>"],
						assigns: [],
						dir,
						dirKnown,
						clause,
						stdinTarget: info.unresolvedTarget || (info.sourceFiles && info.sourceFiles[0]) || "",
						stdinSourceFiles: info.sourceFiles || [],
						opaque: `셸이 읽는 프로그램을 알 수 없음(${info.unresolvedTarget || argv[0]} 에 넘기는 표준 입력)`,
					});
				} else if (info.program !== undefined) {
					out.push(...effectiveCommands(info.program, dir, depth + 1, `${root}\n${info.program}`, false, shellBodyState(entry, head === "source" || head === "." ? "source" : "stdin")));
				}
			}
			prev = entry;
		}
	}
	return out;
}

/**
 * git 명령 절의 작업 디렉터리를 구한다.
 * 절의 dir에 `git -C <dir>`가 있으면 서브커맨드 이름이나 앞뒤 옵션(-c k=v 등)과 상관없이 꺼내 덮어쓴다.
 */
function gitClauseDirectory(clauseOrArgv, baseDir) {
	let argv, dir;
	if (Array.isArray(clauseOrArgv)) {
		argv = clauseOrArgv;
		dir = baseDir || process.cwd();
	} else if (clauseOrArgv && typeof clauseOrArgv === "object") {
		argv = clauseOrArgv.argv || [];
		dir = clauseOrArgv.dir || baseDir || process.cwd();
	} else {
		return path.resolve(baseDir || process.cwd());
	}
	if (!argv || argv.length === 0) return path.resolve(dir);
	const head = path.basename(argv[0] || "");
	if (head !== "git") return path.resolve(dir);

	let currentDir = path.resolve(dir);
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		if (arg === "-C" && i + 1 < argv.length) {
			const target = argv[i + 1];
			currentDir = path.resolve(currentDir, target);
			i++;
		} else if (arg.startsWith("-C") && arg.length > 2) {
			const target = arg.slice(2);
			currentDir = path.resolve(currentDir, target);
		}
	}
	return currentDir;
}

/**
 * command 전체에서 특정 git 서브커맨드(또는 git 절)의 작업 디렉터리를 구한다.
 */
function gitCommandDirectory(command, sessionCwd, subcommand) {
	const cmds = effectiveCommands(command, sessionCwd);
	if (subcommand) {
		for (const cmd of cmds) {
			const head = path.basename(cmd.argv[0] || "");
			if (head === "git" && cmd.argv.slice(1).some((a) => a === subcommand || a.startsWith(`${subcommand}=`))) {
				return gitClauseDirectory(cmd);
			}
		}
	}
	for (let i = cmds.length - 1; i >= 0; i--) {
		const head = path.basename(cmds[i].argv[0] || "");
		if (head === "git") {
			return gitClauseDirectory(cmds[i]);
		}
	}
	return cmds.length ? path.resolve(cmds[cmds.length - 1].dir) : path.resolve(sessionCwd || process.cwd());
}

const CLAUDE_VALUE_FLAGS = new Set([
	"-m", "--model", "--fallback-model", "--append-system-prompt", "--system-prompt",
	"--mcp-config", "--permission-mode", "--output-format", "--input-format",
	"--max-turns", "--add-dir", "--allowedTools", "--disallowedTools", "--tools",
	"--resume", "-r", "--session-id", "--agents", "--agent", "--betas", "--settings",
]);

const ADK_HOOK_REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const COMPOUND_OPEN_WORDS = new Set(["{", "if", "for", "while", "until", "case", "select"]);
const COMPOUND_CLOSE_PAIRS = {
	"}": "{",
	fi: "if",
	done: new Set(["for", "while", "until", "select"]),
	esac: "case",
};

function scanSubstEnd(s, from, close) {
	let depth = 0;
	let q = null;
	const hd = [];
	for (let k = from; k < s.length; k++) {
		const c = s[k];
		if (q === "'") {
			if (c === "'") q = null;
			continue;
		}
		if (c === "\\") {
			k++;
			continue;
		}
		if (q === '"') {
			if (c === '"') q = null;
			else if (c === "$" && s[k + 1] === "(") {
				const e = scanSubstEnd(s, k + 2, ")");
				if (e < 0) return -1;
				k = e;
			} else if (c === "`") {
				const e = scanSubstEnd(s, k + 1, "`");
				if (e < 0) return -1;
				k = e;
			}
			continue;
		}
		if (close === "`" && c === "`") return k;
		if (c === "'" || c === '"') {
			q = c;
			continue;
		}
		if (c === "#" && (k === from || /\s/.test(s[k - 1]))) {
			const nl = s.indexOf("\n", k);
			if (nl < 0) return -1;
			k = nl - 1;
			continue;
		}
		if (c === "<" && s[k + 1] === "<" && s[k + 2] !== "<" && s[k - 1] !== "<") {
			const m = s.slice(k).match(/^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\2/);
			if (m) {
				hd.push({ delim: m[3], strip: m[1] === "-" });
				k += m[0].length - 1;
				continue;
			}
		}
		if (c === "\n" && hd.length) {
			while (hd.length) {
				const { delim, strip } = hd.shift();
				for (;;) {
					const nl = s.indexOf("\n", k + 1);
					const line = s.slice(k + 1, nl < 0 ? s.length : nl);
					k = nl < 0 ? s.length : nl;
					if ((strip ? line.replace(/^\t+/, "") : line).trim() === delim) break;
					if (nl < 0) return -1;
				}
			}
			continue;
		}
		if (close === ")") {
			if (c === "$" && s[k + 1] === "(") {
				const e = scanSubstEnd(s, k + 2, ")");
				if (e < 0) return -1;
				k = e;
				continue;
			}
			if (c === "`") {
				const e = scanSubstEnd(s, k + 1, "`");
				if (e < 0) return -1;
				k = e;
				continue;
			}
			if (c === "(") depth++;
			else if (c === ")") {
				if (depth === 0) return k;
				depth--;
			}
		}
	}
	return -1;
}

function stripRedirectionTokens(rawTokens) {
	const out = [];
	for (let i = 0; i < rawTokens.length; i++) {
		const tok = rawTokens[i];
		if (/^(?:\d*(?:>>?|<<-?|<>|>&|<&|>\||<<<)|&>>?)$/.test(tok)) {
			i++;
			continue;
		}
		if (/^(?:\d*(?:>>?|<<-?|<>|>&|<&|>\||<<<)|&>>?)(?!\()\S/.test(tok)) {
			continue;
		}
		out.push(tok);
	}
	return out;
}

function splitClausesWithAsync(command) {
	const s = String(command || "");
	const clauses = [];
	let tokens = [];
	let token = "";
	let quote = null;
	let escaped = false;
	const groups = [];
	let groupSeq = 0;
	let lastClosedScope = null;
	let pipelineId = 1;
	let nextPiped = false;
	let pendingCoproc = false;
	const heredocs = [];

	const currentScopePath = () => groups.map((g) => g.id).join(".");
	const inCoprocScope = () => groups.some((g) => g.coproc);

	const popMatchingGroup = (closeWord) => {
		const expected = COMPOUND_CLOSE_PAIRS[closeWord];
		if (!expected || !groups.length) return null;
		for (let idx = groups.length - 1; idx >= 0; idx--) {
			const kind = groups[idx].kind;
			const matched = expected instanceof Set ? expected.has(kind) : kind === expected;
			if (matched) {
				const scopePath = groups.slice(0, idx + 1).map((g) => g.id).join(".");
				groups.splice(idx);
				return scopePath;
			}
		}
		return null;
	};

	const flushToken = () => {
		if (!token) return;
		const finished = token;
		token = "";

		const priorNonRedir = stripRedirectionTokens(tokens);
		const atClauseHead = priorNonRedir.length === 0;

		if (atClauseHead && Object.hasOwn(COMPOUND_CLOSE_PAIRS, finished)) {
			const closed = popMatchingGroup(finished);
			if (closed) {
				tokens = [];
				lastClosedScope = closed;
				return;
			}
		}

		if (tokens.length === 0) {
			tokens.scope = currentScopePath();
			tokens.pipelineId = pipelineId;
			if (nextPiped) {
				tokens.piped = true;
				tokens.prevClause = clauses[clauses.length - 1] || null;
				nextPiped = false;
			}
		}

		if (
			(atClauseHead ||
				(priorNonRedir.length === 1 && priorNonRedir[0] === "coproc") ||
				(priorNonRedir.length === 2 && priorNonRedir[0] === "coproc" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(priorNonRedir[1]))) &&
			COMPOUND_OPEN_WORDS.has(finished)
		) {
			const isCoproc = pendingCoproc || priorNonRedir[0] === "coproc";
			pendingCoproc = false;
			if (priorNonRedir[0] === "coproc") {
				tokens = [];
			}
			groups.push({ id: String(++groupSeq), kind: finished, coproc: isCoproc });
			tokens.scope = currentScopePath();
			tokens.pipelineId = pipelineId;
		} else if (atClauseHead && finished === "coproc") {
			pendingCoproc = true;
		}

		tokens.push(finished);
		if (stripRedirectionTokens(tokens).length > 0) {
			lastClosedScope = null;
		}
	};

	const flushClause = (bg = false, bgKind = null) => {
		flushToken();
		if (tokens.length) {
			const coprocInherited = inCoprocScope();
			tokens.bg = Boolean(bg || coprocInherited);
			tokens.bgKind = bg ? (bgKind || "&") : (coprocInherited ? "coproc" : null);
			clauses.push(tokens);
		}
		pendingCoproc = false;
		tokens = [];
	};

	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (escaped) {
			if (ch !== "\n") token += ch;
			escaped = false;
			continue;
		}
		if (quote === "$'") {
			if (ch === "\\") {
				token += s[i + 1] === "'" ? "'" : `\\${s[i + 1] ?? ""}`;
				i++;
				continue;
			}
			if (ch === "'") quote = null;
			else token += ch;
			continue;
		}
		if (ch === "\\" && quote === '"' && !/[$`"\\\n]/.test(s[i + 1] ?? "")) {
			token += ch;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (
			quote !== "'" &&
			(ch === "`" ||
				(ch === "$" && s[i + 1] === "(") ||
				(!quote && (ch === "<" || ch === ">") && s[i + 1] === "("))
		) {
			const arith = ch === "$" && s[i + 2] === "(";
			const from = ch === "`" ? i + 1 : i + 2;
			const end = scanSubstEnd(s, from, ch === "`" ? "`" : ")");
			if (end < 0) {
				token += s.slice(i);
				i = s.length;
				continue;
			}
			if (!arith) {
				const kind = ch === "`" ? "``" : ch === "$" ? "$()" : `${ch}()`;
				(tokens.subs = tokens.subs || []).push({ body: s.slice(from, end), kind });
			}
			token += s.slice(i, end + 1);
			i = end;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else token += ch;
			continue;
		}
		if (ch === "$" && s[i + 1] === "'") {
			quote = "$'";
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "#" && token === "") {
			const nl = s.indexOf("\n", i);
			i = (nl < 0 ? s.length : nl) - 1;
			continue;
		}
		if (ch === "<" && s[i + 1] === "<" && s[i + 2] !== "<" && s[i - 1] !== "<") {
			const m = s.slice(i).match(/^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\2/);
			if (m) {
				if (tokens.length === 0 && !token) {
					tokens.scope = currentScopePath();
					tokens.pipelineId = pipelineId;
				}
				heredocs.push({ delim: m[3], strip: m[1] === "-", targetClause: tokens });
			}
		}
		if (ch === "\n") {
			const activeClause = tokens;
			flushClause(false);
			pipelineId++;
			nextPiped = false;
			lastClosedScope = null;
			while (heredocs.length) {
				const { delim, strip, targetClause } = heredocs.shift();
				const lines = [];
				for (;;) {
					const end = s.indexOf("\n", i + 1);
					const line = s.slice(i + 1, end < 0 ? s.length : end);
					i = end < 0 ? s.length : end;
					const bare = strip ? line.replace(/^\t+/, "") : line;
					if (bare.trim() === delim || end < 0) break;
					lines.push(bare);
				}
				const owner = targetClause && targetClause.length ? targetClause : activeClause;
				if (owner) {
					(owner.heredocs = owner.heredocs || []).push(lines.join("\n"));
				}
			}
			continue;
		}
		if (/\s/.test(ch)) {
			flushToken();
			continue;
		}
		// Keep redirections like 2>&1, <&0, &>, >| inside tokens rather than splitting as '&' or '|'.
		if ((ch === "&" && /[<>]$/.test(token)) || (ch === "|" && />$/.test(token) && !/>>$/.test(token))) {
			token += ch;
			continue;
		}
		if (ch === "&" && s[i + 1] === ">") {
			flushToken();
			token = "&";
			continue;
		}
		if (ch === "&" && s[i + 1] !== "&") {
			flushToken();
			const nonRedir = stripRedirectionTokens(tokens);
			const closedScope = lastClosedScope;
			const activePipe = pipelineId;
			if (nonRedir.length > 0) {
				flushClause(true, "&");
			} else {
				tokens = [];
				if (closedScope) {
					for (const prev of clauses) {
						if (prev.scope === closedScope || String(prev.scope || "").startsWith(`${closedScope}.`)) {
							prev.bg = true;
							prev.bgKind = prev.bgKind || "&";
						}
					}
				}
			}
			for (const prev of clauses) {
				if (prev.pipelineId === activePipe) {
					prev.bg = true;
					prev.bgKind = prev.bgKind || "&";
				}
			}
			pipelineId++;
			nextPiped = false;
			lastClosedScope = null;
			continue;
		}
		if (ch === "&" && s[i + 1] === "&") {
			flushClause(false);
			pipelineId++;
			nextPiped = false;
			lastClosedScope = null;
			i++;
			continue;
		}
		if (ch === "|" && s[i + 1] === "|") {
			flushClause(false);
			pipelineId++;
			nextPiped = false;
			lastClosedScope = null;
			i++;
			continue;
		}
		if (ch === "|" && s[i + 1] === "&") {
			flushClause(false);
			nextPiped = true;
			lastClosedScope = null;
			i++;
			continue;
		}
		if (ch === "|") {
			flushClause(false);
			nextPiped = true;
			lastClosedScope = null;
			continue;
		}
		if (ch === ";") {
			flushClause(false);
			pipelineId++;
			nextPiped = false;
			lastClosedScope = null;
			continue;
		}
		if (ch === "(") {
			flushToken();
			const nonRedir = stripRedirectionTokens(tokens);
			const isCoproc =
				pendingCoproc ||
				(nonRedir.length === 1 && nonRedir[0] === "coproc") ||
				(nonRedir.length === 2 && nonRedir[0] === "coproc" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(nonRedir[1]));
			if (isCoproc) {
				tokens = [];
				pendingCoproc = false;
			} else {
				flushClause(false);
			}
			groups.push({ id: String(++groupSeq), kind: "(", coproc: isCoproc });
			lastClosedScope = null;
			continue;
		}
		if (ch === ")") {
			flushClause(false);
			const closed = popMatchingGroup_subshell(groups);
			lastClosedScope = closed;
			continue;
		}
		token += ch;
	}
	if (escaped) token += "\\";
	flushClause(false);
	for (let idx = 0; idx < clauses.length; idx++) {
		const clean = stripRedirectionTokens(clauses[idx]);
		let leadIdx = 0;
		while (leadIdx < clean.length && (RESERVED_LEAD.has(clean[leadIdx]) || ASSIGN.test(clean[leadIdx]))) leadIdx++;
		if (clean[leadIdx] === "disown" && idx > 0) {
			clauses[idx - 1].bg = true;
			clauses[idx - 1].bgKind = clauses[idx - 1].bgKind || "disown";
		}
	}
	return clauses;
}

function popMatchingGroup_subshell(groups) {
	if (!groups.length) return null;
	for (let idx = groups.length - 1; idx >= 0; idx--) {
		if (groups[idx].kind === "(") {
			const scopePath = groups.slice(0, idx + 1).map((g) => g.id).join(".");
			groups.splice(idx);
			return scopePath;
		}
	}
	const fallback = groups.map((g) => g.id).join(".");
	groups.pop();
	return fallback;
}

function findEnclosingRepoRoot(startDir) {
	const fs = require("fs");
	let cur = path.resolve(startDir || process.cwd());
	for (let depth = 0; depth < 25; depth++) {
		try {
			if (fs.existsSync(path.join(cur, ".agents")) || fs.existsSync(path.join(cur, ".git"))) {
				return cur;
			}
		} catch {}
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return null;
}

function addNormalizedAdapterPath(set, candidate, baseDir) {
	if (typeof candidate !== "string" || !candidate.trim()) return;
	const fs = require("fs");
	const abs = path.resolve(baseDir || process.cwd(), candidate.trim());
	set.add(abs);
	try {
		set.add(fs.realpathSync(abs));
	} catch {}
}

function resolveAllowedAdapterPaths(cwd, env, opts = {}) {
	const fs = require("fs");
	const allowed = new Set();
	const baseDir = path.resolve(cwd || process.cwd());
	const repoRoot = findEnclosingRepoRoot(baseDir);

	if (opts.standardAdapterPath) {
		addNormalizedAdapterPath(allowed, opts.standardAdapterPath, baseDir);
	}
	if (Array.isArray(opts.allowedAdapterPaths)) {
		for (const item of opts.allowedAdapterPaths) {
			addNormalizedAdapterPath(allowed, item, baseDir);
		}
	}
	const envAdapter = env && typeof env.ADK_WORKER_ADAPTER_PATH === "string" ? env.ADK_WORKER_ADAPTER_PATH : "";
	if (envAdapter.trim()) {
		for (const part of envAdapter.split(path.delimiter)) {
			addNormalizedAdapterPath(allowed, part, baseDir);
		}
	}
	if (repoRoot) {
		try {
			const cfgFile = path.join(repoRoot, ".agents", "config", "worker-runner.json");
			if (fs.existsSync(cfgFile)) {
				const parsed = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
				if (parsed && typeof parsed === "object") {
					addNormalizedAdapterPath(allowed, parsed.standardAdapterPath, repoRoot);
					addNormalizedAdapterPath(allowed, parsed.adapterPath, repoRoot);
					if (Array.isArray(parsed.allowedAdapterPaths)) {
						for (const item of parsed.allowedAdapterPaths) {
							addNormalizedAdapterPath(allowed, item, repoRoot);
						}
					}
				}
			}
		} catch {}
	}
	let cur = baseDir;
	for (let depth = 0; depth < 25; depth++) {
		try {
			const roleFile = path.join(cur, ".naia-role.json");
			if (fs.existsSync(roleFile)) {
				const roleCfg = JSON.parse(fs.readFileSync(roleFile, "utf8"));
				if (roleCfg && typeof roleCfg === "object") {
					addNormalizedAdapterPath(allowed, roleCfg.worker_adapter, cur);
					if (roleCfg.lead_guard && typeof roleCfg.lead_guard === "object") {
						addNormalizedAdapterPath(allowed, roleCfg.lead_guard.worker_adapter, cur);
					}
				}
				break;
			}
		} catch {}
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return { allowed, repoRoot };
}

function isSpawnWorkerPath(scriptWord, cwd, repoRoot) {
	if (typeof scriptWord !== "string" || !scriptWord || /[$`]/.test(scriptWord)) return false;
	const fs = require("fs");
	const slashNorm = scriptWord.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
	if (slashNorm === "scripts/worker-runner/spawn-worker.mjs") {
		return true;
	}
	const resolved = path.resolve(cwd || process.cwd(), scriptWord);
	const candidates = [path.resolve(ADK_HOOK_REPO_ROOT, "scripts/worker-runner/spawn-worker.mjs")];
	if (repoRoot) {
		candidates.push(path.resolve(repoRoot, "scripts/worker-runner/spawn-worker.mjs"));
	}
	const parentRepo = findEnclosingRepoRoot(path.dirname(resolved));
	if (parentRepo) {
		candidates.push(path.resolve(parentRepo, "scripts/worker-runner/spawn-worker.mjs"));
	}
	for (const candidate of candidates) {
		if (resolved === candidate) return true;
		try {
			if (fs.realpathSync(resolved) === fs.realpathSync(candidate)) return true;
		} catch {}
	}
	return false;
}

function isConfiguredAdapterPath(scriptWord, cwd, allowedSet) {
	if (!allowedSet || allowedSet.size === 0) return false;
	if (typeof scriptWord !== "string" || !scriptWord || /[$`]/.test(scriptWord)) return false;
	const fs = require("fs");
	const resolved = path.resolve(cwd || process.cwd(), scriptWord);
	if (allowedSet.has(resolved)) return true;
	try {
		if (allowedSet.has(fs.realpathSync(resolved))) return true;
	} catch {}
	return false;
}

function isAllowedStandardEntrypoint(argv, cwd, adapterCtx) {
	if (!Array.isArray(argv) || !argv.length) return false;
	const headBase = path.basename(String(argv[0] || "")).toLowerCase();

	if (isSpawnWorkerPath(argv[0], cwd, adapterCtx.repoRoot)) return true;
	if (isConfiguredAdapterPath(argv[0], cwd, adapterCtx.allowed)) return true;

	if (/^(?:node|nodejs)(?:\.exe)?$/.test(headBase)) {
		let k = 1;
		while (k < argv.length && argv[k].startsWith("-")) {
			if (/^(?:-r|--require|--import|--loader|--experimental-loader|--input-type|-C|--conditions)$/.test(argv[k])) {
				k += 2;
				continue;
			}
			if (/^(?:-e|--eval|-p|--print)$/.test(argv[k])) return false;
			if (argv[k] === "--") {
				k++;
				break;
			}
			k++;
		}
		if (k < argv.length && isSpawnWorkerPath(argv[k], cwd, adapterCtx.repoRoot)) {
			return true;
		}
		return false;
	}

	if (SHELLS.test(headBase)) {
		const inv = shellInvocation(argv, { dir: cwd });
		if (inv.command < 0 && !inv.readsStdin && inv.script >= 0 && argv[inv.script]) {
			if (isConfiguredAdapterPath(argv[inv.script], cwd, adapterCtx.allowed)) {
				return true;
			}
		}
	}

	return false;
}

function unwrapWorkerLauncherArgv(argv) {
	let cur = Array.isArray(argv) ? argv.slice() : [];
	for (let guard = 0; guard < 8 && cur.length; guard++) {
		const head = path.basename(String(cur[0] || "")).toLowerCase();
		if (/^(?:npx|pnpx|bunx|uvx)(?:\.(?:cmd|exe|js))?$/.test(head)) {
			let k = 1;
			while (k < cur.length && cur[k].startsWith("-")) {
				if (/^(?:-p|--package|-c|--call)$/.test(cur[k])) k += 2;
				else if (cur[k] === "--") { k++; break; }
				else k++;
			}
			cur = cur.slice(k);
			continue;
		}
		if (/^(?:pnpm|yarn|npm)(?:\.(?:cmd|exe|cjs|js))?$/.test(head)) {
			if (cur[1] === "dlx" || cur[1] === "exec") {
				let k = 2;
				while (k < cur.length && cur[k].startsWith("-")) {
					if (cur[k] === "--") { k++; break; }
					if (/^(?:-p|--package)$/.test(cur[k])) k += 2;
					else k++;
				}
				cur = cur.slice(k);
				continue;
			}
		}
		if (/^(?:node|nodejs|bun)(?:\.exe)?$/.test(head)) {
			let k = 1;
			while (k < cur.length && cur[k].startsWith("-")) {
				if (/^(?:-r|--require|--import|--loader|--experimental-loader|--conditions|-C)$/.test(cur[k])) k += 2;
				else if (/^(?:-e|--eval|-p|--print|--test)$/.test(cur[k])) return cur;
				else if (cur[k] === "--") { k++; break; }
				else k++;
			}
			if (k < cur.length) {
				const scriptWord = String(cur[k] || "");
				const scriptBase = path.basename(scriptWord).toLowerCase();
				if (scriptBase === "cli.mjs" && /worker-runner/.test(scriptWord.replace(/\\/g, "/")) && cur[k + 1] === "run") {
					const dashDash = cur.indexOf("--", k + 2);
					if (dashDash >= 0 && dashDash + 1 < cur.length) {
						const inner = detectDirectWorkerCli(cur.slice(dashDash + 1));
						if (inner) return cur.slice(dashDash + 1);
					}
					return ["worker-runner/cli.mjs", "run"];
				}
				cur = cur.slice(k);
				continue;
			}
		}
		break;
	}
	return cur;
}

function detectDirectWorkerCli(argv) {
	const unwrapped = unwrapWorkerLauncherArgv(argv);
	if (!unwrapped.length) return null;
	const rawHead = String(unwrapped[0] || "");
	const head = path.basename(rawHead).toLowerCase();
	const rest = unwrapped.slice(1);

	if (rawHead === "worker-runner/cli.mjs" && rest[0] === "run") {
		return "worker-runner/cli.mjs run";
	}
	if (head === "cli.mjs" && /worker-runner/.test(rawHead.replace(/\\/g, "/")) && rest[0] === "run") {
		const dashDash = rest.indexOf("--");
		if (dashDash >= 0 && dashDash + 1 < rest.length) {
			const inner = detectDirectWorkerCli(rest.slice(dashDash + 1));
			if (inner) return inner;
		}
		return "worker-runner/cli.mjs run";
	}
	if (head === "worker-runner-adapter.sh") {
		for (let idx = 0; idx < rest.length; idx++) {
			const inner = detectDirectWorkerCli(rest.slice(idx));
			if (inner) return inner;
		}
		return "worker-runner-adapter.sh";
	}

	if (/^agy(?:-cli)?(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) return "agy";
	if (/^codex(?:-cli)?(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) return "codex";

	if (/^claude(?:-code)?(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) {
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i];
			if (arg === "--") break;
			if (arg === "-p" || arg === "--print" || arg.startsWith("--print=")) return "claude -p";
			if (/^-[A-Za-z]{2,}$/.test(arg) && arg.includes("p")) return "claude -p";
			if (CLAUDE_VALUE_FLAGS.has(arg)) {
				i++;
				continue;
			}
		}
		return null;
	}

	if (/^muse(?:-bin)?(?:-[\d.]+)?(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) {
		const end = rest.indexOf("--");
		const subArgs = end >= 0 ? rest.slice(0, end) : rest;
		if (subArgs.includes("exec")) return "muse exec";
		return null;
	}

	if (/^opencode(?:-cli)?(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) {
		const end = rest.indexOf("--");
		const subArgs = end >= 0 ? rest.slice(0, end) : rest;
		if (
			subArgs.includes("run") ||
			subArgs.some((a) => a === "-p" || a === "--prompt" || a.startsWith("--prompt="))
		) {
			return "opencode run";
		}
		return null;
	}

	if (/^gemini(?:-cli)?(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) {
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i];
			if (arg === "--") break;
			if (arg === "-p" || arg === "--prompt" || arg.startsWith("--prompt=")) return "gemini -p";
			if (/^-[A-Za-z]{2,}$/.test(arg) && arg.includes("p")) return "gemini -p";
		}
		return null;
	}

	if (/^goose(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) {
		const end = rest.indexOf("--");
		const subArgs = end >= 0 ? rest.slice(0, end) : rest;
		if (subArgs.includes("run")) return "goose run";
		return null;
	}

	if (/^droid(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) {
		const end = rest.indexOf("--");
		const subArgs = end >= 0 ? rest.slice(0, end) : rest;
		if (subArgs.includes("exec")) return "droid exec";
		return null;
	}

	if (/^aider(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) {
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i];
			if (arg === "--") break;
			if (arg === "-m" || arg === "--message" || arg.startsWith("--message=") || arg === "--yes" || arg === "--yes-always") {
				return "aider";
			}
		}
		return null;
	}

	if (/^grok(?:-cli)?(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) {
		const end = rest.indexOf("--");
		const subArgs = end >= 0 ? rest.slice(0, end) : rest;
		if (subArgs.includes("exec") || subArgs.includes("run") || subArgs.some((a) => a === "-p" || a === "--prompt")) {
			return "grok";
		}
		return null;
	}

	if (/^pi(?:\.(?:c?js|mjs|sh|exe))?$/.test(head)) {
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i];
			if (arg === "--") break;
			if (arg === "-p" || arg === "--print") return "pi -p";
		}
		return null;
	}

	return null;
}

function readSmallLocalScript(fileWord, cwd) {
	if (typeof fileWord !== "string" || !fileWord || /[$`]/.test(fileWord)) return null;
	const fs = require("fs");
	try {
		const resolved = path.resolve(cwd || process.cwd(), fileWord);
		const st = fs.statSync(resolved);
		if (!st.isFile() || st.size <= 0 || st.size > 262144) return null;
		return { resolved, text: fs.readFileSync(resolved, "utf8") };
	} catch {
		return null;
	}
}

function extractProducerText(prevClause, cwd) {
	if (!prevClause || !prevClause.length) return null;
	const clean = stripRedirectionTokens(prevClause);
	let i = 0;
	while (i < clean.length && (RESERVED_LEAD.has(clean[i]) || ASSIGN.test(clean[i]) || clean[i] === "command" || clean[i] === "builtin")) {
		i++;
	}
	if (i >= clean.length) return null;
	const head = path.basename(clean[i]).toLowerCase();
	const args = clean.slice(i + 1);
	if (head === "echo") {
		let stopFlags = false;
		const words = [];
		for (const a of args) {
			if (!stopFlags && /^-[neE]+$/.test(a)) continue;
			stopFlags = true;
			words.push(a);
		}
		return words.join(" ").replace(/\\n/g, "\n");
	}
	if (head === "printf") {
		const formatted = formatPrintfPipe(args);
		if (formatted !== null) return formatted;
		return args.slice(1).join(" ").replace(/\\n/g, "\n") || (args[0] ? args[0].replace(/\\n/g, "\n") : null);
	}
	if (head === "cat") {
		if (Array.isArray(prevClause.heredocs) && prevClause.heredocs.length) {
			return prevClause.heredocs.join("\n");
		}
		const chunks = [];
		for (const a of args) {
			if (a === "--" || a.startsWith("-")) continue;
			const f = readSmallLocalScript(a, cwd);
			if (f) chunks.push(f.text);
		}
		return chunks.length ? chunks.join("\n") : null;
	}
	return null;
}

function extractClauseStdinBodies(rawClause, cwd) {
	const bodies = [];
	if (Array.isArray(rawClause.heredocs) && rawClause.heredocs.length) {
		bodies.push(...rawClause.heredocs);
	}
	for (let i = 0; i < rawClause.length; i++) {
		const tok = rawClause[i];
		if (/^\d*<<<$/.test(tok) && rawClause[i + 1] !== undefined) {
			bodies.push(rawClause[++i]);
			continue;
		}
		const gluedHere = tok.match(/^\d*<<<(.+)$/s);
		if (gluedHere) {
			bodies.push(gluedHere[1]);
			continue;
		}
		if (/^\d*<$/.test(tok) && rawClause[i + 1] !== undefined) {
			const f = readSmallLocalScript(rawClause[++i], cwd);
			if (f) bodies.push(f.text);
			continue;
		}
		const gluedIn = tok.match(/^\d*<(?![<&(>])(.+)$/);
		if (gluedIn) {
			const f = readSmallLocalScript(gluedIn[1], cwd);
			if (f) bodies.push(f.text);
		}
	}
	if (rawClause.piped && rawClause.prevClause) {
		const pipedBody = extractProducerText(rawClause.prevClause, cwd);
		if (pipedBody) bodies.push(pipedBody);
	}
	return bodies;
}

function detectInterpreterDetachedWorker(argv, effectiveDetach) {
	if (!Array.isArray(argv) || argv.length < 2) return null;
	const head = path.basename(String(argv[0] || "")).toLowerCase();
	let code = null;
	if (/^(?:node|nodejs|bun)(?:\.exe)?$/.test(head)) {
		for (let i = 1; i < argv.length; i++) {
			if ((argv[i] === "-e" || argv[i] === "--eval" || argv[i] === "-p" || argv[i] === "--print") && argv[i + 1]) {
				code = argv[i + 1];
				break;
			}
			if (!argv[i].startsWith("-")) break;
		}
	} else if (/^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/.test(head)) {
		for (let i = 1; i < argv.length; i++) {
			if (argv[i] === "-c" && argv[i + 1]) {
				code = argv[i + 1];
				break;
			}
			if (!argv[i].startsWith("-")) break;
		}
	} else if (/^(?:perl|ruby)(?:\.exe)?$/.test(head)) {
		for (let i = 1; i < argv.length; i++) {
			if (argv[i] === "-e" && argv[i + 1]) {
				code = argv[i + 1];
				break;
			}
			if (!argv[i].startsWith("-")) break;
		}
	}
	if (!code) return null;

	const hasSpawnApi =
		/\b(?:child_process|spawn|spawnSync|exec|execSync|execFile|execFileSync|subprocess\.(?:Popen|run|call|check_call|check_output)|os\.(?:system|popen|spawn\w*)|Kernel\.spawn|Process\.spawn)\b/.test(
			code,
		);
	if (!hasSpawnApi) return null;

	const inlineDetach =
		effectiveDetach ||
		(/\bdetached\s*:\s*true\b/.test(code)
			? "node detached:true"
			: /\.\s*unref\s*\(/.test(code)
				? "node unref()"
				: /\bstart_new_session\s*=\s*True\b/.test(code)
					? "python start_new_session"
					: /\bos\.setsid\b/.test(code)
						? "python os.setsid"
						: /\bsubprocess\.Popen\s*\(/.test(code) && !/\.wait\s*\(/.test(code)
							? "python Popen"
							: null);
	if (!inlineDetach) return null;

	const mWorker = code.match(/\b(agy|codex|claude|muse|opencode)\b/);
	if (!mWorker) return null;
	const bin = mWorker[1];
	if (bin === "claude" && !/(?:['"]-p['"]|['"]--print['"]|\s-p\b|\s--print\b)/.test(code)) return null;
	if (bin === "muse" && !/\bexec\b/.test(code)) return null;
	if (bin === "opencode" && !/\brun\b/.test(code)) return null;
	return {
		worker: bin === "claude" ? "claude -p" : bin === "muse" ? "muse exec" : bin === "opencode" ? "opencode run" : bin,
		detach: inlineDetach,
	};
}

function buildDetachedBlockResult(worker, effectiveDetach) {
	return {
		worker,
		detach: effectiveDetach,
		reason:
			`[Harness] 감시 밖 일꾼 분리 실행 차단: \`${worker}\` (${effectiveDetach} 분리 실행)\n` +
			"일꾼 CLI(agy·codex·claude -p/--print·muse exec·opencode run 등)를 표준 진입점 밖에서 분리 실행(nohup·setsid·systemd-run·daemonize·at/batch·disown·&·부분 셸·tmux/screen 등)하면 work-watch 감시 등록이 누락되어 멈추거나 죽어도 아무도 깨어나지 않습니다.\n" +
			"허용된 표준 진입점(spawn-worker.mjs 또는 설정된 서버 표준 어댑터 대본)을 사용하세요:\n" +
			"  node scripts/worker-runner/spawn-worker.mjs --id <작업ID> --role <역할> --work-dir <작업폴더> --watch-dir <감시폴더> --result-file <결과파일> -- <일꾼 명령...>",
	};
}

function peelLeadingWrappers(tokens, opts, depth, recurse) {
	let i = 0;
	let detach = null;

	for (let guard = 0; guard < 32 && i < tokens.length; guard++) {
		const t = tokens[i];
		if (ASSIGN.test(t) || RESERVED_LEAD.has(t)) {
			i++;
			continue;
		}
		const base = path.basename(t).toLowerCase();

		if (base === "time") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (/^(?:-f|--format|-o|--output)$/.test(tokens[i])) i += 2;
				else i++;
			}
			continue;
		}
		if (base === "coproc") {
			detach = detach || "coproc";
			i++;
			continue;
		}
		if (base === "nohup") {
			detach = detach || "nohup";
			i++;
			if (tokens[i] === "--") i++;
			continue;
		}
		if (base === "setsid") {
			detach = detach || "setsid";
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (/^-[cfw]+$/.test(tokens[i]) || /^--(?:fork|ctty|wait)$/.test(tokens[i])) {
					i++;
					continue;
				}
				break;
			}
			continue;
		}
		if (base === "daemonize") {
			detach = detach || "daemonize";
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (/^-(?:c|e|o|p|l|u|E)$/.test(tokens[i])) i += 2;
				else i++;
			}
			continue;
		}
		if (base === "daemon") {
			detach = detach || "daemon";
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				const f = tokens[i];
				if (f === "--") { i++; break; }
				if ((f === "--command" || f === "-c") && tokens[i + 1]) {
					const hit = recurse(tokens[i + 1], detach);
					if (hit) return { hit };
					i += 2;
					continue;
				}
				if (f.startsWith("--command=")) {
					const hit = recurse(f.slice("--command=".length), detach);
					if (hit) return { hit };
					i++;
					continue;
				}
				if (/^(?:-n|--name|-u|--user|-D|--chdir|-P|--pidfiles|-F|--pidfile|-o|--output|-O|--stdout|-E|--stderr|-a|--attempts|-d|--delay|-l|--limit|-M|--umask)$/.test(f)) {
					i += 2;
					continue;
				}
				i++;
			}
			continue;
		}
		if (base === "start-stop-daemon") {
			let k = i + 1;
			let isStopOrStatus = false;
			let execBin = null;
			while (k < tokens.length) {
				const f = tokens[k];
				if (f === "--") { k++; break; }
				if (/^(?:-K|--stop|-T|--status|-H|--help|-V|--version)$/.test(f)) {
					isStopOrStatus = true;
				}
				if (/^(?:-x|--exec|-a|--startas)$/.test(f) && tokens[k + 1]) {
					execBin = tokens[k + 1];
					k += 2;
					continue;
				}
				const mEq = f.match(/^--(?:exec|startas)=(.+)$/);
				if (mEq) {
					execBin = mEq[1];
					k++;
					continue;
				}
				if (/^(?:-p|--pidfile|-u|--user|-g|--group|-c|--chuid|-r|--chroot|-d|--chdir|-n|--name|-s|--signal|-R|--retry|-k|--umask|-N|--nicelevel|-P|--procsched|-I|--iosched|-O|--output)$/.test(f)) {
					k += 2;
					continue;
				}
				if (f.startsWith("-")) { k++; continue; }
				break;
			}
			if (!isStopOrStatus) {
				detach = detach || "start-stop-daemon";
				const tail = tokens.slice(k);
				if (execBin) {
					return { rest: [execBin, ...tail], detach };
				}
				i = k;
				continue;
			}
			break;
		}
		if (base === "systemd-run") {
			detach = detach || "systemd-run";
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				const f = tokens[i];
				if (f === "--") { i++; break; }
				if (/^(?:-u|--unit|-p|--property|-E|--setenv|-M|--machine|-H|--host|--slice|--description|--working-directory|--uid|--gid|--nice|--service-type|--timer-property|--on-active|--on-boot|--on-startup|--on-unit-active|--on-unit-inactive|--on-calendar|--accuracy-sec|--randomized-delay-sec)$/.test(f)) {
					i += 2;
					continue;
				}
				i++;
			}
			continue;
		}
		if (base === "sudo") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				const f = tokens[i];
				if (f === "--") { i++; break; }
				if (f === "-b" || f === "--background") {
					detach = detach || "sudo -b";
					i++;
					continue;
				}
				if (/^(?:-u|--user|-U|--other-user|-g|--group|-C|--close-from|-D|--chdir|-h|--host|-p|--prompt|-r|--role|-t|--type|-T|--command-timeout)$/.test(f)) {
					i += 2;
					continue;
				}
				if (/^-[A-Za-z]{2,}$/.test(f)) {
					if (f.includes("b")) detach = detach || "sudo -b";
					if (/[uUgCDhprtT]$/.test(f)) {
						i += 2;
						continue;
					}
				}
				i++;
			}
			continue;
		}
		if (base === "doas") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (/^-(?:u|C)$/.test(tokens[i])) i += 2;
				else i++;
			}
			continue;
		}
		if (base === "env") {
			i++;
			while (i < tokens.length) {
				const f = tokens[i];
				if (f === "--") { i++; break; }
				if (f === "-u" || f === "--unset" || f === "-C" || f === "--chdir") {
					i += 2;
					continue;
				}
				if ((f === "-S" || f === "--split-string") && tokens[i + 1]) {
					const hit = recurse(tokens[i + 1], detach);
					if (hit) return { hit };
					i += 2;
					continue;
				}
				if (f.startsWith("-") || ASSIGN.test(f)) {
					i++;
					continue;
				}
				break;
			}
			continue;
		}
		if (base === "command" || base === "exec" || base === "builtin" || base === "chronic" || base === "unbuffer" || base === "caffeinate") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				i++;
			}
			continue;
		}
		if (MULTICALL_BINARIES.includes(base)) {
			i++;
			if (tokens[i] === "--") i++;
			continue;
		}
		if (base === "nice") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (tokens[i] === "-n" || tokens[i] === "--adjustment") i += 2;
				else i++;
			}
			continue;
		}
		if (base === "ionice") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (/^(?:-c|-n|-p|--class|--classdata)$/.test(tokens[i])) i += 2;
				else i++;
			}
			continue;
		}
		if (base === "chrt") {
			i++;
			let pidMode = false;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (tokens[i] === "-p" || tokens[i] === "--pid") pidMode = true;
				i++;
			}
			if (!pidMode && i < tokens.length && /^-?\d+$/.test(tokens[i])) i++;
			continue;
		}
		if (base === "taskset") {
			i++;
			let cpuList = false;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (tokens[i] === "-c" || tokens[i] === "--cpu-list") {
					cpuList = true;
					i += 2;
					continue;
				}
				i++;
			}
			if (!cpuList && i < tokens.length) i++;
			continue;
		}
		if (base === "stdbuf") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (/^-(?:i|o|e)$/.test(tokens[i])) i += 2;
				else i++;
			}
			continue;
		}
		if (base === "timeout") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (/^(?:-k|-s|--kill-after|--signal)$/.test(tokens[i])) i += 2;
				else i++;
			}
			if (i < tokens.length) i++;
			continue;
		}
		if (base === "flock") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (/^(?:-w|--wait|--timeout|-E|--conflict-exit-code)$/.test(tokens[i])) i += 2;
				else i++;
			}
			if (i < tokens.length) i++;
			if ((tokens[i] === "-c" || tokens[i] === "--command") && tokens[i + 1]) {
				const hit = recurse(tokens[i + 1], detach);
				if (hit) return { hit };
				return { rest: [], detach };
			}
			continue;
		}
		if (base === "xargs") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (tokens[i] === "--") { i++; break; }
				if (VALUE_OPTS.xargs.test(tokens[i])) i += 2;
				else i++;
			}
			continue;
		}
		if (base === "dtach") {
			let k = i + 1;
			let detachedDtach = false;
			while (k < tokens.length && tokens[k].startsWith("-")) {
				const f = tokens[k];
				if (f === "--") { k++; break; }
				if (/^-(?:n|A|a|c)$/.test(f)) {
					if (f === "-n") detachedDtach = true;
					k += 2;
					continue;
				}
				if (/^-(?:e|r)$/.test(f)) { k += 2; continue; }
				k++;
			}
			if (detachedDtach) detach = detach || "dtach -n";
			i = k;
			continue;
		}
		if (base === "abduco") {
			let k = i + 1;
			let detachedAbduco = false;
			while (k < tokens.length && tokens[k].startsWith("-")) {
				const f = tokens[k];
				if (f === "--") { k++; break; }
				if (/^-[A-Za-z]*[nAca]$/.test(f)) {
					if (f.includes("n")) detachedAbduco = true;
					k += 2;
					continue;
				}
				if (f === "-e") { k += 2; continue; }
				k++;
			}
			if (detachedAbduco) detach = detach || "abduco -n";
			i = k;
			continue;
		}
		if (base === "tmux" && tokens[i + 1]) {
			const sub = tokens[i + 1];
			if (/^(?:new|new-session|new-window|neww|split-window|splitw|respawn-pane|respawnp|respawn-window|respawnw)$/.test(sub)) {
				let k = i + 2;
				let isDetached = sub !== "new" && sub !== "new-session";
				while (k < tokens.length && tokens[k].startsWith("-")) {
					const f = tokens[k];
					if (f === "--") { k++; break; }
					if (f === "-d" || (/^-[A-Za-z]+$/.test(f) && f.includes("d"))) isDetached = true;
					if (/^-[stcnPFxXyelpb]$/.test(f) && f !== "-b" && f !== "-d") k += 2;
					else k++;
				}
				if (isDetached) {
					detach = detach || (sub === "new" || sub === "new-session" ? "tmux -d" : `tmux ${sub}`);
					i = k;
					if (i < tokens.length && tokens.length - i === 1) {
						const nested = recurse(tokens[i], detach);
						if (nested) return { hit: nested };
					}
					continue;
				}
			}
			if (sub === "send-keys" || sub === "send") {
				let k = i + 2;
				while (k < tokens.length && tokens[k].startsWith("-")) {
					if (tokens[k] === "--") { k++; break; }
					if (/^-[tN]$/.test(tokens[k])) k += 2;
					else k++;
				}
				const keyWords = tokens.slice(k).filter((w) => !/^(?:Enter|C-m|C-j|KP_Enter)$/i.test(w));
				if (keyWords.length) {
					const nested = recurse(keyWords.join(" "), "tmux send-keys");
					if (nested) return { hit: nested };
				}
				return { rest: [], detach };
			}
			if (sub === "run-shell" || sub === "run") {
				let k = i + 2;
				while (k < tokens.length && tokens[k].startsWith("-")) {
					if (tokens[k] === "--") { k++; break; }
					if (/^-[tcd]$/.test(tokens[k])) k += 2;
					else k++;
				}
				if (k < tokens.length) {
					const nested = recurse(tokens.slice(k).join(" "), "tmux run-shell");
					if (nested) return { hit: nested };
				}
				return { rest: [], detach };
			}
		}
		if (base === "screen") {
			let k = i + 1;
			let detachedScreen = false;
			let stuffIdx = -1;
			while (k < tokens.length && tokens[k].startsWith("-")) {
				const f = tokens[k];
				if (f === "--") { k++; break; }
				if (/^-[A-Za-z]*d[A-Za-z]*m[A-Za-z]*$/.test(f) || f === "-d" || f === "-m") detachedScreen = true;
				if (f === "-X" && tokens[k + 1] === "stuff" && tokens[k + 2]) {
					stuffIdx = k + 2;
					break;
				}
				if (/^-[A-Za-z]*[Stcpeh]$/.test(f) || f === "-Logfile") k += 2;
				else k++;
			}
			if (stuffIdx >= 0) {
				const nested = recurse(tokens[stuffIdx].replace(/\\[rn]/g, "\n"), "screen -X stuff");
				if (nested) return { hit: nested };
				return { rest: [], detach };
			}
			if (detachedScreen) {
				detach = detach || "screen -dm";
				i = k;
				if (i < tokens.length && tokens.length - i === 1) {
					const nested = recurse(tokens[i], detach);
					if (nested) return { hit: nested };
				}
				continue;
			}
		}
		break;
	}

	return { rest: tokens.slice(i), detach };
}

function checkDetachedWorkerCommand(command, opts = {}) {
	const depth = opts.depth || 0;
	if (depth > 8 || !command) return null;
	const inheritedDetach = opts.inheritedDetach || null;
	const env = opts.env || process.env;
	let currentCwd = path.resolve(opts.cwd || process.cwd());
	const seenScripts = opts.seenScripts instanceof Set ? opts.seenScripts : new Set();
	const adapterCtx = opts._adapterCtx || resolveAllowedAdapterPaths(currentCwd, env, opts);
	const clauses = splitClausesWithAsync(command);

	const recurse = (subCommand, subDetach, subCwd = currentCwd, nextSeen = seenScripts) =>
		checkDetachedWorkerCommand(subCommand, {
			...opts,
			cwd: subCwd,
			env,
			inheritedDetach: subDetach,
			depth: depth + 1,
			seenScripts: nextSeen,
			_adapterCtx: adapterCtx,
		});

	for (const rawClause of clauses) {
		if (Array.isArray(rawClause.subs)) {
			for (const sub of rawClause.subs) {
				const subDetach = sub.kind === "<()" || sub.kind === ">()" ? sub.kind : null;
				const subHit = recurse(sub.body, subDetach);
				if (subHit) return subHit;
			}
		}

		const tokens = stripRedirectionTokens(rawClause);
		if (!tokens.length) continue;

		if (tokens[0] === "cd" && tokens[1] && !rawClause.scope && !/[$`]/.test(tokens[1]) && tokens[1] !== "-") {
			currentCwd = path.resolve(currentCwd, tokens[1]);
			continue;
		}

		const clauseAsyncDetach = rawClause.bg ? (rawClause.bgKind || "&") : null;
		const peeled = peelLeadingWrappers(tokens, opts, depth, (subCmd, wrapperDetach) =>
			recurse(subCmd, wrapperDetach || clauseAsyncDetach || inheritedDetach),
		);
		if (peeled.hit) return peeled.hit;

		const rest = peeled.rest || [];
		if (!rest.length) continue;

		const effectiveDetach = peeled.detach || clauseAsyncDetach || inheritedDetach;
		const headBase = path.basename(rest[0]).toLowerCase();

		// Sanctioned standard entrypoints ONLY: (1) scripts/worker-runner/spawn-worker.mjs,
		// (2) exact server standard adapter script path configured via opts/env/config.
		if (isAllowedStandardEntrypoint(rest, currentCwd, adapterCtx)) {
			continue;
		}

		// `at` / `batch` queue asynchronous execution via stdin (pipe, heredoc, herestring, `<`) or `-f <file>`.
		if (headBase === "at" || headBase === "batch") {
			let isQueryOrRemove = false;
			let jobFile = null;
			for (let k = 1; k < rest.length; k++) {
				const f = rest[k];
				if (f === "--") break;
				if (/^-(?:l|r|d|c|V)$/.test(f)) {
					isQueryOrRemove = true;
					break;
				}
				if (f === "-f" && rest[k + 1]) {
					jobFile = rest[++k];
					continue;
				}
				if (f.startsWith("-f") && f.length > 2) {
					jobFile = f.slice(2);
					continue;
				}
				if (/^-(?:q|t)$/.test(f)) {
					k++;
					continue;
				}
			}
			if (!isQueryOrRemove) {
				if (jobFile) {
					const loaded = readSmallLocalScript(jobFile, currentCwd);
					if (loaded && !seenScripts.has(loaded.resolved)) {
						const nextSeen = new Set(seenScripts);
						nextSeen.add(loaded.resolved);
						const hit = recurse(loaded.text, headBase, path.dirname(loaded.resolved), nextSeen);
						if (hit) return hit;
					}
				}
				for (const body of extractClauseStdinBodies(rawClause, currentCwd)) {
					const hit = recurse(body, headBase);
					if (hit) return hit;
				}
			}
			continue;
		}

		// `eval`, `su -c`, `script -c`
		if (headBase === "eval" && rest.length > 1) {
			const hit = recurse(rest.slice(1).join(" "), effectiveDetach);
			if (hit) return hit;
			continue;
		}
		if (headBase === "su" || headBase === "script") {
			for (let k = 1; k < rest.length; k++) {
				const f = rest[k];
				if ((f === "-c" || f === "--command" || f === "--session-command") && rest[k + 1]) {
					const hit = recurse(rest[k + 1], effectiveDetach);
					if (hit) return hit;
					break;
				}
				if (f.startsWith("--command=")) {
					const hit = recurse(f.slice("--command=".length), effectiveDetach);
					if (hit) return hit;
					break;
				}
				if (/^-[A-Za-z]*c$/.test(f) && rest[k + 1]) {
					const hit = recurse(rest[k + 1], effectiveDetach);
					if (hit) return hit;
					break;
				}
			}
			continue;
		}

		// Shell invocations: `-c <script>`, local script file, or stdin (pipe / heredoc / herestring / `<`).
		if (SHELLS.test(headBase)) {
			const inv = shellInvocation(rest, { dir: currentCwd });
			if (inv.noexec) continue;
			if (inv.command >= 0 && rest[inv.command]) {
				const hit = recurse(rest[inv.command], effectiveDetach);
				if (hit) return hit;
				continue;
			}
			if (inv.script >= 0 && rest[inv.script]) {
				const scriptWord = rest[inv.script];
				if (path.basename(scriptWord).toLowerCase() === "worker-runner-adapter.sh") {
					const adapterWorker = detectDirectWorkerCli(rest.slice(inv.script));
					if (adapterWorker && effectiveDetach) {
						return buildDetachedBlockResult(adapterWorker, effectiveDetach);
					}
				}
				const loaded = readSmallLocalScript(scriptWord, currentCwd);
				if (loaded && !seenScripts.has(loaded.resolved)) {
					const nextSeen = new Set(seenScripts);
					nextSeen.add(loaded.resolved);
					const hit = recurse(loaded.text, effectiveDetach, path.dirname(loaded.resolved), nextSeen);
					if (hit) return hit;
				}
				continue;
			}
			for (const body of extractClauseStdinBodies(rawClause, currentCwd)) {
				const hit = recurse(body, effectiveDetach);
				if (hit) return hit;
			}
			continue;
		}

		// `source` / `.` reading local script
		if ((headBase === "source" || headBase === ".") && rest[1]) {
			const loaded = readSmallLocalScript(rest[1], currentCwd);
			if (loaded && !seenScripts.has(loaded.resolved)) {
				const nextSeen = new Set(seenScripts);
				nextSeen.add(loaded.resolved);
				const hit = recurse(loaded.text, effectiveDetach, path.dirname(loaded.resolved), nextSeen);
				if (hit) return hit;
			}
			continue;
		}

		// Inline interpreter detached spawns (`node -e`, `python -c`, `perl -e`, `ruby -e`).
		const interpHit = detectInterpreterDetachedWorker(rest, effectiveDetach);
		if (interpHit) {
			return buildDetachedBlockResult(interpHit.worker, interpHit.detach);
		}

		// Direct worker CLI check (also block `--allow-unregistered-test` on worker-runner/cli.mjs run in shell commands).
		const worker = detectDirectWorkerCli(rest);
		if (worker) {
			const dashDashIdx = rest.indexOf("--");
			const preDash = dashDashIdx >= 0 ? rest.slice(0, dashDashIdx) : rest;
			if (preDash.includes("--allow-unregistered-test") && rest.some((t) => /cli\.mjs$/i.test(t))) {
				return buildDetachedBlockResult("worker-runner/cli.mjs run", "--allow-unregistered-test");
			}
			if (effectiveDetach) {
				return buildDetachedBlockResult(worker, effectiveDetach);
			}
		}

		// Direct executable local shell script (`nohup ./launch.sh &`) not in standard entrypoint allowlist.
		if (rest[0].includes("/") || rest[0].endsWith(".sh")) {
			const loaded = readSmallLocalScript(rest[0], currentCwd);
			if (loaded && !seenScripts.has(loaded.resolved) && /^(?:#!.*\b(?:sh|bash|dash|zsh|ksh)\b|\s*(?:nohup|setsid|systemd-run|codex|agy|claude|muse|opencode)\b)/m.test(loaded.text)) {
				const nextSeen = new Set(seenScripts);
				nextSeen.add(loaded.resolved);
				const hit = recurse(loaded.text, effectiveDetach, path.dirname(loaded.resolved), nextSeen);
				if (hit) return hit;
			}
		}
	}
	return null;
}

module.exports = {
	withLiteralValuesCache,
	readCachedText,
	shellClauses,
	shellBodyState,
	sourceFile,
	sourceTargetIndex,
	stdinProgram,
	stdinProgramInfo,
	fdStdinSpec,
	extractReadSubFile,
	expandClause,
	effectiveCommands,
	stripReserved,
	MULTICALL_BINARIES,
	ARGV_WRAPPERS,
	VALUE_OPTS,
	RESERVED_LEAD,
	NOT_COMMAND,
	SHELL_NAMES,
	SHELL_ALT,
	SHELLS,
	dynamicWord,
	shellInvocation,
	redirectSpan,
	resolvePathWord,
	GATED_SIGNAL,
	writtenPaths,
	interpreterProgram,
	gitClauseDirectory,
	gitCommandDirectory,
	checkDetachedWorkerCommand,
};

