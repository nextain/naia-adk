"use strict";
/**
 * 셸 명령에서 "운영 서비스를 바꾸는 명령"을 찾는다.
 *
 * 목록에 명령 형태를 하나씩 더하는 대신 일반 규칙 부류로 잡는다:
 * - az <앱·VM 그룹> <동사...>: 동사 경로에 읽기 동사(show·list·logs 등)가 없으면 변경이다.
 * - gcloud / vercel / kubectl / helm / terraform / fly / wrangler / railway / supabase 운영 배포 명령.
 * - ssh / scp 로 비개발(운영) 호스트에 원격 변경·파일 복사.
 * - 이름이 deploy 를 담은 스크립트(또는 npm run 스크립트)를 prod 인자로 실행.
 * - 인스턴스 확장(config/deploy-gate.json 의 prodPatterns·sshAlwaysGated·plugin.classifyCommand).
 *
 * 대상 이름이나 리소스 그룹에 dev·staging·preview·test 표시가 없으면 운영으로 본다.
 * 모르는 대상은 막는 쪽으로 기운다.
 */
const fs = require("fs");
const path = require("path");

const AZ_GROUPS = new Set(["containerapp", "webapp", "functionapp", "staticwebapp", "vm", "vmss", "aks", "spring"]);
const READ_VERBS = new Set(["show", "list", "logs", "log", "browse", "tail", "get", "wait", "list-sizes", "list-usage", "get-instance-view", "show-deleted"]);
const EXTRA_AZ_READ_VERBS = new Set(["query", "exists", "check-name", "check-name-availability", "download"]);
// 변수 프로그램("$AZ_BIN" <그룹> …)을 az 로 볼 때 쓰는 az 최상위 그룹 이름.
const AZ_TOP_GROUPS = new Set([...AZ_GROUPS, "network", "group", "storage", "keyvault", "acr", "monitor", "deployment", "resource", "role", "ad", "sql", "postgres", "mysql", "cosmosdb", "redis", "cdn", "afd", "apim", "appconfig", "eventhubs", "servicebus", "identity", "dns", "container", "disk", "snapshot", "image", "sig", "lock", "policy", "tag", "backup", "batch", "functionapp", "signalr", "search", "cognitiveservices", "ml", "iot", "eventgrid", "relay", "logicapp", "appservice", "provider", "feature", "rest", "resourcemanagement", "managedapp", "dla", "dls", "hdinsight", "kusto", "synapse", "datafactory", "databricks", "vmss", "sshkey", "netappfiles", "private-link", "lab", "maintenance", "advisor", "billing", "consumption", "costmanagement", "security", "sf", "spring", "staticwebapp", "webapp", "vm", "aks", "containerapp"]);
const AZ_LOCAL_GROUPS = new Set(["account", "config", "extension", "cache", "bicep"]);
const AZ_LOCAL_COMMANDS = new Set(["login", "logout", "version", "upgrade", "find", "interactive", "init", "self-test", "feedback", "survey"]);
const NON_PROD = /(?:^|[-_.\/])(dev|develop|development|staging|stage|stg|preview|test|testing|sandbox|local)(?:[-_.\/]|$)/i;
const PROD_ARG = /^(?:--?)?(prod|production|live)$/i;
// 스크립트 이름·인자·--k=v·앞의 KEY=value 어디든 prod 가 단어로 있으면 운영이다(설계 검수 7회차 3번: deploy-prod.sh, ENV=prod ./deploy.sh).
const PROD_WORD = /(?:^|[-_.\/=:])(prod|production|live)(?:[-_.\/:]|$)/i;
const INTERPRETERS = /(?:^|\/)(?:bash|sh|zsh|dash|node|python3?|pwsh|bun|deno|tsx|ts-node)$/;
const SHELL_RE = /(?:^|\/)(?:bash|sh|zsh|dash|ksh)$/;

// 셸에서 흔히 쓰는 ANSI-C 이스케이프를 풀어 명령 글자를 비교한다.
function gateUnescapeAnsi(s) {
	return s.replace(/\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|(.))/gs, (_, hex, u, U, oct, other) => {
		if (hex || u || U || oct) {
			const n = parseInt(hex || u || U || oct, oct ? 8 : 16);
			return n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd";
		}
		return ({ a:"\x07", b:"\b", e:"\x1b", E:"\x1b", f:"\f", n:"\n", r:"\r", t:"\t", v:"\v", "\\":"\\", "'":"'", '"':'"' })[other] ?? `\\${other}`;
	});
}
function gateNormalize(command) {
	let out = "", mode = "";
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (!mode && c === "$" && command[i + 1] === "'") { mode = "ansi"; i++; continue; }
		if (!mode && (c === "'" || c === '"')) { mode = c; continue; }
		if (mode && c === (mode === "ansi" ? "'" : mode)) { mode = ""; continue; }
		if (c === "\\" && mode === "ansi" && i + 1 < command.length) {
			const m = command.slice(i).match(/^\\(?:x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/);
			out += gateUnescapeAnsi(m[0]); i += m[0].length - 1; continue;
		}
		if (c === "\\" && mode !== "'" && i + 1 < command.length) {
			if (mode === '"' && !/[\\$`"\n]/.test(command[i + 1])) { out += c; continue; }
			out += command[++i]; continue;
		}
		out += c;
	}
	// 대입은 여러 번 있을 수 있다. 단일 값이라고 증명할 수 없는 이름은 치환하지 않는다.
	const values = new Map(), ambiguous = new Set();
	for (const m of out.matchAll(/(?:^|[\s;|&()])(?:export\s+|declare\s+|local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)(\+?=)([^\s;|&()]*)/g)) {
		if (m[2] === "+=") {
			if (!values.has(m[1])) ambiguous.add(m[1]);
			else values.set(m[1], values.get(m[1]) + m[3]);
		} else {
			if (values.has(m[1]) && values.get(m[1]) !== m[3]) ambiguous.add(m[1]);
			values.set(m[1], m[3]);
		}
	}
	for (const m of out.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\/[^}]*|:\s*-?\d[^}]*)\}|\b(?:read(?:\s+-[a-z]+)*|printf\s+-v)\s+([A-Za-z_][A-Za-z0-9_]*)|\b([A-Za-z_][A-Za-z0-9_]*)\s*\[[^\]]*\]\s*\+?=/gi)) ambiguous.add(m[1] || m[2] || m[3]);
	for (const m of out.matchAll(/\bread\b([^;|&\n]*)/g)) {
		for (const word of m[1].split(/\s+/)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) ambiguous.add(word);
	}
	for (let i = 0; i < 10; i++) {
		const next = out.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (all, a, b) => {
			const key = a || b;
			return !ambiguous.has(key) && values.has(key) ? values.get(key) : all;
		});
		if (next === out) break;
		out = next;
	}
	return out.normalize("NFKC");
}

// 셸 주석만 제거한다. 인라인 코드의 따옴표 안 # 은 그대로 보존한다.
function gateWithoutComments(text) {
	let out = "", quote = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\\" && quote !== "'" && i + 1 < text.length) { out += c + text[++i]; continue; }
		if (quote) { if (c === quote) quote = ""; out += c; continue; }
		if (c === "'" || c === '"') { quote = c; out += c; continue; }
		if (c === "#" && (i === 0 || /[\s;|&()]/.test(text[i - 1]))) {
			while (i < text.length && text[i] !== "\n") i++;
			if (i < text.length) out += "\n";
			continue;
		}
		out += c;
	}
	return out;
}

// 문자열과 주석을 구별한다. 위치와 공백은 접기에서 보존하고 주석만 공백으로 바꾼다.
function gateCodeTokens(code, language = "") {
	const tokens = [];
	let clean = "", failed = false;
	const js = /^(?:node|bun|deno)$/.test(language);
	for (let i = 0; i < code.length;) {
		const start = i, c = code[i], next = code[i + 1];
		if (/\s/.test(c)) { clean += c; i++; continue; }
		if ((js && c === "/" && (next === "/" || next === "*")) || (!js && c === "#")) {
			if (c === "/" && next === "*") {
				const end = code.indexOf("*/", i + 2);
				if (end < 0) { failed = true; i = code.length; } else i = end + 2;
			} else { while (i < code.length && code[i] !== "\n") i++; }
			clean += code.slice(start, i).replace(/[^\n]/g, " "); continue;
		}
		if (js && c === "/" && next !== "=") {
			const prev = tokens[tokens.length - 1];
			if (!prev || !(prev.type === "identifier" || prev.type === "number" || prev.type === "string" || prev.type === "regex" || [")", "]", "}"].includes(prev.value))) {
				let j = i + 1, inClass = false, closed = false;
				while (j < code.length && code[j] !== "\n" && code[j] !== "\r") {
					if (code[j] === "\\") { j += 2; continue; }
					if (code[j] === "[") inClass = true;
					else if (code[j] === "]") inClass = false;
					else if (code[j] === "/" && !inClass) { closed = true; j++; break; }
					j++;
				}
				if (closed) {
					while (/[A-Za-z]/.test(code[j] || "")) j++;
					i = j; tokens.push({ type: "regex", value: code.slice(start, i) });
					clean += code.slice(start, i).replace(/[^\n]/g, " "); continue;
				}
			}
		}
		if (c === '"' || c === "'" || (js && c === "`")) {
			const triple = !js && code.slice(i, i + 3) === c.repeat(3);
			const delimiter = triple ? c.repeat(3) : c;
			i += delimiter.length;
			let closed = false;
			while (i < code.length) {
				if (code[i] === "\\") { i += 2; continue; }
				if (code.slice(i, i + delimiter.length) === delimiter) { i += delimiter.length; closed = true; break; }
				if (!triple && c !== "`" && code[i] === "\n") break;
				i++;
			}
			if (!closed) failed = true;
			const value = code.slice(start, i); tokens.push({ type: "string", value }); clean += value; continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			i++; while (i < code.length && /[\w$]/.test(code[i])) i++;
			const value = code.slice(start, i); tokens.push({ type: "identifier", value }); clean += value; continue;
		}
		if (/[0-9]/.test(c)) {
			i++; while (i < code.length && /[\w.]/.test(code[i])) i++;
			const value = code.slice(start, i); tokens.push({ type: "number", value }); clean += value; continue;
		}
		i++; tokens.push({ type: "punctuation", value: c }); clean += c;
	}
	return { tokens, clean, failed };
}

function gateCodeWithoutStringContents(code, language) {
	const { clean, tokens } = gateCodeTokens(code, language);
	let out = clean, from = 0;
	for (const token of tokens) {
		const at = clean.indexOf(token.value, from);
		if (at < 0) continue;
		from = at + token.value.length;
		if (token.type !== "string" || token.value.startsWith("`")) continue;
		if (/^['"]request['"]$/.test(token.value) && /\[\s*$/.test(clean.slice(0, at))) continue;
		out = out.slice(0, at) + token.value.replace(/[^\n]/g, " ") + out.slice(from);
	}
	return out;
}

// 인터프리터 인자에서 글자 상수만 접는다. 코드를 실행하거나 동적 식을 평가하지 않는다.
function gateFoldLiterals(code, state = {}, language = "") {
	const lexical = gateCodeTokens(code, language);
	state.lexicalFailure = lexical.failed;
	code = lexical.clean;
	const literal = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\$]|\$(?!\{))*\x60)`;
	const parts = new RegExp(literal, "g");
	const decode = (s) => s.slice(1, -1).replace(/\\([\\'"`])/g, "$1");
	const join = new RegExp(String.raw`\[((?:\s*${literal}\s*,)*\s*${literal}\s*,?\s*)\]\s*\.\s*join\s*\(\s*(?:""|''|\x60\x60)\s*\)`, "g");
	const pythonJoin = new RegExp(String.raw`(?:""|''|\x60\x60)\s*\.\s*join\s*\(\s*\[((?:\s*${literal}\s*,)*\s*${literal}\s*,?\s*)\]\s*\)`, "g");
	const perlJoin = new RegExp(String.raw`\bjoin\s*\(\s*(?:""|''|\x60\x60)\s*,\s*((?:\s*${literal}\s*,)*\s*${literal}\s*,?\s*)\)`, "g");
	const concat = new RegExp(String.raw`${literal}(?:(?:\s*[+.]\s*|\s+)${literal})+`, "g");
	let folded = code;
	let converged = false;
	for (let i = 0; i <= code.length * 2 + 1; i++) {
		const wrapped = new RegExp(String.raw`\(\s*(${literal})\s*\)`, "g");
		const interpolation = new RegExp(String.raw`\$\{\s*(${literal})\s*\}`, "g");
		const templates = folded.replace(/`(?:\\.|[^`])*`/g, template => {
			const value = template.slice(1, -1).replace(interpolation, (_, part) => decode(part));
			return value.includes("${") ? template : JSON.stringify(value);
		});
		const next = templates.replace(wrapped, (all, value, offset) => /[\w$)]\s*$/.test(templates.slice(0, offset)) ? all : value).replace(concat, (m) => JSON.stringify([...m.matchAll(parts)].map(x => decode(x[0])).join("")))
			.replace(join, (_, list) => JSON.stringify([...list.matchAll(parts)].map(m => decode(m[0])).join("")))
			.replace(pythonJoin, (_, list) => JSON.stringify([...list.matchAll(parts)].map(m => decode(m[0])).join("")))
			.replace(perlJoin, (_, list) => JSON.stringify([...list.matchAll(parts)].map(m => decode(m[0])).join("")));
		if (next === folded) { converged = true; break; }
		folded = next;
	}
	state.exhausted = !converged;
	const remaining = gateCodeTokens(folded, language).tokens;
	state.unfolded = remaining.some((t, i) => {
		if (t.type !== "string") return false;
		let j = i + 1;
		while (remaining[j]?.value === ")") j++;
		if (remaining[j]?.value === "+") return true;
		if (remaining[j]?.value === "." && remaining[j + 1]?.type === "string") return true;
		while (remaining[j]?.value === "(") j++;
		return remaining[j]?.type === "string" || /\$\{/.test(t.value);
	}) || (remaining.some(t => t.type === "string") && remaining.some(t => t.type === "identifier" && t.value === "join"));
	return folded;
}

// 하나의 인터프리터 호출에서 실제 코드 인자를 추출한다. 프로그램은 실행하지 않는다.
function gateInlineCode(argv, state = {}) {
	const tool = path.basename(argv[0] || "");
	const shell = /^(?:bash|sh|dash|zsh|ksh)$/.test(tool);
	if (shell) {
		const i = require("./effective-argv.js").shellInvocation(argv).command;
		const options = i >= 0 ? argv.slice(1, i) : argv.slice(1);
		const inlineSeen = options.some(a => /^-[a-z]*c[a-z]*$/i.test(a));
		state.unresolved = inlineSeen && (i < 0 || options.some(a => /^--/.test(a) && !/^--(?:noprofile|norc|posix|restricted|login|verbose|debugger|rcfile|init-file)$/.test(a)));
		return i >= 0 ? argv[i] : null;
	}
	if (!/^(?:node|deno|bun|python\d*|perl|ruby)$/.test(tool)) return null;
	if (tool === "deno") {
		const index = argv.indexOf("eval");
		if (index >= 0) return argv[index + 1] ?? null;
	}
	const letters = /^(?:node|deno|bun)$/.test(tool) ? "ep" : /^python/.test(tool) ? "c" : tool === "perl" ? "eE" : "e";
	let unknown = false;
	const needsValue = /^(?:--require|--import|--loader|--experimental-loader|--input-type|--conditions|--inspect-port|--title|--openssl-config|--env-file|-r)$/;
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") { unknown = true; continue; }
		if (/^(?:node|deno|bun)$/.test(tool) && /^--(?:eval|print)(?:=|$)/.test(a)) {
			const code = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
			state.unresolved = unknown || code === undefined; return code ?? null;
		}
		if (/^(?:node|deno|bun)$/.test(tool) && /^-pe/.test(a)) { const code = a.slice(3) || argv[i + 1]; state.unresolved = unknown || code === undefined; return code ?? null; }
		if (/^--/.test(a)) {
			if (tool === "node" && needsValue.test(a)) { i++; continue; }
			if (tool === "node" && /^(?:(?:--no-warnings|--no-deprecation|--trace-warnings|--trace-deprecation|--no-addons|--no-global-search-paths|--no-experimental-fetch|--enable-source-maps|--expose-gc)|(?:--disable-warning|--input-type|--require|--import|--conditions|--inspect)=.+|--inspect)$/.test(a)) continue;
			unknown = true; continue;
		}
		if (!/^-[^-]/.test(a)) { unknown = true; continue; }
		if (tool === "node" && /^-r/.test(a)) { if (a === "-r") i++; continue; }
		for (let j = 1; j < a.length; j++) if (letters.includes(a[j])) { const code = a.slice(j + 1) || argv[i + 1]; state.unresolved = unknown || code === undefined; return code ?? null; }
		if (!(tool === "node" ? /^-[civ]+$/.test(a) : /^python/.test(tool) ? /^-[IEsSuUvVbBdOqRx]+$/.test(a) : tool === "perl" ? /^-[lnwWMsST]+$/.test(a) : /^-[wWv]+$/.test(a))) unknown = true;
	}
	state.unresolved = false;
	return null;
}

// 코드의 출력 인자와 자유 문자열을 증거에서 빼고 실제 호출 인자만 남긴다.
function gateInlineEvidence(code, language) {
	const folded = gateFoldLiterals(code, {}, language);
	const lexical = gateCodeTokens(folded, language);
	let mask = lexical.clean, cursor = 0;
	for (const token of lexical.tokens) {
		const at = lexical.clean.indexOf(token.value, cursor);
		if (at < 0) continue;
		cursor = at + token.value.length;
		if (token.type === "string" || token.type === "regex") mask = mask.slice(0, at) + token.value.replace(/[^\n]/g, " ") + mask.slice(cursor);
	}
	const calls = (pattern, view = mask) => {
		const found = [];
		for (const match of view.matchAll(pattern)) {
			const open = match.index + match[0].lastIndexOf("(");
			let depth = 1, end = open + 1;
			for (; end < view.length && depth; end++) {
				if (view[end] === "(") depth++;
				else if (view[end] === ")") depth--;
			}
			if (!depth) found.push({ start: match.index, open, end, args: lexical.clean.slice(open + 1, end - 1) });
		}
		return found;
	};
	for (const output of calls(/(?:^|[^\w$.])(?:console\.(?:log|info|warn|error|debug)|process\.stdout\.write|process\.stderr\.write|print)\s*\(/g)) {
		mask = mask.slice(0, output.open + 1) + mask.slice(output.open + 1, output.end - 1).replace(/[^\n]/g, " ") + mask.slice(output.end - 1);
	}
	const method = "(?:get|post|put|patch|delete|head|options|request|stream)";
	const receivers = new Set();
	for (const match of mask.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:httpx\.(?:Async)?Client|aiohttp\.ClientSession)\s*\(/g)) receivers.add(match[1]);
	for (const match of mask.matchAll(/\b(?:httpx\.(?:Async)?Client|aiohttp\.ClientSession)\s*\([^)]*\)\s+as\s+([A-Za-z_]\w*)/g)) receivers.add(match[1]);
	const names = ["fetch", "new\\s+Request", "axios(?:\\." + method + ")?", "got(?:\\." + method + ")?", "undici\\.request", "(?:http|https)\\.(?:request|get)", "requests\\." + method, "httpx\\." + method, "urllib\\.request\\.(?:urlopen|Request)"];
	for (const name of receivers) names.push(name + "\\." + method);
	for (const match of mask.matchAll(/\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*fetch\b/g)) names.push(match[1]);
	for (const match of mask.matchAll(/\bfrom\s+requests\s+import\s+(get|post|put|patch|delete|head|options|request)\b/g)) names.push(match[1]);
	for (const match of mask.matchAll(/\bfrom\s+urllib\.request\s+import\s+(urlopen|Request)\b/g)) names.push(match[1]);
	for (const match of mask.matchAll(/\bimport\s+(?:requests|httpx)\s+as\s+([A-Za-z_]\w*)/g)) names.push(match[1] + "\\." + method);
	const requestPattern = new RegExp("(?:^|[^\\w$.])(?:" + names.join("|") + ")\\s*\\(", "g");
	const requests = calls(requestPattern);
	// 기존 시험에 고정된 모듈 객체 호출과 Python 동적 속성 호출도 소속을 확인한다.
	let knownCalls = mask;
	for (const m of lexical.clean.matchAll(/(?:require\s*\(\s*["']https?["']\s*\)\s*(?:\.\s*(?:request|get)|\[\s*["']request["']\s*\])|getattr\s*\(\s*requests\s*,\s*["'](?:get|post|put|patch|delete|head|options|request)["']\s*\))\s*\(/g)) {
		if (mask[m.index] !== " ") knownCalls = knownCalls.slice(0, m.index) + m[0] + knownCalls.slice(m.index + m[0].length);
	}
	requests.push(...calls(/(?:require\s*\(\s*["']https?["']\s*\)\s*(?:\.\s*(?:request|get)|\[\s*["']request["']\s*\])|getattr\s*\(\s*requests\s*,\s*["'](?:get|post|put|patch|delete|head|options|request)["']\s*\)|LWP::UserAgent\s*->\s*new\s*->\s*(?:get|post|put|delete))\s*\(/g, knownCalls));
	const directClients = calls(/(?:^|[^\w$.])(?:httpx\.(?:Async)?Client|aiohttp\.ClientSession)\s*\(/g);
	for (const client of directClients) {
		const suffix = mask.slice(client.end).match(new RegExp("^\\s*\\." + method + "\\s*\\("));
		if (suffix) requests.push(...calls(new RegExp("^" + suffix[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\($/, "\\("), "g"), mask.slice(client.end)).map(c => ({ ...c, args: lexical.clean.slice(client.end + c.open + 1, client.end + c.end - 1) })));
	}
	const reads = calls(/(?:^|[^\w$])(?:[\w$.]+\.)?(?:readFile(?:Sync)?|createReadStream|load_dotenv|dotenv_values|read_text|read_bytes|open)\s*\(/g);
	const executes = calls(/(?:^|[^\w$])(?:[\w$.]+\.)?(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?|system|popen|run)\s*\(/g);
	let members = mask;
	for (const m of lexical.clean.matchAll(/\[\s*["'](?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?)["']\s*\]\s*\(/g)) {
		if (mask[m.index] === "[") members = members.slice(0, m.index) + m[0] + members.slice(m.index + m[0].length);
	}
	executes.push(...calls(/\[\s*["'](?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?)["']\s*\]\s*\(/g, members));
	const visible = lexical.clean.split("");
	for (let i = 0; i < mask.length; i++) if (mask[i] === " " && lexical.clean[i] !== " " && lexical.clean[i] !== "\n") visible[i] = " ";
	const visibleCode = visible.join("");
	const env = [...visibleCode.matchAll(/\b(?:process\.env\.(?:CLOUDFLARE_|CF_API_)[A-Z0-9_]*|(?:process\.env|os\.environ)\s*\[\s*|os\.getenv\s*\()/gi)].map(m => {
		const suffix = lexical.clean.slice(m.index);
		return suffix.match(/^(?:process\.env\.(?:CLOUDFLARE_|CF_API_)[A-Z0-9_]*|(?:process\.env|os\.environ)\s*\[\s*["'](?:CLOUDFLARE_|CF_API_)[A-Z0-9_]*["']\s*\]|os\.getenv\s*\(\s*["'](?:CLOUDFLARE_|CF_API_)[A-Z0-9_]*["'])/i)?.[0] || "";
	}).join(" ");
	return { requests: requests.map(c => c.args), reads: reads.map(c => c.args), executes: executes.map(c => c.args), shellExecutes: executes.map(c => ({ name: lexical.clean.slice(c.start, c.open), args: c.args })), env };
}

function gateEvidence(command, cwd) {
	let clean = gateWithoutComments(command);
	const entries = require("./effective-argv.js").effectiveCommands(clean, cwd);
	const folded = [];
	for (const { argv = [] } of entries) {
		const code = gateInlineCode(argv);
		if (code !== null) {
			const language = path.basename(argv[0] || "");
			const quoted = shellQuote(code);
			if (clean.includes(quoted)) clean = clean.replace(quoted, "''");
			else if (clean.includes(code)) clean = clean.replace(code, "");
			if (/^(?:bash|sh|dash|zsh|ksh)$/.test(language)) folded.push(...gateEvidence(gateFilteredCommand(code), cwd));
			else {
				const inline = gateInlineEvidence(code, language);
				folded.push([inline.env, ...inline.requests, ...inline.reads, ...inline.executes].join(" "));
			}
		}
	}
	const views = [clean, ...folded].map(s => gateNormalize(gateNormalize(s)));
	// 재대입으로 전체 변수 값이 모호하더라도, 앞선 += 시점의 글자 값은 별도 흔적이다.
	for (const view of [...views]) {
		const values = new Map();
		for (const m of view.matchAll(/(?:^|[\s;|&()])(?:export\s+|declare\s+|local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)(\+?=)([^\s;|&()]*)/g)) {
			const value = m[2] === "+=" ? (values.get(m[1]) || "") + m[3] : m[3];
			values.set(m[1], value);
			views.push(value);
		}
	}
	return views.map(s => s.replace(/(?:[a-z0-9_.*?${}~-]+\/)+(?:[a-z0-9_.*?${}~+-]+\/?)?/gi, m => path.posix.normalize(m)));
}

// 단순 함수와 별칭의 위치 인자를 호출마다 펼친다. 재귀 한도를 넘으면 미해결로 둔다.
function gateExpandCalls(command, cwd) {
	const { effectiveCommands } = require("./effective-argv.js");
	const definitions = new Map();
	let rest = command.replace(/\b(?:function\s+([a-z_][a-z0-9_]*)\s*(?:\(\s*\))?|([a-z_][a-z0-9_]*)\s*\(\s*\))\s*\{([^{}]*)\}/gi, (_, named, short, body) => { definitions.set(named || short, body); return " "; });
	rest = rest.replace(/\balias\s+([a-z_][a-z0-9_]*)=([^\s;|&]+)/gi, (_, name, body) => { definitions.set(name, `${body} $@`); return " "; });
	const result = [];
	function visit(text, depth) {
		for (const entry of effectiveCommands(text, cwd)) {
			const argv = entry.argv || [];
			if (!definitions.has(argv[0])) { result.push(entry); continue; }
			if (depth >= 8) { result.push({ argv: ["curl", "$UNRESOLVED"], opaque: true }); continue; }
			const args = argv.slice(1);
			let body = definitions.get(argv[0]);
			body = body.replace(/"\$(?:\{@\}|@|\{\*\}|\*)"|\$(?:\{@\}|@|\{\*\}|\*)/g, args.map(shellQuote).join(" "));
			body = body.replace(/\$(?:\{([1-9])\}|([1-9]))/g, (_, a, b) => shellQuote(args[Number(a || b) - 1] || "$UNRESOLVED"));
			visit(body, depth + 1);
		}
	}
	visit(rest, 0);
	return result;
}

function gateOutputClause(clause) {
	const entries = require("./effective-argv.js").expandClause(clause);
	return entries.some(({ argv = [] }) => /^(?:echo|printf)$/.test(path.basename(argv[0] || "")));
}

// Preserve shell syntax unless output clauses actually have to be removed.
// Decode ANSI-C literals before tokenization, while keeping their shell quoting.
function gateFilteredCommand(command) {
	const text = gateWithoutComments(command);
	let converted = "", quote = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\\" && quote !== "'" && i + 1 < text.length) { converted += c + text[++i]; continue; }
		if (!quote && c === "$" && text[i + 1] === "'") {
			let value = ""; i += 2;
			while (i < text.length && text[i] !== "'") {
				if (text[i] === "\\" && i + 1 < text.length) value += text[i++] + text[i++];
				else value += text[i++];
			}
			converted += shellQuote(gateUnescapeAnsi(value)); continue;
		}
		if (quote && c === quote) quote = "";
		else if (!quote && (c === "'" || c === '"')) quote = c;
		converted += c;
	}
	const clauses = require("./git-command-parser.js").shellClauses(converted);
	if (!clauses.some(gateOutputClause)) return converted;
	return clauses.filter(clause => !gateOutputClause(clause)).map(clause => clause.map(shellQuote).join(" ")).join("; ");
}

function gateHasCredential(command, cwd) {
	const evidenceCommand = gateFilteredCommand(command);
	const evidence = gateEvidence(evidenceCommand, cwd).join("\n");
	const cfKeyVariable = [...evidence.matchAll(/(?:^|[\s;|&()])(?:export\s+|declare\s+|local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=cloudflare[^\s;|&()]*/gi)].some(([, name]) => new RegExp(String.raw`data-private/key/[^\s;|&]*\$(?:\{${name}(?=[:}/])|${name}\b)`, "i").test(evidence));
	const evidenceEntries = require("./effective-argv.js").effectiveCommands(evidenceCommand, cwd);
	const keyPath = /data-private\/(?:\.\/)*key\/cloudflare[^\s;|&"'<>),]*/i;
	const acquisition = evidenceEntries.some(({argv = []}) => {
		const tool = path.basename(argv[0] || "");
		if (/^(?:\.|source|cat|head|tail|awk|sed|read)$/.test(tool)) return argv.slice(1).some(a => keyPath.test(path.posix.normalize(a))) || (cfKeyVariable && /data-private\/.*key\//i.test(argv.join(" ")));
		if (tool === "node" && argv.slice(1).some((a, i, args) => a === "--env-file" ? keyPath.test(args[i + 1] || "") : /^--env-file=/.test(a) && keyPath.test(a))) return true;
		const code = gateInlineCode(argv);
		if (code === null) return false;
		const inline = gateInlineEvidence(code, tool);
		return [...inline.reads, ...inline.executes].some(args => keyPath.test(path.posix.normalize(args)));
	});
	const values = new Map();
	const sequentialAcquisition = require("./git-command-parser.js").shellClauses(evidenceCommand).some(clause => {
		for (const word of clause) {
			const assignment = word.match(/^([A-Za-z_][A-Za-z0-9_]*)(\+?=)([^$`]*)$/);
			if (!assignment) break;
			const [, name, operator, value] = assignment;
			values.set(name, operator === "+=" ? (values.get(name) || "") + value : value);
		}
		if (!/^(?:\.|source|cat|head|tail|awk|sed)$/.test(path.basename(clause[0] || ""))) return false;
		return clause.slice(1).some(word => {
			const resolved = word.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (all, a, b) => values.get(a || b) ?? all);
			return keyPath.test(path.posix.normalize(resolved));
		});
	});
	const inlineVariable = evidenceEntries.some(({argv = []}) => {
		const code = gateInlineCode(argv);
		return code !== null && !!gateInlineEvidence(code, path.basename(argv[0] || "")).env;
	});
	const credential = acquisition || sequentialAcquisition || inlineVariable || /(?:\$\{?(?:CLOUDFLARE_|CF_API_)[A-Z0-9_]*|(?:process\.env\.|os\.environ\[?['"]?|getenv\(\s*['"])(?:CLOUDFLARE_|CF_API_)[A-Z0-9_]*|\b(?:CLOUDFLARE_|CF_API_)[A-Z0-9_]*=)/i.test(evidence);
	return credential;
}

// 글자 그대로인 단일 대상만 네트워크 쓰기의 대상으로 인정한다.
const GATE_REQUEST_VALUE_OPTIONS = {
	curl: "-H --header -e --referer -A --user-agent -b --cookie -c --cookie-jar -d --data --data-raw --data-binary --data-urlencode --json -F --form --form-string -T --upload-file -X --request -o --output -u --user -K --config -w --write-out -x --proxy -U --proxy-user --connect-timeout --max-time --resolve --connect-to --cacert --cert --key --request-target --retry --retry-delay --limit-rate -r --range -C --continue-at -D --dump-header",
	wget: "-O --output-document -o --output-file -a --append-output -e --execute -i --input-file -P --directory-prefix -U --user-agent --header --referer --post-data --post-file --body-data --body-file --method --timeout --connect-timeout --read-timeout --tries --wait --user --password --http-user --http-password --proxy-user --proxy-password --ca-certificate --certificate --private-key --limit-rate",
	http: "-o --output -p --print -P --history-print -a --auth --auth-type --header --proxy --timeout --session --session-read-only --raw --verify --cert --cert-key --ssl --default-scheme --max-redirects",
	aria2c: "-o --out -d --dir -i --input-file --header --user-agent --referer --http-user --http-passwd --all-proxy --all-proxy-user --all-proxy-passwd --timeout --connect-timeout --max-tries --retry-wait --split --max-connection-per-server --file-allocation --conditional-get --checksum"
};
const GATE_REQUEST_FLAGS = new Set("-s --silent -S --show-error -L --location -I --head -v --verbose -q --quiet -N --no-buffer -k --insecure -f --fail --compressed --fail-with-body --get -G -O --remote-name -4 -6 --ipv4 --ipv6 --no-check-certificate --no-config --no-clobber -c --continue -b --background --debug --check-status --ignore-stdin --pretty --stream --download --follow --offline --headers --body --form --json --multipart --no-conf --no-netrc --no-verify --dry-run".split(/\s+/));
function gateRequestTargets(tool, args) {
	const family = tool.startsWith("wget") ? "wget" : /^(?:http|https|xh|httpie)$/.test(tool) ? "http" : tool;
	const options = new Set(GATE_REQUEST_VALUE_OPTIONS[family].split(/\s+/));
	const targets = [], optionValues = [];
	let endOptions = false, httpTargetSeen = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!endOptions && arg === "--") { endOptions = true; continue; }
		if (!endOptions && arg === "--url") { if (i + 1 < args.length) targets.push(args[++i]); continue; }
		if (!endOptions && arg.startsWith("--url=")) { targets.push(arg.slice(6)); continue; }
		if (!endOptions && arg.startsWith("-")) {
			const equal = arg.indexOf("=");
			const name = equal < 0 ? arg : arg.slice(0, equal);
			const short = /^-[^-]/.test(arg) ? arg.slice(0, 2) : "";
			// Short flag bundles can end with an option and its attached value.
			if (short && arg.length > 2 && !options.has(short)) {
				let known = true, consumed = false;
				for (let j = 1; j < arg.length; j++) {
					const part = `-${arg[j]}`;
					if (options.has(part)) {
						if (j + 1 < arg.length) optionValues.push(arg.slice(j + 1));
						else if (i + 1 < args.length) optionValues.push(args[++i]);
						consumed = true; break;
					}
					if (!GATE_REQUEST_FLAGS.has(part)) { known = false; break; }
				}
				if (known || consumed) continue;
			}
			if (options.has(name)) {
				if (equal >= 0) optionValues.push(arg.slice(equal + 1));
				else if (i + 1 < args.length) optionValues.push(args[++i]);
			} else if (short && options.has(short) && arg.length > 2) optionValues.push(arg.slice(2));
			else if (equal >= 0) optionValues.push(arg.slice(equal + 1));
			else if (!GATE_REQUEST_FLAGS.has(arg) && /^\$(?:[A-Za-z_]\w*|\{[^}]+\}|\([^)]*\))/.test(args[i + 1] || "")) optionValues.push(args[++i]);
			continue;
		}
		if (family === "http") {
			if (!httpTargetSeen && /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)$/i.test(arg)) continue;
			if (!httpTargetSeen && /^[A-Z]+$/.test(arg) && /^(?:https?:\/\/|\$)/i.test(args[i + 1] || "")) continue;
			if (httpTargetSeen) continue;
			httpTargetSeen = true;
		}
		targets.push(arg);
	}
	return { targets, optionValues };
}
function gateTargetEvidence(command) {
	const parser = require("./effective-argv.js");
	return require("./git-command-parser.js").shellClauses(command).map(clause => {
		const entry = parser.expandClause(clause)[0];
		const argv = entry?.argv || [];
		if (!/^(?:curl|wget2?|http|https|xh|httpie|aria2c)$/.test(path.basename(argv[0] || ""))) return clause.map(shellQuote).join(" ");
		const kept = [argv[0], ...gateRequestTargets(path.basename(argv[0]), argv.slice(1)).targets];
		return clauseText(kept, entry.assigns || []);
	}).join("; ");
}

// nc positional arguments begin with the remote host; option values and listen
// mode never identify a remote destination.
function gateNetworkTargets(tool, args, assigns = []) {
	if (tool === "gh") {
		const hosts = assigns.filter(a => /^GH_HOST=/i.test(a)).map(a => a.slice(a.indexOf("=") + 1));
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--hostname" && i + 1 < args.length) hosts.push(args[++i]);
			else if (args[i].startsWith("--hostname=")) hosts.push(args[i].slice(11));
		}
		return hosts;
	}
	if (tool === "socat") {
		const addresses = [], valueOptions = new Set(["-lf", "-lp", "-r", "-R", "-b", "-S", "-t", "-T", "-L", "-W"]);
		for (let i = 0; i < args.length && addresses.length < 2; i++) {
			const arg = args[i];
			if (valueOptions.has(arg)) { i++; continue; }
			if (arg.startsWith("-") && arg !== "-") continue;
			addresses.push(arg);
		}
		return addresses.map(a => a.match(/^(?:TCP|TCP4|TCP6|OPENSSL):([^:,]+)(?::|,|$)/i)?.[1]).filter(Boolean);
	}
	if (!/^(?:nc|ncat|netcat|telnet)$/.test(tool)) return [];
	const valueOptions = new Set(["-p", "-s", "-w", "-i", "-q", "-o", "-e", "-c", "-x", "-X", "--source-port", "--source", "--wait", "--proxy", "--proxy-type", "--proxy-auth", "--proxy-dns", "--sh-exec", "--exec", "--lua-exec", "--ssl-cert", "--ssl-key", "--ssl-trustfile", "--ssl-servername", "--ssl-ciphers", "--ssl-alpn", "--idle-timeout", "--connection-limit", "--max-conns", "--hex-dump", "--output", "--allow", "--deny", "--allowfile", "--denyfile"]);
	if (tool !== "telnet") {
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "--") break;
			if (arg === "--listen" || arg.startsWith("--listen=")) return [];
			if (valueOptions.has(arg)) { i++; continue; }
			if (/^-[^-]/.test(arg)) for (const letter of arg.slice(1)) {
				if (letter === "l") return [];
				if (valueOptions.has(`-${letter}`)) break;
			}
		}
	}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return args[i + 1] ? [args[i + 1]] : [];
		if (valueOptions.has(arg)) { i++; continue; }
		if (arg.startsWith("-")) continue;
		return [arg];
	}
	return [];
}

function gateFirstRequestArg(args) {
	let depth = 0, quote = "", escaped = false;
	for (let i = 0; i < args.length; i++) {
		const c = args[i];
		if (quote) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === quote) quote = ""; continue; }
		if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
		if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth--;
		else if (c === "," && depth === 0) return args.slice(0, i);
	}
	return args;
}

function gateNestedRequestTargets(inline, language, cwd) {
	const targets = [];
	for (const call of inline.shellExecutes) {
		const strings = gateCodeTokens(call.args, language).tokens.filter(token => token.type === "string");
		const isFile = /(?:execFile|spawn)/i.test(call.name);
		if (isFile && !(strings.length >= 3 && /^(?:["'`])(?:[^"'`]*\/)?(?:ba|da|k|z)?sh["'`]$/.test(strings[0].value) && /^['"`]-c['"`]$/.test(strings[1].value))) continue;
		const token = strings[isFile ? 2 : 0];
		if (!token) continue;
		let text = token.value.slice(1, -1);
		if (token.value[0] === '"') { try { text = JSON.parse(token.value); } catch {} }
		else text = text.replace(/\\([\\'"`])/g, "$1");
		for (const { argv = [] } of gateExpandCalls(text, cwd)) {
			const tool = path.basename(argv[0] || "");
			if (/^(?:curl|wget2?|http|https|xh|httpie|aria2c)$/.test(tool)) targets.push(...gateRequestTargets(tool, argv.slice(1)).targets);
		}
	}
	return targets;
}

function gateNetworkRisks(command, normalized, entries, cwd, scriptContext = false) {
	const hits = [];
	const normalizedCase = normalized;
	normalized = normalized.toLowerCase();
	const credential = gateHasCredential(command, cwd);
	const cf = credential;
	if (!cf) {
		// An unknown key file and an unknown write destination are not evidence of
		// Cloudflare, but together still require a generic network-write review.
		const original = require("./effective-argv.js").effectiveCommands(command, cwd);
		const unknownKey = original.some(({ argv = [] }) => /^(?:\.|source|cat|head|tail|awk|sed)$/.test(path.basename(argv[0] || "")) && argv.slice(1).some(a => /data-private\/(?:\.\/)*key\//.test(a) && /[*?[$`]/.test(a)));
		const unknownWrite = original.some(({ argv = [] }) => {
			const tool = path.basename(argv[0] || ""), rest = argv.slice(1);
			if (!/^(?:curl|wget2?|http|https|xh|httpie)$/.test(tool) || rest.some(a => /^https?:\/\//i.test(a)) || !rest.some(a => /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})$/.test(a))) return false;
			return rest.some((a, i) => /^(?:--data[^=]*|--json|--form(?:-string)?|--upload-file|--post-data|--post-file|--body-data|--body-file)(?:=|$)/.test(a) || /^-[A-Za-z]*[dFT]/.test(a) || /^(?:POST|PUT|PATCH|DELETE|PURGE)$/i.test(a) || (/^(?:-X|--request|--method)$/.test(a) && !/^(?:GET|HEAD)$/i.test(rest[i + 1] || "")) || /^--(?:request|method)=(?!GET$|HEAD$).+/i.test(a) || /^-[A-Za-z]*X(?!GET$|HEAD$).+/i.test(a));
		});
		if (unknownKey && unknownWrite) hits.push({ service: "network:write:unresolved-host", label: "미확정 자격 파일과 대상의 네트워크 쓰기", clause: command });
		return hits;
	}
	// Output-only arguments and comments do not establish a target. Inline code
	// remains visible, including literal folding for ordinary concatenations.
	const evidenceCommand = gateFilteredCommand(command);
	const hasCfOption = require("./git-command-parser.js").shellClauses(evidenceCommand).some(clause => {
		const argv = require("./effective-argv.js").expandClause(clause)[0]?.argv || [];
		if (!/^(?:curl|wget2?|http|https|xh|httpie|aria2c)$/.test(path.basename(argv[0] || ""))) return false;
		return gateRequestTargets(path.basename(argv[0]), argv.slice(1)).optionValues.some(value => /api\.cloudflare\.com/i.test(value));
	});
	const targetCommand = hasCfOption ? gateTargetEvidence(evidenceCommand) : evidenceCommand;
	const views = gateEvidence(targetCommand, cwd);
	const evidence = [...views, ...gateEvidence(views[0], cwd)].join("\n");
	const commands = [...require("./effective-argv.js").effectiveCommands(evidenceCommand, cwd), ...gateExpandCalls(evidenceCommand, cwd), ...require("./effective-argv.js").effectiveCommands(command, cwd).filter(entry => entry.piped && /^(?:nc|ncat|netcat|socat|telnet)$/.test(path.basename(entry.argv?.[0] || "")))];
	// A shell's -c body is parsed as shell syntax, including ANSI-C words, not
	// as an opaque argument or as JavaScript/Python source.
	let shellEntries = commands;
	for (let depth = 0; depth < 8 && shellEntries.length; depth++) {
		const nested = [];
		for (const { argv = [] } of shellEntries) {
			if (!/^(?:bash|sh|dash|zsh|ksh)$/.test(path.basename(argv[0] || ""))) continue;
			const code = gateInlineCode(argv);
			if (code !== null) {
				const filtered = gateFilteredCommand(code);
				nested.push(...require("./effective-argv.js").effectiveCommands(filtered, cwd), ...gateExpandCalls(filtered, cwd));
			}
		}
		commands.push(...nested);
		shellEntries = nested;
	}
	const targetEntries = commands;
	const targetValues = [];
	for (const { argv = [], assigns = [] } of targetEntries) {
		const tool = path.basename(argv[0] || ""), args = argv.slice(1);
		if (/^(?:curl|wget2?|http|https|xh|httpie|aria2c)$/.test(tool)) targetValues.push(...gateRequestTargets(tool, args).targets);
		targetValues.push(...gateNetworkTargets(tool, args, assigns));
		const code = gateInlineCode(argv);
		if (code !== null && !/^(?:bash|sh|dash|zsh|ksh)$/.test(tool)) {
			const inline = gateInlineEvidence(code, tool);
			targetValues.push(...inline.requests.map(gateFirstRequestArg));
			targetValues.push(...gateNestedRequestTargets(inline, tool, cwd));
		}
	}
	const literalTarget = /api\.cloudflare\.com/i.test(scriptContext ? evidence : targetValues.join("\n"));
	const variableTarget = commands.some(({argv = [], assigns = [], piped = false}) => {
		const tool = path.basename(argv[0] || "");
		const args = argv.slice(1);
		if (/^(?:curl|wget2?|http|https|xh|httpie|aria2c)$/.test(tool)) {
			const variable = value => /^(?:https?:\/\/[^/]*[$`]|\$(?:[A-Za-z_]\w*|\{[^}]+\}|\([^)]*\)))/i.test(value || "");
			if (gateRequestTargets(tool, args).targets.some(variable)) return true;
			return tool.startsWith("wget") && args.some(a => /^(?:-i|--input-file)(?:=|$)/.test(a));
		}
		if (tool === "gh") return gateNetworkTargets(tool, args, assigns).some(a => /^\$/.test(a));
		if (/^(?:ncat|netcat|socat|telnet)$/.test(tool) || (tool === "nc" && piped)) {
			return gateNetworkTargets(tool, args, assigns).some(a => /^\$/.test(a));
		}
		const code = gateInlineCode(argv);
		if (code === null) return false;
		if (/^(?:bash|sh|dash|zsh|ksh)$/.test(tool)) return false;
		const inline = gateInlineEvidence(code, tool);
		if (gateNestedRequestTargets(inline, tool, cwd).some(a => /^\$/.test(a))) return true;
		return inline.requests.some(args => /^\s*(?:url\s*=\s*)?(?:\$?[A-Za-z_]\w*(?:\s*\(|\b)|\$ENV\{[^}]+\}|`https?:\/\/\$\{)/i.test(args));
	});
	if (literalTarget || variableTarget) {
		hits.push({ service: "cloudflare:api:unknown", label: "Cloudflare 자격과 API 대상", clause: command });
	}
	return hits;
}
function optionValue(tokens, names) {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		for (const n of names) {
			if (t === n && i + 1 < tokens.length) return tokens[i + 1];
			if (t.startsWith(`${n}=`)) return t.slice(n.length + 1);
			// 한 글자 옵션의 붙임값(-mpost, -nNAME)도 값이다(검수 5회차 3번).
			if (/^-[A-Za-z]$/.test(n) && t.length > 2 && t.startsWith(n) && !t.startsWith("--")) return t.slice(2);
		}
	}
	return "";
}

function isNonProd(...names) {
	// Cloudflare API 쓰기는 도메인에 dev/test 가 들어가도 운영 관문에서 제외하지 않는다.
	if (names.some((n) => typeof n === "string" && /^cloudflare:/i.test(n))) return false;
	const joined = names.filter(Boolean).join(" ");
	if (!joined) return false;
	if (/prod/i.test(joined)) return false;
	return names.some((n) => n && NON_PROD.test(n));
}


// --ids 는 여러 값을 받는다(검수 1회차 2번). --ids 뒤의 비옵션 낱말 전부, --ids=값 꼴과 그 뒤 낱말, 여러 번 지정까지 모두 모은다.
function idsValues(tokens) {
	const out = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--ids") {
			for (let j = i + 1; j < tokens.length && !tokens[j].startsWith("-"); j++) if (tokens[j]) out.push(tokens[j]);
		} else if (t.startsWith("--ids=")) {
			const v = t.slice("--ids=".length);
			if (v) out.push(v);
			for (let j = i + 1; j < tokens.length && !tokens[j].startsWith("-"); j++) if (tokens[j]) out.push(tokens[j]);
		}
	}
	return out;
}

function classifyAzAll(tokens) {
	const azIndex = tokens.findIndex((t) => /(?:^|\/)az$/.test(t));
	if (azIndex < 0) return [];
	const group = tokens[azIndex + 1];
	if (!group) return [];
	const verbs = [];
	for (let i = azIndex + 2; i < tokens.length && !tokens[i].startsWith("-"); i++) verbs.push(tokens[i]);
	const isReadVerb = (v) => READ_VERBS.has(v.toLowerCase()) || EXTRA_AZ_READ_VERBS.has(v.toLowerCase()) || v.toLowerCase().startsWith("list-") || v.toLowerCase().startsWith("show-");
	if (group.includes("$") || group.includes("`")) {
		// 그룹이 변수라도 동사가 읽기(show·list …)면 어느 그룹이든 바꾸지 않는다(검수 1회차 8번).
		if (verbs.some(isReadVerb)) return [];
		// 도움말(--help, -h)도 아무것도 바꾸지 않는다(검수 2회차 8번 후속).
		if (tokens.slice(azIndex + 2).some((t) => t === "--help" || t === "-h")) return [];
		return [{ service: "unclassified:az", label: `분류 불가: az 그룹을 정할 수 없음(${group})`, unclassified: true }];
	}
	const groupLower = group.toLowerCase();
	if (AZ_LOCAL_COMMANDS.has(groupLower) || AZ_LOCAL_GROUPS.has(groupLower)) return [];
	// acr build 는 새 태그만 올린다. 돌고 있는 서비스 교체는 containerapp·vm 갱신에서 잡힌다(세션 시작 판과 같음, 스튜디오 개발 빌드).
	if (groupLower === "acr" && ["login", "check-health", "build"].includes((verbs[0] || "").toLowerCase())) return [];
	// aks 는 기존 목록(AZ_GROUPS) 그룹이라 get-credentials 도 지금처럼 운영으로 둔다(느슨해지는 변경 금지, 검수 1회차 11번).
	// 목록 밖 그룹의 도움말(--help, -h)은 아무것도 바꾸지 않는다.
	if (!AZ_GROUPS.has(groupLower) && tokens.slice(azIndex + 2).some((t) => t === "--help" || t === "-h")) return [];
	if (groupLower === "rest") {
		const rest = tokens.slice(azIndex + 2);
		const method = optionValue(rest, ["--method", "-m"]);
		if (!method || /^(?:get|head)$/i.test(method)) return [];
		const uri = optionValue(rest, ["--uri", "--url"]);
		const target = uri || "(이름 없음)";
		return [{
			service: `azure:rest:${target}`,
			label: `az rest ${verbs.join(" ")}${uri ? ` ${uri}` : ""}`.trim(),
			variable: /\$/.test(target) ? target : "",
		}];
	}
	if ((group.startsWith("-") || (verbs.length === 0 && AZ_TOP_GROUPS.has(groupLower))) && !tokens.some(t => t === "--help" || t === "-h")) return [{ service: "unclassified:az", label: "분류 불가: az 동사·대상을 정할 수 없음", unclassified: true }];
	if (!AZ_GROUPS.has(groupLower)) {
		if (verbs.length === 0 || verbs.some((v) => READ_VERBS.has(v.toLowerCase()) || EXTRA_AZ_READ_VERBS.has(v.toLowerCase()) || v.toLowerCase().startsWith("list-") || v.toLowerCase().startsWith("show-"))) return [];
		const rest = tokens.slice(azIndex + 2);
		// acr 은 레지스트리가 대상이다(az acr build -r <레지스트리>, 검수 1회차 11번).
		const nameOpts = groupLower === "acr" ? ["--registry", "-r", "-n", "--name"] : ["--policy-name", "--profile-name", "--account-name", "--vault-name", "--server", "--registry", "--vm-name", "-n", "--name"];
		const optName = optionValue(rest, nameOpts);
		// 이름 옵션이 있으면 지금처럼 그것, 없으면 모든 ID 의 마지막 경로 조각 각각을 같은 규칙으로 판정한다.
		const names = optName ? [optName] : idsValues(rest).map(lastIdPart);
		const targets = names.length ? names : [""];
		const rg = optionValue(rest, ["-g", "--resource-group"]);
		const hits = [];
		for (const name of targets) {
			const target = name || "(이름 없음)";
			if (isNonProd(target, rg)) continue;
			hits.push({
				service: `azure:${groupLower}:${target.toLowerCase()}`,
				label: `az ${group} ${verbs.join(" ")}${name ? ` -n ${name}` : ""}`,
				variable: /\$/.test(target) ? target : "",
				// 목록 밖 그룹: 스크립트 안에서 글자 그대로 한 값으로 정한 변수 대상은 그 값으로 서비스 이름을 정한다(아래 classifyProdMutations).
				unlistedGroup: groupLower,
			});
		}
		return hits;
	}
	if (verbs.length === 0 || verbs.some((v) => READ_VERBS.has(v) || v.startsWith("list-") || v.startsWith("show-"))) return [];
	const rest = tokens.slice(azIndex + 2);
	// VM 의 run-command create·invoke 는 --vm-name 이나 --ids 가 VM 이다(설계 검수 11회차 4번: -n 은 run-command 이름이었다).
	// ID 안 resourceGroups 조각은 판정 근거에 넣지 않는다. --ids …/rg-dev/…/myvm 도 지금처럼 운영으로 둔다.
	const ids = idsValues(rest);
	const vmOpt = optionValue(rest, ["--vm-name"]);
	const names = vmOpt ? [vmOpt] : ids.length ? ids.map((id) => (id.match(/\/virtualMachines\/([^/\s]+)/i) || [])[1] || lastIdPart(id)) : [optionValue(rest, ["-n", "--name"])];
	const rg = optionValue(rest, ["-g", "--resource-group"]);
	const hits = [];
	for (const name of names) {
		if (isNonProd(name, rg)) continue;
		hits.push({
			service: `azure:${groupLower}:${(name || "(이름 없음)").toLowerCase()}`,
			label: `az ${group} ${verbs.join(" ")}${name ? ` -n ${name}` : ""}`,
			// 대상이 스크립트 안의 변수(--name "${VM}")면 운영인지는 스크립트를 부른 모양이 정한다(설계 검수 15회차 3번).
			// 설계 검수 16회차 1번: 리소스 그룹만 변수여도 이름이 글자 그대로 운영이면 운영이다. 이름 낱말만 본다.
			variable: /\$/.test(name || "") ? name : "",
		});
	}
	return hits;
}

// opaqueTool 은 참거짓으로 쓴다. 빈 배열이 참이 되지 않게 첫 원소나 null 을 낸다.
function classifyAz(tokens) {
	const all = classifyAzAll(tokens);
	return all.length ? all[0] : null;
}

function lastIdPart(value) {
	if (!value) return "";
	const clean = value.split(/[?#]/, 1)[0].replace(/\/+$/, "");
	return clean.slice(clean.lastIndexOf("/") + 1);
}

// 일반 ssh 로 운영 호스트를 바꾸는 명령(검수 1회차 1번). gcloud compute ssh 는 기존 패턴이 따로 본다.
// 운영 호스트 판정은 이 파일의 isNonProd 를 그대로 쓴다. 새 호스트 목록을 만들지 않는다.
const SSH_VALUE_OPTS = new Set(["B", "b", "c", "D", "E", "e", "F", "I", "i", "J", "L", "l", "m", "O", "o", "P", "p", "Q", "R", "S", "W", "w"]);
// 실제 접속 대상을 바꾸는 -o 값(대소문자 무시). 있으면 호스트 낱말을 믿지 않고 운영으로 본다.
const SSH_TARGET_OPT = /^(?:hostname|proxycommand|remotecommand|include)(?:=|\s|$)/i;
const SSH_READ_BLOCK_VERB = new Set(["restart", "stop", "start", "update", "reload", "kill", "rename"]);
// sed 는 -i 없이도 w·e·r 명령이나 -0i 같은 숫자 묶음 옵션으로 파일을 쓸 수 있다(검수 2회차 4번).
// readiness 의 sed 줄은 건드리지 않고, 여기서 읽기로 볼 수 있는 것만 남긴다.
const SED_READ_SHORT = new Set(["n", "E", "r"]);
const SED_READ_LONG = new Set(["--quiet", "--silent"]);
const SED_ADDR_P = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;
const SED_RE_P = /^\/[^/\\]+\/p$/;
const SED_RE_RANGE_P = /^\/[^/\\]+\/,\/[^/\\]+\/p$/;
function sedScriptReads(script) {
	return String(script).split(/[;\n]/).map((x) => x.trim()).filter(Boolean)
		.every((x) => SED_ADDR_P.test(x) || SED_RE_P.test(x) || SED_RE_RANGE_P.test(x));
}
// sed 절 하나가 읽기(주소 출력)만 하는가. -f(파일 스크립트)·-i 계열·목록 밖 옵션·스크립트 없음·출력 리다이렉션은 쓰기로 본다.
function sedClauseReads(clause) {
	// 출력 리다이렉션(>·>>)이 있으면 파일에 쓴다. /dev/null·>&숫자 복제만 받는다(readiness innerClauseProblem 과 같은 기준).
	for (let k = 1; k < clause.length; k++) {
		const m = clause[k].match(/^(\d*)(>>?)(.*)$/);
		if (!m) continue;
		const target = m[3] || clause[k + 1] || "";
		if (m[3] === "" && k === clause.length - 1) continue;
		if (target !== "/dev/null" && !/^&\d$/.test(target)) return false;
	}
	const scripts = [];
	const positionals = [];
	let positionalScript = true;
	for (let k = 1; k < clause.length; k++) {
		const a = clause[k];
		if (a === "-e") {
			if (k + 1 >= clause.length) return false;
			scripts.push(clause[++k]);
			positionalScript = false;
			continue;
		}
		if (a.startsWith("-e") && !a.startsWith("--") && a.length > 2) {
			scripts.push(a.slice(2));
			positionalScript = false;
			continue;
		}
		if (a === "--") { for (k++; k < clause.length; k++) positionals.push(clause[k]); break; }
		if (a.startsWith("--")) { if (!SED_READ_LONG.has(a)) return false; continue; }
		if (a.startsWith("-") && a.length > 1) {
			const b = a.slice(1);
			if (/^[nEr]+$/.test(b)) continue;
			if (/^[nEr]*e$/.test(b)) {
				if (k + 1 >= clause.length) return false;
				scripts.push(clause[++k]);
				positionalScript = false;
				continue;
			}
			return false;
		}
		positionals.push(a);
	}
	if (positionalScript && positionals.length) scripts.push(positionals[0]);
	if (!scripts.length) return false;
	return scripts.every(sedScriptReads);
}
// 원격 본문이 전부 읽기 전용 sed 절이면 true. 치환($·`)이 있거나 파서가 닫히지 않거나 빈 절이 있으면 false(쓰기로 본다).
function sshBodyAllSedReads(body) {
	if (/[$`]/.test(body)) return false;
	const { shellClauses } = require("./git-command-parser.js");
	const clauses = shellClauses(body);
	if (!Array.isArray(clauses) || clauses.unbalanced || !clauses.length) return false;
	for (const clause of clauses) {
		if (!clause.length) return false;
		if (path.basename(clause[0] || "") !== "sed") return false;
		if (!sedClauseReads(clause)) return false;
	}
	return true;
}
// 원격 본문 절 가운데 sed 쓰기가 하나라도 있으면 true. 파서가 닫히지 않으면 쓰기로 본다.
function sshBodySedWrites(body) {
	const { shellClauses } = require("./git-command-parser.js");
	const clauses = shellClauses(body);
	if (!Array.isArray(clauses) || clauses.unbalanced) return true;
	for (const clause of clauses) {
		if (path.basename(clause[0] || "") !== "sed") continue;
		if (!sedClauseReads(clause)) return true;
	}
	return false;
}
// scp 의 원격 쪽(호스트:경로)이 운영 호스트면 ssh 와 같은 서비스로 본다(PC 원격 관문 검수 1회차: scp 가 관문 밖으로 나감).
function classifyScp(tokens) {
	if (path.basename(tokens[0] || "") !== "scp") return [];
	const hits = [];
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (/^-[cDFiJlSoPX]$/.test(t)) { i++; continue; }
		if (t.startsWith("-")) continue;
		// 윈도우 로컬 경로(C:\…, C:/…)는 호스트가 아니다(2회차 권고 B). scp:// 주소는 host[:port]/경로 모양도 본다(2회차 고침 A).
		if (/^[A-Za-z]:[\\/]/.test(t)) continue;
		const m = /^scp:\/\//i.test(t) ? t.slice(6).match(/^(?:[^@/]+@)?(\[[^\]]+\]|[^/:]+)(?::\d+)?(?:\/|$)/) : t.match(/^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):/);
		if (!m) continue;
		const host = m[1].replace(/^\[|\]$/g, "");
		if (isNonProd(host)) continue;
		const service = `ssh:${host.toLowerCase()}`;
		if (!hits.some((h) => h.service === service)) hits.push({ service, label: `scp ${host} (운영 호스트 파일 복사)` });
	}
	return hits;
}
function classifySsh(tokens, cwd, depth = 0, rootDir = "") {
	if (path.basename(tokens[0] || "") !== "ssh") return [];
	let queryOnly = false;
	const optVals = [];
	let i = 1;
	for (; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--") { i++; break; }
		if (!t.startsWith("-") || t === "-") break;
		if (t.startsWith("--")) continue;
		for (let j = 1; j < t.length; j++) {
			const c = t[j];
			if (c === "G" || c === "V" || c === "Q") queryOnly = true;
			if (SSH_VALUE_OPTS.has(c)) {
				const attached = t.slice(j + 1);
				optVals.push({ opt: c, value: attached || tokens[i + 1] });
				if (!attached) i++;
				break;
			}
		}
	}
	// -G(설정 출력)·-V(버전)·-Q(알고리즘 조회)는 아무것도 실행하지 않는다.
	if (queryOnly) return [];
	let host = tokens[i];
	if (!host) return [];
	host = host.replace(/^ssh:\/\//i, "");
	const at = host.lastIndexOf("@");
	if (at >= 0) host = host.slice(at + 1);
	host = host.replace(/:[0-9]+$/, "");
	if (!host) return [];
	const override = optVals.some(({ opt, value }) => opt === "F" || (opt === "o" && SSH_TARGET_OPT.test(String(value || "").trim())));
	const body = tokens.slice(i + 1).join(" ");
	// 중첩 한도를 넘으면 재분류하지 않고 막는다. ssh:<호스트>는 비운영으로 풀릴 수 있어 고정 서비스를 쓴다.
	if (body.trim() && (depth || 0) + 1 > 3) return [{ service: "ssh:depth-limit", label: `ssh ${host} (ssh 중첩 한도 초과)` }];
	// 인스턴스 설정(config/deploy-gate.json)의 sshAlwaysGated 호스트는 읽기도 관문을 탄다.
	const { loadDeployGateConfig } = require("./deploy-readiness.js");
	const gateRoot = rootDir || process.env.DEPLOY_READINESS_ROOT || resolveGateRoot(cwd);
	const gateCfg = loadDeployGateConfig(gateRoot);
	const alwaysGatedList = Array.isArray(gateCfg?.sshAlwaysGated) ? gateCfg.sshAlwaysGated : [];
	for (const rule of alwaysGatedList) {
		const hosts = Array.isArray(rule?.hosts) ? rule.hosts.map((h) => String(h).toLowerCase()) : [];
		if (!hosts.length) continue;
		const viaOpt = optVals.some(({ value }) => hosts.some((h) => String(value || "").toLowerCase().includes(h)));
		if (viaOpt || hosts.includes(host.toLowerCase().replace(/\.$/, ""))) {
			return [{ service: rule.service || `ssh:${host.toLowerCase()}`, label: rule.label || `ssh ${host} (항상 관문 대상)` }];
		}
	}
	if (!override && isNonProd(host)) {
		if (!body.trim()) return [];
		return classifyProdMutations(body, cwd, (depth || 0) + 1, false, gateRoot).map((h) => ({ ...h, label: `${h.label} (ssh ${host} 안)` }));
	}
	const hit = { service: `ssh:${host.toLowerCase()}`, label: `ssh ${host} (운영 호스트 원격 변경)` };
	// -o HostName 등으로 실제 대상을 덮어썼으면 호스트 낱말을 믿지 않으므로 variable 을 달지 않는다(검수 2회차 3번).
	if (host.includes("$") && !override) hit.variable = host;
	if (!body.trim()) return [hit];
	// 운영 호스트의 읽기 판정 경로에서도 본문 속 운영 변경은 hit 로 본다.
	if (classifyProdMutations(body, cwd, (depth || 0) + 1, false, gateRoot).length) return [hit];
	// 본문이 전부 읽기 전용 sed 절이면 통과한다. 따옴표+절대경로 모양('…' /경로)은 불투명으로 보아 막히므로 그보다 먼저 본다.
	if (sshBodyAllSedReads(body)) return [];
	// 읽기면 통과: 불투명하지 않고, 안쪽 판정이 읽기이며, 변경 동사 낱말이 없고, sed 쓰기가 없을 때.
	// deploy-readiness 가 최상위에서 이 분류기를 부르므로 늦게 require 한다(순환 방지).
	const { INNER_OPAQUE, innerProblem } = require("./deploy-readiness.js");
	if (INNER_OPAQUE.test(body)) return [hit];
	if (innerProblem(clauseText(["ssh", host, body])) !== null) return [hit];
	if (body.split(/\s+/).some((w) => SSH_READ_BLOCK_VERB.has(w.toLowerCase()))) return [hit];
	if (sshBodySedWrites(body)) return [hit];
	return [];
}

const AZ_TARGET_OPTION = /^(?:-g|--resource-group|--ids|--subscription|-n|--name|-r|--registry|--vault-name|--policy-name|--profile-name|--account-name|--server|--vm-name|--method|-m|--uri|--url)(?:=|$)/;
function opaqueTool(entry) {
	const clause = Array.isArray(entry.clause) ? entry.clause.map(String) : [];
	for (const word of clause) {
		const tool = path.basename(word.replace(/^['"]|['"]$/g, "")).toLowerCase();
		if (["az", "gcloud", "kubectl", "vercel"].includes(tool)) return tool;
	}
	const programMatch = String(entry.opaque || "").match(/프로그램\(([^)]+)\)/);
	const program = (programMatch && programMatch[1]) || (String(entry.argv && entry.argv[0] || "").startsWith("$") ? entry.argv[0] : "");
	if (!program.startsWith("$")) return null;
	const at = clause.indexOf(program);
	if (at < 0) return null;
	// 변수 프로그램 뒤 낱말이 az 최상위 그룹 이름과 글자 그대로 같을 때만 az 로 본다.
	// 그렇지 않으면 셸 산술·조건 절((( $# != 2 )), [[ ! "$X" =~ … ]])이나 스크립트 글 속 ${…} 를 az 로 잘못 읽는다.
	// az 전역 옵션("$AZ" -o json containerapp …)은 건너뛰고, 대소문자는 가리지 않는다(검수 1회차 4·5번).
	const unq = (w) => String(w || "").replace(/^['"]|['"]$/g, "");
	let k = at + 1;
	while (k < clause.length) {
		const w = unq(clause[k]);
		// --output=json 같은 "옵션=값" 꼴은 낱말 하나다(검수 2회차 4번).
		if (/^(?:-o|--output|--query|--subscription)=/.test(w) || /^-o[^=\s]/.test(w)) k += 1;
		else if (/^(?:-o|--output|--query|--subscription)$/.test(w)) k += 2;
		else if (/^(?:--only-show-errors|--debug|--verbose|-y|--yes|--no-wait)$/.test(w)) k += 1;
		else break;
	}
	const next = unq(clause[k]);
	const rest = clause.slice(k + 1).map(unq);
	// 그룹 자리도 변수면("$AZ" "$GROUP" update -n …) az 대상 옵션(-g, --resource-group, --ids, --subscription, -n, --name)이 함께 보일 때만 az 로 본다(검수 2회차 3번).
	// "$binary" "$@" 같은 평범한 실행 파일 감싸기는 막지 않는다(검수 1회차 3번과 오탐 사이의 경계).
	// 대상 옵션 목록은 classifyAz 가 대상을 찾는 옵션 전체다(검수 3회차 1번: -r 등). 읽기 동사·도움말 면제는 classifyAz 가 같은 규칙으로 정한다(3회차 3번).
	if (/[$`]/.test(next)) {
		if (!rest.some((w) => AZ_TARGET_OPTION.test(w) || /^-[gnrm][^\s-]/.test(w))) return null;
		return classifyAz(["az", ...clause.slice(k)]) ? "az" : null;
	}
	if (!AZ_TOP_GROUPS.has(next.toLowerCase())) {
		// 목록 밖 그룹이라도 az 고유 대상 옵션(-g, --resource-group, --ids, --subscription)이 보이면 az 로 본다(검수 5회차 2번: "$AZ" aro create -g rg -n x).
		// 대상 옵션은 변수 그룹 자리와 같은 전체 집합이다(검수 6회차 3번). "$GIT" commit -m 은 동사가 없어 classifyAz 가 null 이다.
		if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(next)) return null;
		if (!rest.some((w) => AZ_TARGET_OPTION.test(w) || /^-[gnrm][^\s-]/.test(w))) return null;
		return classifyAz(["az", next.toLowerCase(), ...clause.slice(k + 1)]) ? "az" : null;
	}
	return classifyAz(["az", next.toLowerCase(), ...clause.slice(k + 1)]) ? "az" : null;
}

function unclassifiedOpaque(entry, tool) {
	return {
		service: `unclassified:${tool}`,
		label: `분류 불가: ${entry.opaque || `실행 프로그램이 변수라 운영 도구 ${tool}을 확정할 수 없음`}`,
		clause: clauseText(entry.clause || []),
		unclassified: true,
		tool,
	};
}

const CLI_GLOBAL_OPTIONS = {
	gcloud: {
		bool: new Set([
			"-q",
			"--quiet",
			"--no-user-output-enabled",
			"--user-output-enabled",
			"--log-http",
			"--trace-log",
		]),
		value: new Set([
			"--project",
			"--account",
			"--impersonate-service-account",
			"--billing-project",
			"--configuration",
			"--credential-file-override",
			"--filter",
			"--format",
			"--limit",
			"--page-size",
			"--sort-by",
			"--uri",
			"--verbosity",
			"--flags-file",
			"--trace-token",
			"--region",
			"--zone",
			"--platform",
		]),
	},
	kubectl: {
		bool: new Set([
			"--match-server-version",
			"--insecure-skip-tls-verify",
			"--disable-compression",
			"--warnings-as-errors",
		]),
		value: new Set([
			"-n",
			"--namespace",
			"--context",
			"--kubeconfig",
			"--cluster",
			"--user",
			"-s",
			"--server",
			"--token",
			"--as",
			"--as-group",
			"--as-uid",
			"--cache-dir",
			"--certificate-authority",
			"--client-certificate",
			"--client-key",
			"--request-timeout",
			"--tls-server-name",
			"-v",
			"--v",
			"--vmodule",
			"--log-flush-frequency",
			"--profile",
			"--profile-output",
			"--password",
			"--username",
		]),
	},
	helm: {
		bool: new Set(["--debug", "--kube-insecure-skip-tls-verify"]),
		value: new Set([
			"-n",
			"--namespace",
			"--kube-context",
			"--kubeconfig",
			"--kube-apiserver",
			"--kube-as-group",
			"--kube-as-user",
			"--kube-ca-file",
			"--kube-tls-server-name",
			"--kube-token",
			"--registry-config",
			"--repository-cache",
			"--repository-config",
			"--burst-limit",
			"--qps",
		]),
	},
	terraform: {
		bool: new Set([]),
		value: new Set(["-chdir", "--chdir"]),
	},
	fly: {
		bool: new Set([
			"-j",
			"--json",
			"--verbose",
			"--debug",
			"-y",
			"--yes",
			"--local-only",
			"--remote-only",
			"--now",
			"--ha",
		]),
		value: new Set([
			"-a",
			"--app",
			"-c",
			"--config",
			"-t",
			"--access-token",
			"-o",
			"--org",
			"-r",
			"--region",
		]),
	},
	wrangler: {
		bool: new Set([
			"--experimental-json-config",
			"--latest",
			"--keep-vars",
			"--minify",
			"--dry-run",
			"--legacy-env",
		]),
		value: new Set([
			"-e",
			"--env",
			"-c",
			"--config",
			"--cwd",
			"--name",
			"--compatibility-date",
			"--compatibility-flags",
		]),
	},
	railway: {
		bool: new Set(["--json", "-y", "--yes", "--ci", "-d", "--detach"]),
		value: new Set(["-e", "--environment", "-p", "--project", "-s", "--service"]),
	},
	supabase: {
		bool: new Set(["--debug", "--experimental", "-y", "--yes", "--local", "--linked"]),
		value: new Set([
			"--project-ref",
			"--workdir",
			"--profile",
			"--output",
			"--env-file",
			"--db-url",
			"-p",
			"--password",
		]),
	},
};

function scanCliSubcommandTokens(tokens, startIdx, maxPositionals, optSpec) {
	const positionals = [];
	const boolSet = (optSpec && optSpec.bool) || new Set();
	const valueSet = (optSpec && optSpec.value) || new Set();
	let i = startIdx;
	while (i < tokens.length && positionals.length < maxPositionals) {
		const tok = tokens[i];
		if (tok === "--") {
			i += 1;
			while (i < tokens.length && positionals.length < maxPositionals) {
				positionals.push({ token: tokens[i], index: i });
				i += 1;
			}
			break;
		}
		if ( positionals.length === 0 && /^(?:-h|--help|-help|-v|--version|-version|help|version)$/i.test(tok) ) {
			return { help: true, positionals: [], nextIndex: i + 1 };
		}
		if (tok.startsWith("-") && tok.length > 1) {
			const eqIdx = tok.indexOf("=");
			if (eqIdx > 0) {
				const optName = tok.slice(0, eqIdx);
				if (boolSet.has(optName) || valueSet.has(optName)) {
					i += 1;
					continue;
				}
				return { unknownOption: tok, positionals, nextIndex: i };
			}
			if (boolSet.has(tok)) {
				i += 1;
				continue;
			}
			if (valueSet.has(tok)) {
				if (i + 1 >= tokens.length) {
					return { unknownOption: tok, positionals, nextIndex: i };
				}
				i += 2;
				continue;
			}
			return { unknownOption: tok, positionals, nextIndex: i };
		}
		positionals.push({ token: tok, index: i });
		i += 1;
	}
	return { positionals, nextIndex: i };
}

function extractGcloudTarget(tokens, startIdx) {
	const scan = scanCliSubcommandTokens(tokens, startIdx, 1, CLI_GLOBAL_OPTIONS.gcloud);
	if (scan.unknownOption || scan.positionals.length === 0) return "default";
	return (scan.positionals[0].token || "default").toLowerCase();
}

/** 일반 클라우드·배포 CLI 운영 명령 분류(gcloud, vercel, kubectl, helm, terraform, fly, wrangler, railway, supabase). */
function classifyGeneralCloudCli(tokens) {
	const bin = path.basename(tokens[0] || "").toLowerCase();
	if (bin === "vercel") {
		if (tokens.slice(1).some((t) => /^--prod(?:uction)?$/i.test(t))) {
			return [{ service: "vercel:prod", label: "Vercel prod deploy" }];
		}
		return [];
	}
	if (bin === "gcloud") {
		const spec = CLI_GLOBAL_OPTIONS.gcloud;
		let scan = scanCliSubcommandTokens(tokens, 1, 1, spec);
		if (scan.help) return [];
		if (scan.unknownOption) {
			return [{ service: "gcloud:unknown-option", label: `gcloud (알 수 없는 전역 옵션 ${scan.unknownOption})` }];
		}
		if (scan.positionals.length === 0) return [];
		let groupTok = scan.positionals[0].token.toLowerCase();
		let nextIdx = scan.nextIndex;
		if (groupTok === "alpha" || groupTok === "beta" || groupTok === "preview") {
			scan = scanCliSubcommandTokens(tokens, nextIdx, 1, spec);
			if (scan.help) return [];
			if (scan.unknownOption) {
				return [{ service: "gcloud:unknown-option", label: `gcloud (알 수 없는 전역 옵션 ${scan.unknownOption})` }];
			}
			if (scan.positionals.length === 0) return [];
			groupTok = scan.positionals[0].token.toLowerCase();
			nextIdx = scan.nextIndex;
		}
		if (!["run", "app", "functions", "compute", "builds", "build"].includes(groupTok)) {
			return [];
		}
		const subScan = scanCliSubcommandTokens(tokens, nextIdx, 1, spec);
		if (subScan.help) return [];
		if (subScan.unknownOption) {
			return [{ service: "gcloud:unknown-option", label: `gcloud (알 수 없는 전역 옵션 ${subScan.unknownOption})` }];
		}
		if (subScan.positionals.length === 0) return [];
		const subTok = subScan.positionals[0].token.toLowerCase();
		nextIdx = subScan.nextIndex;

		if (groupTok === "run" && subTok === "deploy") {
			const target = extractGcloudTarget(tokens, nextIdx);
			if (isNonProd(target)) return [];
			return [{ service: `gcloud:run:${target}`, label: `gcloud run deploy ${target}` }];
		}
		if (groupTok === "run" && (subTok === "services" || subTok === "service")) {
			const actScan = scanCliSubcommandTokens(tokens, nextIdx, 1, spec);
			if (actScan.help) return [];
			if (actScan.unknownOption) {
				return [{ service: "gcloud:unknown-option", label: `gcloud (알 수 없는 전역 옵션 ${actScan.unknownOption})` }];
			}
			if (actScan.positionals.length === 0) return [];
			const actTok = actScan.positionals[0].token.toLowerCase();
			if (actTok === "update") {
				const target = extractGcloudTarget(tokens, actScan.nextIndex);
				if (isNonProd(target)) return [];
				return [{ service: `gcloud:run:${target}`, label: `gcloud run services update ${target}` }];
			}
			if (actTok === "replace") {
				return [{ service: "gcloud:run:replace", label: "gcloud run services replace" }];
			}
			return [];
		}
		if (groupTok === "app" && subTok === "deploy") {
			return [{ service: "gcloud:app:default", label: "gcloud app deploy" }];
		}
		if (groupTok === "functions" && subTok === "deploy") {
			const target = extractGcloudTarget(tokens, nextIdx);
			if (isNonProd(target)) return [];
			return [{ service: `gcloud:functions:${target}`, label: `gcloud functions deploy ${target}` }];
		}
		if ((groupTok === "builds" || groupTok === "build") && subTok === "submit") {
			return [{ service: "gcloud:builds:submit", label: "gcloud builds submit" }];
		}
		if (groupTok === "compute" && subTok === "scp") {
			return [{ service: "gcloud:compute:scp", label: "gcloud compute scp" }];
		}
		if (groupTok === "compute" && subTok === "ssh") {
			const rawTarget = extractGcloudTarget(tokens, nextIdx);
			const target = rawTarget.replace(/^[^@]+@/, "").toLowerCase();
			if (isNonProd(target)) return [];
			const joined = tokens.join(" ");
			if (/(?:cp\s|mv\s|rm\s|tee\s|dd\s|docker\s+(?:cp|exec|restart|stop|rm|run|compose)|systemctl\s+(?:restart|stop|start|reload)|nginx\s+-s|>)/.test(joined)) {
				return [{ service: `gcloud:compute:${target}`, label: `gcloud compute ssh ${target} (원격 쓰기)` }];
			}
			return [];
		}
		return [];
	}
	if (bin === "kubectl") {
		const scan = scanCliSubcommandTokens(tokens, 1, 1, CLI_GLOBAL_OPTIONS.kubectl);
		if (scan.help) return [];
		if (scan.unknownOption) {
			return [{ service: "kubectl:unknown-option", label: `kubectl (알 수 없는 전역 옵션 ${scan.unknownOption})` }];
		}
		const sub = scan.positionals[0] ? scan.positionals[0].token : "";
		if (/^(?:apply|delete|rollout|set|scale|patch)$/i.test(sub)) {
			return [{ service: `kubectl:${sub.toLowerCase()}`, label: `kubectl ${sub}` }];
		}
		return [];
	}
	if (bin === "helm") {
		const scan = scanCliSubcommandTokens(tokens, 1, 1, CLI_GLOBAL_OPTIONS.helm);
		if (scan.help) return [];
		if (scan.unknownOption) {
			return [{ service: "helm:unknown-option", label: `helm (알 수 없는 전역 옵션 ${scan.unknownOption})` }];
		}
		const sub = scan.positionals[0] ? scan.positionals[0].token : "";
		if (/^(?:upgrade|install|uninstall|rollback)$/i.test(sub)) {
			return [{ service: `helm:${sub.toLowerCase()}`, label: `helm ${sub}` }];
		}
		return [];
	}
	if (bin === "terraform") {
		const scan = scanCliSubcommandTokens(tokens, 1, 1, CLI_GLOBAL_OPTIONS.terraform);
		if (scan.help) return [];
		if (scan.unknownOption) {
			return [{ service: "terraform:unknown-option", label: `terraform (알 수 없는 전역 옵션 ${scan.unknownOption})` }];
		}
		const sub = scan.positionals[0] ? scan.positionals[0].token : "";
		if (/^(?:apply|destroy)$/i.test(sub)) {
			return [{ service: `terraform:${sub.toLowerCase()}`, label: `terraform ${sub}` }];
		}
		return [];
	}
	if (bin === "flyctl" || bin === "fly") {
		const scan = scanCliSubcommandTokens(tokens, 1, 1, CLI_GLOBAL_OPTIONS.fly);
		if (scan.help) return [];
		if (scan.unknownOption) {
			return [{ service: "fly:unknown-option", label: `${bin} (알 수 없는 전역 옵션 ${scan.unknownOption})` }];
		}
		const sub = scan.positionals[0] ? scan.positionals[0].token : "";
		if (/^deploy$/i.test(sub)) {
			return [{ service: "fly:deploy", label: `${bin} deploy` }];
		}
		return [];
	}
	if (bin === "wrangler") {
		const scan = scanCliSubcommandTokens(tokens, 1, 1, CLI_GLOBAL_OPTIONS.wrangler);
		if (scan.help) return [];
		if (scan.unknownOption) {
			return [{ service: "wrangler:unknown-option", label: `wrangler (알 수 없는 전역 옵션 ${scan.unknownOption})` }];
		}
		const sub = scan.positionals[0] ? scan.positionals[0].token : "";
		if (/^(?:deploy|publish)$/i.test(sub)) {
			return [{ service: "cloudflare:workers", label: `wrangler ${sub}` }];
		}
		return [];
	}
	if (bin === "railway") {
		const scan = scanCliSubcommandTokens(tokens, 1, 1, CLI_GLOBAL_OPTIONS.railway);
		if (scan.help) return [];
		if (scan.unknownOption) {
			return [{ service: "railway:unknown-option", label: `railway (알 수 없는 전역 옵션 ${scan.unknownOption})` }];
		}
		const sub = scan.positionals[0] ? scan.positionals[0].token : "";
		if (/^up$/i.test(sub)) {
			return [{ service: "railway:up", label: "railway up" }];
		}
		return [];
	}
	if (bin === "supabase") {
		const scan1 = scanCliSubcommandTokens(tokens, 1, 1, CLI_GLOBAL_OPTIONS.supabase);
		if (scan1.help) return [];
		if (scan1.unknownOption) {
			return [{ service: "supabase:unknown-option", label: `supabase (알 수 없는 전역 옵션 ${scan1.unknownOption})` }];
		}
		const sub1 = scan1.positionals[0] ? scan1.positionals[0].token.toLowerCase() : "";
		if (sub1 === "db") {
			const scan2 = scanCliSubcommandTokens(tokens, scan1.nextIndex, 1, CLI_GLOBAL_OPTIONS.supabase);
			if (scan2.help) return [];
			if (scan2.unknownOption) {
				return [{ service: "supabase:unknown-option", label: `supabase (알 수 없는 전역 옵션 ${scan2.unknownOption})` }];
			}
			const sub2 = scan2.positionals[0] ? scan2.positionals[0].token.toLowerCase() : "";
			if (sub2 === "push") {
				return [{ service: "supabase:db:push", label: "supabase db push" }];
			}
		}
		return [];
	}
	return [];
}

function resolveGateRoot(startDir) {
	if (!startDir) return "";
	let cur = path.resolve(startDir);
	const candidates = [cur];
	for (;;) {
		if (
			fs.existsSync(path.join(cur, "config", "deploy-gate.json")) ||
			fs.existsSync(path.join(cur, ".agents", "progress")) ||
			fs.existsSync(path.join(cur, ".git"))
		) {
			if (!candidates.includes(cur)) candidates.push(cur);
		}
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	for (const c of candidates) {
		if (fs.existsSync(path.join(c, "config", "deploy-gate.json"))) return c;
	}
	return candidates[0];
}

/** 인스턴스 확장(config/deploy-gate.json 의 prodPatterns 및 선택 플러그인 classifyCommand). */
function classifyInstanceExtension(command, tokens, dir, assigns, rootDir = "") {
	const hits = [];
	const clause = clauseText(tokens, assigns);
	const pushErrorHit = (msg) => {
		hits.push({
			service: "unclassified:instance-extension",
			label: `분류 불가: 인스턴스 확장 오류(${msg})`,
			clause,
			unclassified: true,
			tool: "instance-extension",
		});
	};
	try {
		const { deployGateConfigPath, loadDeployGateConfig, loadDeployGatePlugin } = require("./deploy-readiness.js");
		const root = rootDir || process.env.DEPLOY_READINESS_ROOT || resolveGateRoot(dir);
		const cfgPath = deployGateConfigPath(root);
		const cfg = loadDeployGateConfig(root);
		if (!cfg) {
			if (cfgPath && fs.existsSync(cfgPath)) {
				pushErrorHit("config/deploy-gate.json 파싱 실패");
			}
			return hits;
		}
		if (Array.isArray(cfg.prodPatterns)) {
			for (const p of cfg.prodPatterns) {
				if (!p || typeof p.pattern !== "string" || !p.service) continue;
				try {
					const re = new RegExp(p.pattern, "i");
					if (re.test(clause) || re.test(command)) {
						hits.push({ service: String(p.service), label: String(p.summary || p.label || p.service), clause });
					}
				} catch (err) {
					pushErrorHit(`prodPatterns 정규식 오류(${p.service}): ${err && err.message ? err.message : String(err)}`);
				}
			}
		}
		try {
			const plugin = loadDeployGatePlugin(root, cfg);
			if (plugin && typeof plugin.classifyCommand === "function") {
				const res = plugin.classifyCommand(command, { tokens, assigns, dir, root, config: cfg, clause });
				for (const h of Array.isArray(res) ? res : res ? [res] : []) {
					if (h && typeof h.service === "string" && h.service) {
						hits.push({ ...h, label: h.label || h.summary || h.service, clause: h.clause || clause });
					}
				}
			}
		} catch (err) {
			pushErrorHit(`플러그인 오류: ${err && err.message ? err.message : String(err)}`);
		}
		return hits;
	} catch (err) {
		pushErrorHit(err && err.message ? err.message : String(err));
		return hits;
	}
}

function classifyDeployScript(tokens, cwd, assigns = []) {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const base = path.basename(t);
		if (!/deploy/i.test(base)) continue;
		// 셸은 bash 문법으로 스크립트 자리를 찾는다(설계 검수 14회차 1번: bash -e·bash -euo pipefail 뒤의 스크립트).
		if (i > 0 && SHELL_RE.test(tokens[0])) {
			if (i !== require("./effective-argv.js").shellInvocation(tokens).script) continue;
		} else {
		// 실행 자리여야 한다: 첫 토큰이거나 인터프리터 바로 뒤(옵션 건너뜀).
		let j = i - 1;
		while (j >= 0 && tokens[j].startsWith("-")) j--;
		// node -e·python -c 뒤의 글은 코드이지 스크립트 경로가 아니다.
		const code = i > 0 && /^(?:-e|-c|-p|--eval|--print)$/.test(tokens[i - 1]);
		const executed = !code && (i === 0 || (j === 0 && INTERPRETERS.test(tokens[0])));
		if (!executed) continue;
		}
		const args = tokens.slice(i + 1);
		const prod = PROD_WORD.test(base) || args.some((a) => PROD_ARG.test(a) || PROD_WORD.test(a)) || assigns.some((a) => PROD_WORD.test(a.slice(a.indexOf("="))));
		if (!prod) continue;
		const resolved = t.includes("/") ? path.resolve(cwd || "/", t) : t;
		return { service: `script:${resolved}`, label: `${base} ${args.join(" ")}`.trim() };
	}
	return null;
}


function classifyPackageScript(tokens, cwd) {
	if (!/(?:^|\/)(npm|pnpm|yarn|bun)$/.test(tokens[0] || "")) return null;
	const runIndex = tokens[1] === "run" || tokens[1] === "run-script" ? 2 : 1;
	const script = tokens[runIndex] || "";
	if (!/deploy/i.test(script)) return null;
	const args = tokens.slice(runIndex + 1);
	if (!/prod|production|live/i.test(script) && !args.some((a) => PROD_ARG.test(a))) return null;
	return { service: `package:${cwd || "?"}:${script}`, label: `${tokens[0]} run ${script}` };
}

/** 실행되는 로컬 셸 스크립트 파일 경로. 셸 인터프리터 뒤 파일, source·., 경로로 부른 셸 파일. 없으면 null. */
function executedShellFile(tokens, cwd, dirKnown = true, root = "", anySize = false) {
	let target = null;
	let viaShell = false;
	if (SHELL_RE.test(tokens[0])) {
		const at = require("./effective-argv.js").shellInvocation(tokens).script;
		if (at < 0) return null;
		target = tokens[at];
		viaShell = true;
	} else if (tokens[0] === "source" || tokens[0] === ".") {
		target = tokens[1];
		viaShell = true;
	} else if (tokens[0].includes("/")) target = tokens[0];
	if (!target) return null;
	// 경로는 cd 추적과 같은 한 곳에서 푼다($HOME, ~, 명령 안의 대입. 설계 검수 17회차 2번).
	const file = require("./effective-argv.js").resolvePathWord(target, cwd, root, dirKnown);
	if (!file) return null;
	try {
		const st = fs.statSync(file);
		// 읽는 한도는 scriptText 와 같다. 한도를 넘는 파일은 배포 훅이 따로 막는다(구현 검수 3번).
		if (!st.isFile() || (!anySize && st.size > SCRIPT_READ_LIMIT)) return null;
		if (!viaShell) {
			const head = fs.readFileSync(file, "utf8").slice(0, 200);
			if (!/\.(?:sh|bash)$/.test(file) && !/^#!.*\b(?:ba|z|da)?sh\b/.test(head)) return null;
		}
		return file;
	} catch {
		return null;
	}
}

/** 스크립트를 부른 낱말에 운영 아닌 표시가 있고 운영 표시가 없는가. 디렉터리 이름은 보지 않는다. */
// 단계 표시는 낱말 전체가 단계 이름일 때만 센다. 경로 속 "-dev/"나 스크립트 파일 이름("…-test.sh")은 아니다(설계 검수 16회차 1번).
const STAGE_WORD = /^(?:--?)?(dev|develop|development|staging|stage|stg|preview|test|testing|sandbox|local)$/i;
function invokedNonProd(tokens, file, assigns = []) {
	const head = path.basename(tokens[0]);
	const at = SHELL_RE.test(tokens[0]) ? require("./effective-argv.js").shellInvocation(tokens).script : head === "source" || head === "." ? 1 : 0;
	if (at < 0) return false;
	const words = [...tokens.slice(at + 1), ...assigns.map((a) => a.slice(a.indexOf("=") + 1))];
	if ([path.basename(file), ...words].some((w) => PROD_WORD.test(w) || PROD_ARG.test(w))) return false;
	return words.some((w) => STAGE_WORD.test(w));
}

/**
 * 스크립트 안 운영 명령의 대상 변수를 스크립트를 부른 모양에 맡겨도 되는가(설계 검수 15·16회차).
 * 스크립트가 그 변수에 글자 그대로의 값을 하나만 주면 그 값이 정한다. 여러 값(case 로 prod·dev 를 고름)이 운영과 아닌 것으로
 * 갈리거나, 스크립트 밖(인자·환경)에서 오면 부른 모양을 따른다. 변수 이름에 prod 가 있으면(PROD_VM) 맡기지 않는다.
 */
function variableTargetIsNonProd(nameWord, text, dir, nonProdCall, assigns = []) {
	const varName = nameWord.replace(/^\$\{?|\}$/g, "");
	if (PROD_WORD.test(varName.replace(/_/g, "-"))) return false;
	const r = require("./effective-argv.js").dynamicWord(nameWord, text, dir);
	if (r && r.words && r.words.length) {
		const nonProd = r.words.map((w) => isNonProd(w));
		if (nonProd.every(Boolean)) return true;
		if (!nonProd.some(Boolean)) return false;
	} else {
		// 스크립트가 정하지 않은 변수는 부르는 쪽이 앞에 KEY=value 로 준 값을 본다(APP=web-staging bash release.sh).
		const given = assigns.find((x) => x.startsWith(`${varName}=`));
		if (given !== undefined) return isNonProd(given.slice(varName.length + 1));
	}
	return nonProdCall;
}

/**
 * 셸 글에서 따옴표·$( )·${ }·백틱 속 글자와 주석을 빈칸으로 바꾼다(줄바꿈은 남긴다).
 * 여러 줄에 걸친 따옴표도 따라간다. 끝까지 닫히지 않으면 null(모름).
 */
function blankShellText(text) {
	const out = [];
	const st = [{ k: "n", p: 0 }];
	const top = () => st[st.length - 1];
	for (let i = 0; i < text.length; i++) {
		const c = text[i], n = text[i + 1], s = top(), lvl0 = st.length === 1;
		const emit = (ch) => out.push(lvl0 || ch === "\n" ? ch : " ");
		if (s.k === "'") { if (c === "'") st.pop(); out.push(c === "\n" ? "\n" : " "); continue; }
		// $'…' 는 \' 가 닫힘이 아니다.
		if (s.k === "$'") { if (c === "\\" && n !== undefined) { out.push(" ", n === "\n" ? "\n" : " "); i++; continue; } if (c === "'") st.pop(); out.push(c === "\n" ? "\n" : " "); continue; }
		if (c === "\\" && s.k !== "'") { emit(c); if (n !== undefined) { emit(n); i++; } continue; }
		if (s.k === "n" || s.k === "$(") {
			if (c === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) { while (i < text.length && text[i] !== "\n") { out.push(" "); i++; } if (i < text.length) out.push("\n"); continue; }
			if (c === "$" && n === "'") { emit(" "); emit(" "); i++; st.push({ k: "$'" }); continue; }
			if (c === "'") { emit(" "); st.push({ k: "'" }); continue; }
			if (c === '"') { emit(" "); st.push({ k: '"' }); continue; }
			if (c === "\x60") { emit(" "); st.push({ k: "\x60" }); continue; }
			if (c === "$" && n === "(") { emit(" "); emit(" "); i++; st.push({ k: "$(", p: 0 }); continue; }
			if (c === "$" && n === "{") { emit(" "); emit(" "); i++; st.push({ k: "${" }); continue; }
			if (s.k === "$(") { if (c === "(") s.p++; else if (c === ")") { if (s.p === 0) { st.pop(); out.push(" "); continue; } s.p--; } }
			emit(c); continue;
		}
		if (s.k === '"') {
			if (c === '"') { st.pop(); out.push(st.length === 1 ? " " : " "); continue; }
			if (c === "$" && n === "(") { out.push(" ", " "); i++; st.push({ k: "$(", p: 0 }); continue; }
			if (c === "$" && n === "{") { out.push(" ", " "); i++; st.push({ k: "${" }); continue; }
			if (c === "\x60") { out.push(" "); st.push({ k: "\x60" }); continue; }
			emit(c); continue;
		}
		if (s.k === "${") {
			if (c === "}") { st.pop(); out.push(" "); continue; }
			if (c === "'") { out.push(" "); st.push({ k: "'" }); continue; }
			if (c === '"') { out.push(" "); st.push({ k: '"' }); continue; }
			if (c === "$" && (n === "(" || n === "{")) { out.push(" ", " "); i++; st.push(n === "(" ? { k: "$(", p: 0 } : { k: "${" }); continue; }
			emit(c); continue;
		}
		if (s.k === "\x60") { if (c === "\x60") { st.pop(); out.push(" "); continue; } emit(c); continue; }
	}
	return st.length === 1 ? out.join("") : null;
}

/**
 * 함수 몸 안에 있는 줄 번호 집합. 함수 정의 줄(name() {, function name {)부터 중괄호가 닫힐 때까지 센다.
 * 따옴표·치환 속 글과 주석은 글 전체 기준으로 빼고 센다(blankShellText).
 * 몸이 ( … ) 이거나, 닫힘을 못 찾거나, 경계가 애매하면 null(모름 → 갈래를 고르지 않음).
 */
function functionLines(text) {
	const blanked = blankShellText(text);
	if (blanked === null) return null;
	const lines = blanked.split("\n");
	const inside = new Set();
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		// 줄 시작이 아닌 함수 정의(:; f() {, a && f() {)는 경계를 알 수 없어 모름으로 본다(검수 6회차 1번).
		const anyDef = /(?:^|[^\w$])[A-Za-z_][\w:.-]*\s*\(\s*\)|(?:^|[\s;&|(])function\s/.test(l);
		const def = l.match(/^\s*(?:function\s+[A-Za-z_][\w:.-]*\s*(?:\(\s*\))?|[A-Za-z_][\w:.-]*\s*\(\s*\))\s*(.*)$/);
		if (!def) { if (anyDef) return null; continue; }
		let body = def[1];
		let j = i;
		if (!body.trim()) { j = i + 1; while (j < lines.length && !lines[j].trim()) j++; if (j >= lines.length) return null; body = lines[j]; }
		if (!/^\s*\{/.test(body)) return null;
		let depth = 0, end = -1, contd = false;
		for (let k = j; k < lines.length; k++) {
			const s = k === j ? body : lines[k];
			// 함수 몸 안 heredoc(<<, <<- ; <<< 는 아님)은 본문 줄을 알 수 없어 모름.
			if (/(?:^|[^<])<<(?!<)/.test(s)) return null;
			// 중괄호는 명령 자리(줄 시작, ; & | ( 뒤, { 뒤)의 낱말 하나일 때만 센다.
			// 인자 자리(echo })나 낱말 속({ } 섞임, echo x}), 줄 이어짐 뒤 } 이면 모름(검수 6회차 2번, 7회차 1번).
			let cmdPos = !contd;
			for (const tok of s.match(/[;&|()]+|[^\s;&|()]+/g) || []) {
				if (/^[;&|()]+$/.test(tok)) { cmdPos = true; continue; }
				if (tok === "{" || tok === "}") { if (!cmdPos) return null; depth += tok === "{" ? 1 : -1; cmdPos = tok === "{"; continue; }
				if (/[{}]/.test(tok)) return null;
				cmdPos = false;
			}
			contd = /\\\s*$/.test(s);
			if (depth <= 0) { end = k; break; }
		}
		if (end < 0) return null;
		for (let k = i; k <= end; k++) inside.add(k);
		i = end;
	}
	return inside;
}

/** 스크립트에 넘긴 위치 인자(스크립트 낱말 뒤). */
function scriptArgs(tokens) {
	const head = path.basename(tokens[0]);
	const at = SHELL_RE.test(tokens[0]) ? require("./effective-argv.js").shellInvocation(tokens).script : head === "source" || head === "." ? 1 : 0;
	return at < 0 ? [] : tokens.slice(at + 1);
}

/**
 * 스크립트가 위치 인자로 환경을 고르는 꼴(E="$1"; case "$E" in prod) … ;; dev) … ;; esac)이면, 실제로 준 글자 인자에 맞는 갈래만 남긴다.
 * 확실하지 않으면 원문을 그대로 돌려준다(더 막는 쪽): 인자 없음·변수 인자, shift·getopts·set --·eval, 변수 재대입·local·read·unset,
 * 부르는 명령이나 훅 환경에 같은 변수, 단순 글자가 아닌 갈래 무늬, ;& ;;&, 갈래 안 heredoc·중첩 case.
 */
function selectCaseArms(text, args, callerText = "", assigns = []) {
	if (!text || !args.length) return text;
	if (/(?:^|[\s;&|(])(?:shift|getopts|eval|source)\b|\bset\s+--|(?:^|[\s;&|(])\.\s+\S/m.test(text)) return text;
	const inFunction = functionLines(text);
	const bound = new Map();
	for (const m of text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=(?:"\$\{?([1-9])\}?"|\$\{?([1-9])\}?)[ \t]*(?:#.*)?$/gm)) {
		const v = m[1];
		// 함수 안의 $1 은 함수 인자다(검수 5회차 1번). 함수 밖(최상위) 대입만 묶는다.
		const lineNo = text.slice(0, m.index).split("\n").length - 1;
		if (inFunction === null || inFunction.has(lineNo)) continue;
		const arg = args[Number(m[2] || m[3]) - 1];
		if (arg === undefined || !/^[A-Za-z0-9._-]+$/.test(arg)) continue;
		const assignCount = [...text.matchAll(new RegExp(`(?:^|[\\s;&|(])${v}(?:\\[[^\\]]*\\])?\\+?=`, "gm"))].length;
		if (assignCount !== 1) continue;
		if (new RegExp(`\\b(?:local|declare|typeset|unset|read|mapfile|readarray|for)\\b[^\\n]*\\b${v}\\b|printf\\s+-v\\s*${v}\\b|\\$\\{${v}:?[=?+-]`).test(text)) continue;
		if (new RegExp(`\\b${v}\\b`).test(callerText) || assigns.some((a) => a.startsWith(`${v}=`)) || process.env[v] !== undefined) continue;
		bound.set(v, arg);
	}
	if (!bound.size) return text;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const head = lines[i].match(/^\s*case\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s+in\s*$/);
		if (!head || !bound.has(head[1])) continue;
		const arg = bound.get(head[1]);
		const arms = [];
		let cur = null, end = -1, ok = true;
		for (let j = i + 1; j < lines.length; j++) {
			const l = lines[j], t = l.trim();
			if (/^esac\b/.test(t) && !cur) { end = j; break; }
			if (/(?:^|[\s;&|(])(?:case|esac)\b|<<|;&|;;/.test(t.replace(/;;\s*$/, ""))) { ok = false; break; }
			if (!cur) {
				if (t === "" || t.startsWith("#")) continue;
				const a = t.match(/^\(?\s*([^()\s]+)\s*\)(.*)$/);
				if (!a) { ok = false; break; }
				const pats = a[1].split("|");
				if (!pats.every((p) => p === "*" || /^[A-Za-z0-9._-]+$/.test(p))) { ok = false; break; }
				cur = { pats, from: j, to: j };
				if (/;;\s*$/.test(a[2])) { arms.push(cur); cur = null; }
				continue;
			}
			cur.to = j;
			if (/;;\s*$/.test(t)) { arms.push(cur); cur = null; }
		}
		if (!ok || end < 0 || cur) return text;
		const keep = arms.find((a) => a.pats.includes(arg));
		const envSwitch = STAGE_WORD.test(arg) && arms.some((a) => a.pats.some((p) => /^(?:prod|production|live)$/i.test(p)));
		if (!keep || !envSwitch) { i = end; continue; }
		for (const a of arms) if (a !== keep) for (let k = a.from; k <= a.to; k++) lines[k] = "";
		i = end;
	}
	return lines.join("\n");
}

const SCRIPT_READ_LIMIT = 1024 * 1024;
/** 스크립트 파일 전체 글(1MB 까지). 못 읽으면 빈 글. */
function scriptText(file) {
	try {
		if (fs.statSync(file).size > SCRIPT_READ_LIMIT) return "";
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function scriptTooLarge(file) {
	try {
		return fs.statSync(file).size > SCRIPT_READ_LIMIT;
	} catch {
		return false;
	}
}

/** 운영 변경 명령 목록을 돌려준다. 없으면 빈 배열. */
function classifyProdMutations(command, cwd, depth = 0, scriptContext = false, rootDir = "") {
	const found = [];
	// 중첩 한도를 넘으면 안을 읽지 않으므로 확인 불가로 막는다(빈 결과로 통과시키지 않음, #95 검수 4단계 감싸기).
	if (depth > 3) return String(command || "").trim() ? [{ service: "unclassified:depth-limit", label: "분류 불가: 셸 대본 중첩이 3단계를 넘어 안의 명령을 확인할 수 없음", clause: "", unclassified: true, tool: "depth-limit" }] : found;
	const gateRoot = rootDir || process.env.DEPLOY_READINESS_ROOT || resolveGateRoot(cwd);
	// 앞 절의 cd 를 따라간다(설계 검수 6회차 2번): "cd <워크트리> && ./deploy/vm/deploy.sh prod" 는
	// 세션 cwd 가 아니라 그 워크트리의 스크립트다. 배포 준비 기록은 이 경로의 저장소 HEAD 를 본다.
	// 감싸개(setsid, timeout -s KILL, flock, systemd-run)와 문자열로 넘긴 명령(bash -c, tmux, script -c)은
	// effective-argv 가 벗긴다(설계 검수 9회차 2번).
	const { effectiveCommands } = require("./effective-argv.js");
	const entries = effectiveCommands(command, cwd);
	for (const entry of entries) {
		const { argv: tokens, assigns, dir, dirKnown } = entry;
		const variableProgram = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\}|[0-9]+|[@*?#$!])$/.test(tokens[0] || "");
		if (entry.opaque || variableProgram) {
			const opaqueEntry = entry.opaque ? entry : { ...entry, opaque: `실행 프로그램이 변수라 대상을 확인할 수 없음(${tokens[0]})` };
			const tool = opaqueTool(opaqueEntry);
			if (tool) found.push(unclassifiedOpaque(opaqueEntry, tool));
			continue;
		}
		if (/^(?:echo|printf|cat|grep|rg|sed|awk|head|tail|less|wc|git|man)$/.test(path.basename(tokens[0]))) continue;
		const extHits = classifyInstanceExtension(command, tokens, dir, assigns, gateRoot);
		if (extHits.length) {
			for (const h of extHits) found.push(h);
			continue;
		}
		// --ids 가 여러 운영 대상을 가리키면 hit 도 여러 개다. classifyAz 는 첫 원소만 내고, 여기서는 전부를 쓴다.
		const azHits = classifyAzAll(tokens);
		// 준비 기록 검사는 바깥 글자가 아니라 실제로 도는 절을 본다(설계 검수 10회차 2번: bash -c "…", 스크립트 파일 속 --image 가 ops 로 통과).
		if (azHits.length) for (const h of azHits) found.push({ ...h, clause: clauseText(tokens, assigns) });
		else {
			const cloudHits = classifyGeneralCloudCli(tokens);
			if (cloudHits.length) for (const h of cloudHits) found.push({ ...h, clause: clauseText(tokens, assigns) });
			else {
				// classifySsh 는 여러 hit 를 낼 수 있다(비운영 호스트 안의 운영 변경 재분류, 검수 2회차 1번).
				const sshHits = [...classifySsh(tokens, dir, depth, gateRoot), ...classifyScp(tokens)];
				if (sshHits.length) for (const h of sshHits) found.push({ ...h, clause: clauseText(tokens, assigns) });
				else {
					const hit = classifyDeployScript(tokens, dir, assigns) || classifyPackageScript(tokens, dir);
					if (hit) found.push({ ...hit, clause: clauseText(tokens, assigns) });
					else {
						// 로컬 셸 스크립트 파일을 실행하면 그 안의 명령도 본다(설계 검수 8회차 4번: 운영 배포를 스크립트 파일로 감싸면 안 보였음).
						const file = executedShellFile(tokens, dir, dirKnown, command, true);
						// 파일 전체를 한 번에 읽는다. 파서가 줄바꿈·주석·heredoc 을 bash 처럼 다루므로, 파일 안의 "bash <<EOF" 본문도 셸 프로그램으로 읽힌다(설계 검수 11회차 2번).
						// 대상이 변수인 명령은, 스크립트를 부른 낱말(스크립트 이름, 뒤 인자, 앞의 KEY=value 값)에 dev 같은 운영 아닌 표시가 있고
						// prod 표시가 없으면 운영이 아니다.
						const nonProdCall = file && invokedNonProd(tokens, file, assigns);
						// 안쪽 대본이 읽기 한도보다 크면 확인 불가로 막는다(바깥 크기 검사는 첫 단계 대본만 봄, #95 검수 1MB 감싸기).
						if (file && scriptTooLarge(file)) {
							found.push({ service: "unclassified:script-too-large", label: `분류 불가: 대본이 커서(${SCRIPT_READ_LIMIT / 1024 / 1024}MB 넘음) 안을 읽지 않음(${path.basename(file)})`, clause: clauseText(tokens, assigns), unclassified: true, tool: "script-too-large", file });
							continue;
						}
						const text = file ? selectCaseArms(scriptText(file), scriptArgs(tokens), command, assigns) : "";
						if (file) for (const h of classifyProdMutations(text, dir, depth + 1, true, gateRoot)) {
							if (h.variable && variableTargetIsNonProd(h.variable, text, dir, nonProdCall, assigns)) continue;
							// 목록 밖 그룹(network 등)의 변수 대상이 스크립트 안에서 글자 그대로 한 값이면 서비스 이름을 그 값으로 적는다.
							let service = h.service;
							if (h.variable && h.unlistedGroup) {
								const r = require("./effective-argv.js").dynamicWord(h.variable, text, dir);
								if (r && r.words && r.words.length === 1 && /^[A-Za-z0-9._-]+$/.test(r.words[0])) service = `azure:${h.unlistedGroup}:${r.words[0].toLowerCase()}`;
							}
							// 변수 대상의 dev·prod 판단은 그 명령을 품은 스크립트 한 단계에서 끝낸다. 바깥 단계는 풀어 줄 수 없다(설계 검수 17회차 1번).
							found.push({ ...h, service, ...(h.unclassified ? { file: h.file || file } : {}), variable: "", label: `${h.label} (${path.basename(file)} 안)` });
						}
					}
				}
			}
		}
	}
	const normalized = gateNormalize(gateNormalize(gateWithoutComments(command)));
	const normalizedEntries = effectiveCommands(normalized, cwd);
	for (const hit of gateNetworkRisks(command, normalized, normalizedEntries, cwd, scriptContext)) {
		if (!found.some((h) => h.service === hit.service)) found.push(hit);
	}
	// 셸 또는 원격 셸의 표준 입력으로 실행되는 heredoc 본문도 같은 규칙으로 검사한다.
	for (const clause of require("./git-command-parser.js").shellClauses(command)) {
		const parser = require("./effective-argv.js");
		const call = parser.expandClause(clause)[0];
		const argv = call?.argv || [];
		const program = path.basename(argv[0] || "");
		const remoteShell = program === "ssh" && (argv.length <= 3 || /(?:^|[\s/])(?:ba|da|k|z)?sh(?:\s|$)/.test(argv.slice(1).join(" ")));
		const invocation = /^(?:bash|sh|dash|zsh|ksh)$/.test(program) ? parser.shellInvocation(argv) : null;
		const readsShellInput = invocation && invocation.command < 0 && invocation.script < 0 && !invocation.noexec;
		if (!readsShellInput && !remoteShell) continue;
		for (const body of clause.heredocs || []) for (const hit of classifyProdMutations(body, cwd, depth + 1, false, gateRoot)) {
			if (/^(?:cloudflare:|network:write:)/.test(hit.service) && !found.some((h) => h.service === hit.service)) found.push(hit);
		}
	}
	return found;
}

/** 실제로 도는 절을 다시 셸 글로 적는다(앞의 환경 변수 대입 포함). 글자가 있는 인자는 작은따옴표로 감싼다. */
function shellQuote(t) {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`;
}
function clauseText(argv, assigns = []) {
	return [...assigns.map((a) => { const i = a.indexOf("="); return `${a.slice(0, i + 1)}${shellQuote(a.slice(i + 1))}`; }), ...argv.map(shellQuote)].join(" ");
}

module.exports = { classifyProdMutations, classifyGeneralCloudCli, isNonProd, executedShellFile, scriptText, clauseText, SCRIPT_READ_LIMIT };
