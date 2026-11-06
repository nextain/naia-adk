"use strict";

// An unquoted newline ends a clause like ";" does, a backslash-newline joins lines, and heredoc
// bodies are text rather than commands (2026-09-25 harness audit, design review round 10 hole 1:
// a deploy or agent run on the second line of a multi-line command was part of the first clause).
// Round 11 hole 1: a comment is skipped to the end of its line (an apostrophe in "# user's …" opened a
// quote that swallowed every later line), $'…' and double-quote backslashes follow bash, and an open
// quote at the end sets clauses.unbalanced so a gate can fail closed. Each clause array also carries
// .piped (its stdin is the previous clause's output) and .heredocs (bodies fed to it), so a shell
// that reads its program from stdin can be read (round 11 hole 2).
// Round 12 hole 2: text bash runs as a program inside a word ($(…) inside or outside double quotes,
// backticks, <(…), >(…)) is recorded on its clause as .subs, and kept literally in the word. Arithmetic
// $((…)) is not a program. The scanner skips quotes, comments and heredoc bodies inside the substitution,
// so an odd quote in a commit message written as "$(cat <<'EOF' … EOF)" does not unbalance the command.
function scanTo(s, i, close) {
	let depth = 0, q = null;
	const hd = [];
	for (let k = i; k < s.length; k++) {
		const c = s[k];
		if (q === "'") { if (c === "'") q = null; continue; }
		if (c === "\\") { k++; continue; }
		if (q === '"') {
			if (c === '"') q = null;
			else if (c === "$" && s[k + 1] === "(") { const e = scanTo(s, k + 2, ")"); if (e < 0) return -1; k = e; }
			else if (c === "`") { const e = scanTo(s, k + 1, "`"); if (e < 0) return -1; k = e; }
			continue;
		}
		if (close === "`" && c === "`") return k;
		if (c === "'" || c === '"') { q = c; continue; }
		if (c === "#" && (k === i || /\s/.test(s[k - 1]))) { const nl = s.indexOf("\n", k); if (nl < 0) return -1; k = nl - 1; continue; }
		if (c === "<" && s[k + 1] === "<" && s[k + 2] !== "<" && s[k - 1] !== "<") {
			const m = s.slice(k).match(/^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\2/);
			if (m) { hd.push({ delim: m[3], strip: m[1] === "-" }); k += m[0].length - 1; continue; }
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
			if (c === "$" && s[k + 1] === "(") { const e = scanTo(s, k + 2, ")"); if (e < 0) return -1; k = e; continue; }
			if (c === "`") { const e = scanTo(s, k + 1, "`"); if (e < 0) return -1; k = e; continue; }
			if (c === "(") depth++;
			else if (c === ")") { if (depth === 0) return k; depth--; }
		}
	}
	return -1;
}

// Round 13 hole 1: the body of a heredoc whose delimiter is not quoted is expanded like double-quoted
// text, so $(…) and backticks in it run ("gh pr create --body \"$(cat <<EOF … `deploy.sh prod` … EOF)\"").
// Returns the programs found, or null when a substitution is not closed.
function bodySubs(text) {
	const subs = [];
	for (let k = 0; k < text.length; k++) {
		const c = text[k];
		if (c === "\\") { k++; continue; }
		if (c !== "`" && !(c === "$" && text[k + 1] === "(")) continue;
		const arith = c === "$" && text[k + 2] === "(";
		const from = c === "`" ? k + 1 : k + 2;
		const e = scanTo(text, from, c === "`" ? "`" : ")");
		if (e < 0) return null;
		if (!arith) subs.push(text.slice(from, e));
		k = e;
	}
	return subs;
}

function shellClauses(command) {
	const clauses = [];
	const s = String(command);
	let tokens = [], token = "", quote = null, escaped = false, sep = "", broken = false;
	const heredocs = [];
	// 서브셸 "( … )" 의 경계. 절마다 자기가 든 서브셸들의 번호 경로(scope)를 단다. 서브셸 안의 cd 는 밖으로 새지 않는다(설계 검수 18회차 2번).
	const groups = [];
	let groupSeq = 0;
	const flushToken = () => {
		if (!token) return;
		if (tokens.length === 0) { if (sep === "|" || sep === "|&") tokens.piped = true; sep = ""; tokens.scope = groups.join("."); }
		tokens.push(token);
		token = "";
	};
	const flushClause = () => { flushToken(); if (tokens.length) clauses.push(tokens); tokens = []; };
	for (let i = 0; i < s.length; i++) {
		const char = s[i];
		if (escaped) { if (char !== "\n") token += char; escaped = false; continue; }
		if (quote === "$'") {
			if (char === "\\") { token += s[i + 1] === "'" ? "'" : `\\${s[i + 1] ?? ""}`; i++; continue; }
			if (char === "'") quote = null; else token += char;
			continue;
		}
		if (char === "\\" && quote === '"' && !/[$`"\\\n]/.test(s[i + 1] ?? "")) { token += char; continue; }
		if (char === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote !== "'" && (char === "`" || (char === "$" && s[i + 1] === "(") || (!quote && (char === "<" || char === ">") && s[i + 1] === "("))) {
			const arith = char === "$" && s[i + 2] === "(";
			const from = char === "`" ? i + 1 : i + 2;
			const e = scanTo(s, from, char === "`" ? "`" : ")");
			if (e < 0) { broken = true; token += s.slice(i); i = s.length; continue; }
			if (!arith) (tokens.subs = tokens.subs || []).push(s.slice(from, e));
			token += s.slice(i, e + 1);
			i = e;
			continue;
		}
		if (quote) { if (char === quote) quote = null; else token += char; continue; }
		if (char === "$" && s[i + 1] === "'") { quote = "$'"; i++; continue; }
		if (char === "'" || char === '"') { quote = char; continue; }
		if (char === "#" && token === "") {
			const nl = s.indexOf("\n", i);
			i = (nl < 0 ? s.length : nl) - 1;
			continue;
		}
		if (char === "<" && s[i + 1] === "<" && s[i + 2] !== "<" && s[i - 1] !== "<") {
			const m = s.slice(i).match(/^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\2/);
			if (m) heredocs.push({ delim: m[3], strip: m[1] === "-", quoted: !!m[2], owner: tokens });
		}
		if (char === "\n") {
			flushClause();
			sep = "\n";
			while (heredocs.length) {
				const { delim, strip, quoted, owner } = heredocs.shift();
				const body = [];
				let end = s.indexOf("\n", i + 1);
				for (;;) {
					const line = s.slice(i + 1, end < 0 ? s.length : end);
					i = end < 0 ? s.length : end;
					const bare = strip ? line.replace(/^\t+/, "") : line;
					if (bare.trim() === delim) break;
					body.push(bare);
					if (end < 0) break;
					end = s.indexOf("\n", i + 1);
				}
				owner.heredocs = [...(owner.heredocs || []), body.join("\n")];
				if (!quoted) {
					const subs = bodySubs(body.join("\n"));
					if (subs === null) broken = true;
					else if (subs.length) owner.subs = [...(owner.subs || []), ...subs];
				}
			}
			continue;
		}
		if (/\s/.test(char)) { flushToken(); continue; }
		// ">&", "<&", "&>", "&>>", ">|" 의 & 와 | 는 리다이렉션의 일부이지 절 구분자가 아니다(설계 검수 15회차 2번:
		// "bash >log 2>&1 <<'EOF'" 가 "1" 로 시작하는 절에 heredoc 을 붙여 셸 프로그램을 숨겼다).
		if ((char === "&" && /[<>]$/.test(token)) || (char === "|" && />$/.test(token) && !/>>$/.test(token))) { token += char; continue; }
		if (char === "&" && s[i + 1] === ">") { flushToken(); token = "&"; continue; }
		if (/[;&|()]/.test(char)) {
			flushClause();
			if (char === "(") groups.push(++groupSeq);
			else if (char === ")") groups.pop();
			sep += char;
			continue;
		}
		token += char;
	}
	if (escaped) token += "\\";
	flushClause();
	if (quote || broken) clauses.unbalanced = true;
	return clauses;
}

function findGitSubcommandArgv(command, subcommand) {
	const valueOptions = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
	const matches = [];
	for (const tokens of shellClauses(command)) {
		for (let gitIndex = 0; gitIndex < tokens.length; gitIndex++) {
			if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(tokens[gitIndex])) continue;
			let index = gitIndex + 1;
			while (index < tokens.length) {
				const current = tokens[index];
				if (current === subcommand) { matches.push(tokens.slice(index + 1)); break; }
				if (valueOptions.has(current)) { index += 2; continue; }
				if (/^-c.+/.test(current) || /^--(?:git-dir|work-tree|namespace|config-env)=/.test(current)) { index++; continue; }
				if (current.startsWith("-")) { index++; continue; }
				break;
			}
		}
	}
	return matches;
}

module.exports = { findGitSubcommandArgv, shellClauses };
