// Existing readiness script-binding responsibility; behavior is owned by the public facade.
const path = require("path");
const { deployGateConfigPath } = require("./deploy-readiness-policy.js");

const PINNED_SCRIPT_HEAD = /^(?:sudo\s+(?:\S+\s+)*?)?bash\s+\//;

const AZ_READONLY_VALUE_FLAGS = new Map([
	["-g", "rg"],
	["--resource-group", "rg"],
	["-n", "name"],
	["--name", "name"],
	["--command-id", "command-id"],
	["--scripts", "scripts"],
	["--subscription", "subscription"],
	["--query", "query"],
	["-o", "output"],
	["--output", "output"],
]);

/**
 * 읽기 전용 무코드 허용 명령을 원문 문자열 그대로 엄격히 토큰화한다.
 * 셸 연산자·따옴표 쪼개기(--scr"i"pts, --scripts=""@p 등)·치환·글롭이 있으면 null 을 돌려 기존 경로로 떨어뜨린다.
 */
function tokenizeStrictNoCodeCommand(command) {
	if (typeof command !== "string") return null;
	const s = command.trim();
	if (!s || /[\r\n\0;|&`<>\\]|\$\(|\$\{/.test(s)) return null;
	const tokens = [];
	let i = 0;
	while (i < s.length) {
		while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
		if (i >= s.length) break;
		const ch = s[i];
		if (ch === "'" || ch === '"') {
			const quote = ch;
			const close = s.indexOf(quote, i + 1);
			if (close < 0) return null;
			if (close + 1 < s.length && s[close + 1] !== " " && s[close + 1] !== "\t") return null;
			const inner = s.slice(i + 1, close);
			if (quote === '"' && inner.includes("$")) return null;
			tokens.push({ v: inner, q: quote === "'" ? "single" : "double" });
			i = close + 1;
		} else {
			const start = i;
			while (i < s.length && s[i] !== " " && s[i] !== "\t") {
				if (/['"\\$`;|&<>()*?\[\]{}~#!]/.test(s[i])) return null;
				i++;
			}
			tokens.push({ v: s.slice(start, i), q: "none" });
		}
	}
	return tokens.length ? tokens : null;
}

/**
 * 허용된 정확한 읽기 전용 무코드 명령 꼴(az vm run-command invoke ... --scripts @<경로> 또는 2토큰 bash/sh <경로>)에서
 * 고정 대본 정보를 꺼낸다. --parameters·다중 --scripts·모르는 옵션·쪼갠 따옴표·sudo bash·인자 추가는 전부 null.
 */
function extractPinnedReadOnlyScript(command, c, clauses, files, fileHashes, services, cwd, root) {
	if (!c || clauses.unbalanced || clauses.length !== 1) return null;
	if ((c.subs && c.subs.length) || (c.heredocs && c.heredocs.length)) return null;
	if (c.some((t) => /^(\d*&?|&)>>?/.test(t) || /^\d*<</.test(t) || /^\d*<[^=]/.test(t) || t === "<")) return null;
	const tokens = tokenizeStrictNoCodeCommand(command);
	if (!tokens || tokens.length !== c.length) return null;
	for (let k = 0; k < tokens.length; k++) {
		if (tokens[k].v !== c[k]) return null;
	}

	let mode = null;
	let rawScript = null;
	let vmService = null;
	let sanitizedAzCommand = null;

	const baseCmd = path.basename(tokens[0].v).toLowerCase();
	if (tokens[0].q === "none" && tokens.length === 2 && (baseCmd === "bash" || baseCmd === "sh")) {
		if (tokens[1].q !== "none" || !tokens[1].v || tokens[1].v.startsWith("-")) return null;
		mode = "shell";
		rawScript = tokens[1].v;
	} else if (
		tokens[0].q === "none" && (tokens[0].v === "az" || baseCmd === "az")
		&& tokens.length >= 4
		&& tokens[1].q === "none" && tokens[1].v === "vm"
		&& tokens[2].q === "none" && tokens[2].v === "run-command"
		&& tokens[3].q === "none" && tokens[3].v === "invoke"
	) {
		const seen = new Set();
		const sanitizedParts = ["az", "vm", "run-command", "invoke"];
		let rg = null;
		let vmName = null;
		let commandId = null;
		let scriptsRaw = null;
		for (let i = 4; i < tokens.length; i++) {
			const tok = tokens[i];
			if (tok.q !== "none" || !tok.v.startsWith("-")) return null;
			if (tok.v === "--only-show-errors") {
				if (seen.has("only-show-errors")) return null;
				seen.add("only-show-errors");
				sanitizedParts.push(tok.v);
				continue;
			}
			let flag = tok.v;
			let val = null;
			let valQuoted = "none";
			if (tok.v.startsWith("--")) {
				const eq = tok.v.indexOf("=");
				if (eq >= 0) {
					flag = tok.v.slice(0, eq);
					val = tok.v.slice(eq + 1);
				}
			} else if (tok.v.includes("=")) {
				return null;
			}
			const key = AZ_READONLY_VALUE_FLAGS.get(flag);
			if (!key || seen.has(key)) return null;
			seen.add(key);
			if (val === null) {
				if (i + 1 >= tokens.length) return null;
				const nextTok = tokens[++i];
				if (!nextTok.v || nextTok.v.startsWith("-")) return null;
				val = nextTok.v;
				valQuoted = nextTok.q;
			}
			if (!val) return null;
			if (key !== "query" && valQuoted !== "none") return null;
			if (key === "rg") rg = val;
			else if (key === "name") vmName = val;
			else if (key === "command-id") {
				if (val !== "RunShellScript") return null;
				commandId = val;
			} else if (key === "scripts") {
				if (!val.startsWith("@") || val.length <= 1 || /[\s'"]/.test(val)) return null;
				scriptsRaw = val.slice(1);
			} else if (key === "output") {
				if (!/^(?:tsv|json|jsonc|table|yaml|yamlc|none)$/i.test(val)) return null;
			}
			if (key !== "scripts") {
				const qVal = valQuoted === "single" ? `'${val}'` : valQuoted === "double" ? `"${val}"` : val;
				sanitizedParts.push(flag, qVal);
			}
		}
		if (!rg || !vmName || commandId !== "RunShellScript" || !scriptsRaw) return null;
		vmService = `azure:vm:${vmName.toLowerCase()}`;
		if (!Array.isArray(services) || !services.includes(vmService)) return null;
		mode = "az-run-command";
		rawScript = scriptsRaw;
		sanitizedParts.push("--scripts", "0");
		sanitizedAzCommand = sanitizedParts.join(" ");
	} else {
		return null;
	}

	if (!rawScript || rawScript.includes("$")) return null;
	const abs = path.resolve(cwd || root || ".", rawScript);
	if (files.size !== 1 || !files.has(abs) || !fileHashes.has(abs)) return null;
	return { mode, abs, rawScript, sha256: fileHashes.get(abs), vmService, sanitizedAzCommand };
}

/**
 * 읽기 전용 대본 무코드 바인딩(B1~B4, R5)을 fail-closed 로 검증한다.
 * 설정 오류(와일드카드 service·비정상 config) 및 설정 파일 git 미일치 시에는 차단({ ok:false })하고,
 * 명령 형식/대본/리뷰 바인딩/sha-경로-서비스가 맞지 않을 때는 null 을 돌려 기존 경로(승인 코드 또는 차단)로 떨어뜨린다.
 */
function matchReadOnlyScriptBinding({ cfg, root, command, clauses, files, fileHashes, services, cwd, planBinding }) {
	const { validateReadOnlyScriptsConfig, verifyRepoFileGitClean, reviewedReadOnlyScripts } = require("./deploy-plan.js");
	const valid = validateReadOnlyScriptsConfig(cfg);
	if (!valid.ok) return { ok: false, why: valid.why };
	if (valid.items.length === 0) return null;
	if (services.some((sv) => sv.startsWith("script:") || sv.startsWith("package:"))) return null;
	const target = extractPinnedReadOnlyScript(command, clauses[0], clauses, files, fileHashes, services, cwd, root);
	if (!target) return null;

	const shaAndSvcMatched = valid.items.filter((item) => item.sha256 === target.sha256 && services.includes(item.service));
	if (shaAndSvcMatched.length === 0) return null;

	const cleanConfig = verifyRepoFileGitClean(deployGateConfigPath(root), null, "config/deploy-gate.json");
	if (!cleanConfig.ok) {
		return { ok: false, why: `읽기 전용 대본 허용 거부: ${cleanConfig.why}` };
	}

	const cleanScript = verifyRepoFileGitClean(target.abs, cleanConfig.realTop, target.rawScript);
	if (!cleanScript.ok || cleanScript.sha256 !== target.sha256) return null;

	const matched = shaAndSvcMatched.filter((item) => item.path === cleanScript.rel);
	if (!services.every((s) => matched.some((item) => item.service === s))) return null;

	const gatesDir = planBinding && planBinding.gatesDir;
	if (!gatesDir) return null;
	let reviewed;
	try { reviewed = reviewedReadOnlyScripts(gatesDir, root); } catch { return null; }
	for (const s of services) {
		const item = matched.find((m) => m.service === s);
		if (!item) return null;
		const bound = reviewed.some((r) =>
			r && typeof r === "object"
			&& r.sha256 === item.sha256
			&& r.path === item.path
			&& r.service === item.service
			&& r.script_sha256 === cleanScript.sha256
		);
		if (!bound) return null;
	}

	const notes = [...new Set(matched.map((item) => item.note || "").filter(Boolean))];
	return {
		ok: true,
		ops: false,
		readOnlyNoCode: true,
		readOnlyTarget: target,
		fact: `읽기 전용 대본 승인 생략 확인: ${cleanConfig.rel}·${cleanScript.rel}(HEAD·리뷰 일치) readOnlyScripts sha256 ${cleanScript.sha256.slice(0, 12)} (${services.join(", ")}${notes.length ? `, ${notes.join("; ")}` : ""})`,
	};
}

/**
 * 계획서 단계·명령·고정 파일·인스턴스 확장(config/deploy-gate.json + 선택 plugin)의 결합을 검증한다.
 */

module.exports = { PINNED_SCRIPT_HEAD, AZ_READONLY_VALUE_FLAGS, tokenizeStrictNoCodeCommand, extractPinnedReadOnlyScript, matchReadOnlyScriptBinding };
