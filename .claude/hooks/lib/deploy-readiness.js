"use strict";
/**
 * 운영 변경 준비 기록 및 인스턴스 결합 규칙 확인 (deploy-guard 가 1회용 코드를 내기 전에 부른다).
 *
 * 공통 뼈대 규칙:
 * - 인스턴스 설정 파일(config/deploy-gate.json + 선택 plugin 모듈)에서 허용 운영 서비스 목록과
 *   서비스별 결합 규칙을 읽는다. 설정이 없거나 등록되지 않은 운영 서비스는 기본으로 막는다("알 수 없는 운영 명령은 막음").
 * - 단계 명령 바이트 대조: 실행 명령이 승인된 계획서 단계의 commands 원문과 바이트 단위로 정확히 일치해야 한다.
 * - 고정 파일 sha256 대조: 단계의 files 에 적힌 모든 파일의 실제 디스크 해시가 일치해야 한다.
 * - 배포 준비 기록(.agents/progress/<작업>/gates/deploy.json)이 있거나 config/deploy-gate.json 의
 *   requireReadiness 가 true 이면 kind(feature | ops | rollback), 후보 커밋/태그, ET/코드/시험 검수 영수증을 함께 검증한다.
 */
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { stripReserved, SHELLS, SHELL_ALT } = require("./effective-argv.js");

const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const TOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const KINDS = new Set(["feature", "ops", "rollback"]);
// 운영에 올라가는 판을 바꾸는 명령 부류. ops 로 신고할 수 없다.
const VERSION_CHANGE = /--image\b|--yaml\b|--container-image\b|\brevision\s+(?:copy|activate)\b|\bingress\s+traffic\s+set\b|--revision-weight\b|\bset-image\b|\bdocker\s+push\b/;
// ops 는 설정만 바꾸는 명령일 때만 받는다. 목록 밖 명령은 feature 나 rollback 으로 신고한다.
const CONFIG_ONLY = /--(?:set|remove|replace)-env-vars\b|--(?:min|max)-replicas\b|--cpu\b|--memory\b|\bscale\b|\brestart\b|\brevision\s+(?:deactivate|restart|label)\b|\bingress\s+(?:enable|disable|access-restriction|sticky-sessions|cors)\b|\bsecret\s+(?:set|remove)\b|\b(?:stop|start)\b|\bvm\s+deallocate\b|\bdisk\s+update\b|\bsnapshot\s+create\b|\b(?:vm|disk|snapshot|nic|public-ip|nsg|flexible-server)\s+delete\b/;
// VM·컨테이너 안에서 도는 글. 글이 명령에 드러나지 않거나 코드를 올리는 부류면 ops 가 아니다.
const INNER_OPAQUE = new RegExp("\\$\\(|`|\\$\\{?[A-Za-z_]|(?:^|\\s)@\\S|\\bbase64\\b|\\S\\.(?:sh|bash|py|js|mjs|cjs|ts|rb|pl|php)\\b|(?:^|[\\s;&|\"'(])(?:" + SHELL_ALT + "|python\\d*(?:\\.\\d+)?|node|perl|ruby|php|source)\\s+(?!-c\\b|-e\\b)[^\\s-]|(?:^|[\\s;&|\"'(])\\.{1,2}\\/\\S|(?:^|[;&|\"'(]\\s*)\\.\\s+\\S|(?:^|[;&|\"'(]\\s*)\\/[\\w.\\/-]+");
const INNER_READ = new Set(["cat", "tail", "head", "grep", "egrep", "zgrep", "rg", "ls", "df", "du", "free", "uptime", "ps", "pgrep", "whoami", "id", "hostname", "date", "wc", "stat", "echo", "printf", "true", "sleep", "uname", "nproc", "lsblk", "lscpu", "ss", "netstat", "nvidia-smi", "journalctl", "dmesg", "which", "getent", "vmstat", "iostat", "sort", "uniq", "cut", "tr", "jq", "column", "cd", "test", "["]);

const READ_WRITE_LONG = {
	journalctl: new Set(["--vacuum-size", "--vacuum-time", "--vacuum-files", "--rotate", "--flush", "--sync", "--relinquish-var", "--smart-relinquish-var", "--setup-keys", "--update-catalog", "--cursor-file"]),
	ss: new Set(["--kill", "--diag"]),
	sort: new Set(["--output", "--compress-program"]),
	rg: new Set(["--pre"]),
	date: new Set(["--set"]),
	hostname: new Set(["--file", "--boot"]),
	dmesg: new Set(["--clear", "--read-clear", "--console-off", "--console-on", "--console-level"]),
	"nvidia-smi": new Set(["--gpu-reset", "--persistence-mode", "--ecc-config", "--reset-ecc-errors", "--compute-mode", "--applications-clocks", "--power-limit", "--lock-gpu-clocks", "--multi-instance-gpu", "--filename", "--reset-gpu-clocks", "--lock-memory-clocks", "--reset-memory-clocks", "--reset-applications-clocks", "--applications-clocks-permission", "--driver-model", "--force-driver-model", "--gpu-operation-mode", "--gom", "--auto-boost-default", "--auto-boost-permission", "--accounting-mode", "--clear-accounted-apps"]),
};
const READ_WRITE_SHORT = {
	ss: new Set(["K", "D"]),
	sort: new Set(["o"]),
	date: new Set(["s"]),
	hostname: new Set(["F", "b"]),
	dmesg: new Set(["C", "c", "D", "E", "n"]),
};
const READ_WRITE_FULL = {
	"nvidia-smi": new Set(["r", "pm", "e", "p", "c", "dm", "fdm", "ac", "rac", "acp", "pl", "lgc", "rgc", "lmc", "rmc", "mig", "f"]),
};
const READ_SUBCOMMAND = {
	"nvidia-smi": new Set(["topo", "dmon", "pmon"]),
};
const READ_VALUE_SHORT = {
	"nvidia-smi": new Set(["d", "i", "l"]),
	date: new Set(["d", "r", "f"]),
	uniq: new Set(["f", "s", "w"]),
};
const READ_VALUE_LONG = {
	"nvidia-smi": new Set(["display", "id", "loop", "loop-ms", "format"]),
	date: new Set(["date", "reference", "file"]),
	uniq: new Set(["skip-fields", "skip-chars", "check-chars"]),
};
const READ_VALUE_PREFIX = {
	"nvidia-smi": ["query-"],
};
const READ_VALUE_FULL = {
	"nvidia-smi": new Set(["lms"]),
};

function readCommandWrites(cmd, rest) {
	const has = (t) => Object.prototype.hasOwnProperty.call(t, cmd);
	if (cmd !== "uniq" && !has(READ_WRITE_LONG) && !has(READ_WRITE_SHORT) && !has(READ_WRITE_FULL)
		&& !has(READ_VALUE_SHORT) && !has(READ_VALUE_LONG) && !has(READ_VALUE_FULL) && !has(READ_VALUE_PREFIX)) return false;
	const positionals = [];
	for (let k = 0; k < rest.length; k++) {
		const a = rest[k];
		if (a === "--") { for (let j = k + 1; j < rest.length; j++) positionals.push(rest[j]); break; }
		if (a.startsWith("--")) {
			const name = a.slice(2).split("=")[0];
			if (READ_WRITE_LONG[cmd] && READ_WRITE_LONG[cmd].has(`--${name}`)) return true;
			if ((READ_VALUE_LONG[cmd] && READ_VALUE_LONG[cmd].has(name))
				|| (READ_VALUE_PREFIX[cmd] && READ_VALUE_PREFIX[cmd].some((p) => name.startsWith(p)))) {
				if (!a.includes("=")) { const nxt = rest[k + 1]; if (nxt !== undefined && !nxt.startsWith("-")) k++; }
				continue;
			}
			continue;
		}
		if (a.startsWith("-") && a.length > 1) {
			const body = a.slice(1);
			if (READ_WRITE_SHORT[cmd] && [...body].some((ch) => READ_WRITE_SHORT[cmd].has(ch))) return true;
			if (READ_WRITE_FULL[cmd]) {
				const name = body.split("=")[0];
				if (READ_WRITE_FULL[cmd].has(name)) return true;
				if (name.length > 1 && READ_WRITE_FULL[cmd].has(name[0])) return true;
			}
			if (READ_VALUE_FULL[cmd] && READ_VALUE_FULL[cmd].has(body.split("=")[0])) continue;
			if (READ_VALUE_SHORT[cmd]) {
				let vpos = -1;
				for (let q = 0; q < body.length; q++) {
					if (body[q] === "=") break;
					if (READ_VALUE_SHORT[cmd].has(body[q])) { vpos = q; break; }
				}
				if (vpos >= 0 && (vpos === body.length - 1 || body[vpos + 1] === "=")) {
					if (vpos === body.length - 1) { const nxt = rest[k + 1]; if (nxt !== undefined && !nxt.startsWith("-")) k++; }
					continue;
				}
				if (vpos >= 0) continue;
			}
			continue;
		}
		positionals.push(a);
	}
	if (cmd === "date") return positionals.some((p) => !p.startsWith("+"));
	if (cmd === "hostname") return positionals.length > 0;
	if (cmd === "uniq") return positionals.length >= 2;
	if (cmd === "nvidia-smi") return positionals.some((p) => /^[A-Za-z]/.test(p) && !(READ_SUBCOMMAND[cmd] && READ_SUBCOMMAND[cmd].has(p)));
	return false;
}

const INNER_SYSTEMCTL = new Set(["status", "is-active", "is-enabled", "is-failed", "show", "list-units", "list-timers", "restart", "cat"]);
const INNER_DOCKER = new Set(["ps", "logs", "inspect", "stats", "images", "version", "info", "restart", "top"]);
const INNER_COMPOSE = new Set(["ps", "logs", "restart", "config", "images", "top", "ls"]);
const CURL_WRITE = /^(?:-d|--data(?:-\w+)?|-F|--form(?:-string)?|-T|--upload-file|-o|--output|-O|--remote-name(?:-all)?|--json)(?:=|$)/;

function innerClauseProblem(tokens0) {
	let t;
	for (let i = 0; i < tokens0.length; i++) {
		const x = tokens0[i];
		const m = x.match(/^(\d*)(>>?)(.*)$/);
		if (!m) continue;
		const target = m[3] || tokens0[i + 1] || "";
		if (m[3] === "" && i === tokens0.length - 1) continue;
		if (target !== "/dev/null" && !/^&\d$/.test(target)) return `파일에 씀: ${tokens0.join(" ")}`;
	}
	t = [];
	for (let i = 0; i < tokens0.length; i++) {
		const x = tokens0[i];
		const m = x.match(/^(\d*)(>>?)(.*)$/);
		if (m) { if (m[3] === "") i++; continue; }
		t.push(x);
	}
	const bare = stripReserved(t);
	if (bare === null) return null;
	t = bare;
	while (t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || t[0] === "sudo")) {
		if (t[0] === "sudo") { t = t.slice(1); while (t.length && t[0].startsWith("-")) t = t.slice(t[0] === "-u" ? 2 : 1); continue; }
		t = t.slice(1);
	}
	if (t.length === 0 || /^\d+$/.test(t.join(""))) return null;
	const cmd = path.basename(t[0]);
	const rest = t.slice(1);
	const positional = rest.filter((a) => !a.startsWith("-"));
	if (INNER_READ.has(cmd) && !readCommandWrites(cmd, rest)) return null;
	if (cmd === "sed" && !rest.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) return null;
	if (cmd === "systemctl" && INNER_SYSTEMCTL.has(positional[0])) return null;
	if (cmd === "docker" || cmd === "docker-compose") {
		if (cmd === "docker" && INNER_DOCKER.has(positional[0])) return null;
		if (cmd === "docker" && (positional[0] === "stop" || positional[0] === "start")) return null;
		if (cmd === "docker" && positional[0] === "update" && rest.includes("--restart=no") && rest.filter((a) => a.startsWith("-")).every((a) => a === "--restart=no")) return null;
		if (cmd === "docker" && positional[0] === "rename") {
			const after = rest.slice(rest.indexOf("rename") + 1);
			if (after.length === 2 && rest.every((a) => !a.startsWith("-")) && after.every((a) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(a))) return null;
		}
		if (cmd === "docker" && positional[0] === "exec") {
			const after = rest.slice(rest.indexOf("exec") + 1);
			let k = 0;
			while (k < after.length && after[k].startsWith("-")) k += /^(?:-u|--user|-e|--env|-w|--workdir|--env-file)$/.test(after[k]) ? 2 : 1;
			if (k + 1 < after.length) return innerClauseProblem(after.slice(k + 1));
		}
		const ci = cmd === "docker-compose" ? -1 : rest.indexOf("compose");
		if (cmd === "docker-compose" || positional[0] === "compose") {
			const after = rest.slice(ci + 1);
			let k = 0;
			while (k < after.length && after[k].startsWith("-")) k += /^(?:-f|--file|-p|--project-name|--env-file|--profile)$/.test(after[k]) ? 2 : 1;
			if (INNER_COMPOSE.has(after[k])) return null;
			if (after[k] === "exec") {
				let e = k + 1;
				while (e < after.length && after[e].startsWith("-")) e += /^(?:-u|--user|-e|--env|-w|--workdir|--index)$/.test(after[e]) ? 2 : 1;
				if (e + 1 < after.length) return innerClauseProblem(after.slice(e + 1));
			}
		}
	}
	if (cmd === "psql" || cmd === "mysql" || cmd === "mariadb" || cmd === "sqlite3") {
		const ci = rest.findIndex((a) => a === "-c" || a === "--command" || a === "-e" || a === "--execute");
		const sql = cmd === "sqlite3" ? positional[1] : ci >= 0 ? rest[ci + 1] : rest.find((a) => /^--(?:command|execute)=/.test(a))?.replace(/^--\w+=/, "");
		const stmts = String(sql || "").split(";").map((x) => x.trim()).filter(Boolean);
		if (stmts.length && stmts.every((x) => /^(?:select|show|explain|describe|\\d)/i.test(x) && !/\b(?:into|for\s+update)\b/i.test(x))) return null;
		return `DB 쓰기이거나 조회 문장이 명령에 드러나지 않음: ${t.join(" ")}`;
	}
	if (cmd === "alembic" && ["current", "history", "heads", "show", "branches"].includes(positional[0])) return null;
	if (SHELLS.test(cmd)) {
		const c = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
		if (c >= 0 && rest[c + 1] !== undefined) {
			const { shellClauses } = require("./git-command-parser.js");
			const clauses = shellClauses(rest[c + 1]);
			if (clauses.unbalanced) return `따옴표가 닫히지 않은 글: ${rest[c + 1].slice(0, 200)}`;
			for (const x of clauses) { const bad = innerClauseProblem(x); if (bad) return bad; }
			return null;
		}
	}
	if (cmd === "curl") {
		const xi = rest.findIndex((a) => a === "-X" || a === "--request" || /^(?:-X|--request=)./.test(a));
		const method = xi < 0 ? "GET" : (rest[xi].replace(/^(?:-X|--request=?)/, "") || rest[xi + 1] || "").toUpperCase();
		if (!["GET", "HEAD"].includes(method)) return `HTTP ${method}: ${t.join(" ")}`;
		if (rest.some((a) => CURL_WRITE.test(a))) return `HTTP 쓰기·파일 받기: ${t.join(" ")}`;
		return null;
	}
	return t.join(" ");
}

function opsClauses(command) {
	const { shellClauses } = require("./git-command-parser.js");
	const out = [];
	for (let raw of shellClauses(String(command))) {
		while (raw.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[0]) || path.basename(raw[0]) === "sudo")) {
			if (path.basename(raw[0]) === "sudo") { raw = raw.slice(1); while (raw[0]?.startsWith("-")) raw = raw.slice(["-u", "-g", "--user", "--group"].includes(raw[0]) ? 2 : 1); }
			else raw = raw.slice(1);
		}
		if (SHELLS.test(raw[0] || "") && raw[1] === "-c" && raw.length === 3) out.push(...opsClauses(raw[2]));
		else out.push(raw.flatMap((x) => /^--[a-z][\w-]*=/.test(x) ? [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] : [x]));
	}
	return out;
}

function remotePayload(tokens) {
	const cmd = path.basename(tokens[0] || "");
	if (cmd === "az" && tokens[1] === "vm" && tokens[2] === "run-command") {
		if (!["invoke", "create", "update"].includes(tokens[3])) return null;
		if (tokens.filter((x) => x === "--scripts" || x === "--script").length !== 1) return null;
		const k = tokens.findIndex((x) => x === "--scripts" || x === "--script");
		const found = [];
		if (k >= 0) for (let i = k + 1; i < tokens.length && !tokens[i].startsWith("--"); i++) found.push(tokens[i]);
		return found.length ? found.join("\n") : null;
	}
	if (cmd === "az" && tokens[1] === "containerapp" && tokens[2] === "exec") {
		if (tokens.filter((x) => x === "--command").length !== 1) return null;
		const k = tokens.indexOf("--command");
		return k >= 0 && tokens[k + 1] ? tokens[k + 1] : null;
	}
	if (cmd === "ssh") {
		let i = 1;
		while (i < tokens.length && tokens[i].startsWith("-")) i += /^-[ioplJFLRDEWbcemQSw]$/.test(tokens[i]) ? 2 : 1;
		const remote = tokens.slice(i + 1);
		return remote.length ? remote.join(" ") : null;
	}
	return undefined;
}

function innerScripts(command) {
	return opsClauses(command).map(remotePayload).filter((x) => x !== undefined);
}

/** 안에서 도는 글이 허용 부류 밖이면 그 절, 아니면 null. */
function innerProblem(command) {
	const { shellClauses } = require("./git-command-parser.js");
	for (const script of innerScripts(command)) {
		if (script === null) return "VM·컨테이너 안에서 도는 글을 명령에서 찾지 못함(--scripts·--script·--command 값이나 ssh 원격 명령)";
		const clauses = shellClauses(script);
		if (clauses.unbalanced) return `따옴표가 닫히지 않은 글: ${script.slice(0, 200)}`;
		for (const clause of clauses) {
			const bad = innerClauseProblem(clause);
			if (bad) return bad;
		}
	}
	return null;
}

const OPS_AZ_VERBS = [
	/^(?:containerapp|webapp|functionapp) update$/,
	/^(?:containerapp|webapp|functionapp|vm|vmss) (?:restart|stop|start)$/,
	/^containerapp revision (?:restart|deactivate|label (?:add|remove|swap))$/,
	/^containerapp secret (?:set|remove)$/,
	/^containerapp ingress (?:enable|disable|access-restriction (?:set|remove)|sticky-sessions set|cors (?:enable|disable|update))$/,
	/^(?:webapp|functionapp) config appsettings (?:set|delete)$/,
	/^vmss scale$/,
	/^vm deallocate$/,
	/^disk update$/,
	/^snapshot create$/,
	/^(?:vm|disk|snapshot) delete$/,
	/^network (?:nic|public-ip|nsg) delete$/,
	/^mysql flexible-server delete$/,
];
const OPS_AZ_VERB_FLAGS = { "disk update": new Set(["--size-gb"]), "snapshot create": new Set(["--source", "--incremental", "--sku"]) };
const OPS_AZ_FLAGS = new Set(["-n", "--name", "-g", "--resource-group", "--subscription", "--ids", "-o", "--output", "--query", "--only-show-errors", "--no-wait", "-y", "--yes",
	"--set-env-vars", "--remove-env-vars", "--replace-env-vars", "--remove-all-env-vars", "--min-replicas", "--max-replicas", "--cpu", "--memory",
	"--revision", "--label", "--source-label", "--target-label", "--secrets", "--secret-names", "--settings", "--setting-names", "--new-capacity",
	"--type", "--allow-insecure", "--transport", "--target-port", "--exposed-port", "--rule-name", "--ip-address", "--action", "--description", "--affinity", "--allowed-origins"]);

function opsAzProblem(command) {
	for (const tokens of opsClauses(command)) {
		const at = tokens.findIndex((t) => /(?:^|\/)az$/.test(t));
		if (at < 0) continue;
		const verbs = [];
		let i = at + 1;
		for (; i < tokens.length && !tokens[i].startsWith("-"); i++) verbs.push(tokens[i]);
		const phrase = verbs.join(" ");
		if (/(?:^| )(?:show|list|logs?|browse|tail|get|wait)(?: |$)|(?:^| )(?:list|show)-/.test(phrase)) continue;
		if (remotePayload(tokens) !== undefined) {
			const script = remotePayload(tokens);
			if (script === null) return "원격 실행 본문 또는 지원하는 원격 동사가 없음";
			if (INNER_OPAQUE.test(script)) return "원격 실행 본문이 불투명함";
			const bad = innerProblem(require("./deploy-command-classifier.js").clauseText(tokens));
			if (bad) return `원격 실행에서 허용하지 않는 명령: ${bad}`;
			continue;
		}
		if (!OPS_AZ_VERBS.some((re) => re.test(phrase))) return `ops 로 받을 수 없는 az 명령: az ${phrase}. 설정 변경(환경 변수, 복제 수, 재시작, 리비전 끄기, 비밀 값, 앱 설정)만 ops 이고, 코드나 판을 올리는 명령은 feature 나 rollback 으로 신고함`;
		for (; i < tokens.length; i++) {
			const t = tokens[i];
			if (!t.startsWith("-")) continue;
			const flag = t.split("=")[0];
			if (!OPS_AZ_FLAGS.has(flag) && !OPS_AZ_VERB_FLAGS[phrase]?.has(flag)) return `ops 로 받을 수 없는 옵션: az ${phrase} ${flag}. 설정만 바꾸는 옵션이 아니면 feature 나 rollback 으로 신고함`;
		}
	}
	return null;
}

function opsProblem(command, opts = null) {
	if (VERSION_CHANGE.test(command)) return "이미지·리비전·트래픽을 바꾸는 명령은 ops 로 신고할 수 없음";
	const rawCmd = opts?.readOnlyTarget?.sanitizedAzCommand || command;
	if (opts?.readOnlyTarget && String(command).replace(/\s+/g, " ").length > 1500) return "VM·컨테이너 안에서 도는 글이 1500자를 넘음";
	if (opts?.readOnlyTarget?.mode === "shell") return null;
	const scripts = innerScripts(rawCmd);
	if (scripts.length && scripts.some((x) => x !== null && INNER_OPAQUE.test(x))) return "VM·컨테이너 안에서 도는 글이 명령에 그대로 있지 않음(불투명함)";
	const inner = innerProblem(rawCmd);
	if (inner) return `VM·컨테이너 안에서 조회·진단·재시작이 아닌 명령(코드를 올리는 명령, 파일·DB·API 쓰기 등): ${inner}`;
	const az = opsAzProblem(rawCmd);
	if (az) return az;
	if (scripts.length && String(command).replace(/\s+/g, " ").length > 1500) return "VM·컨테이너 안에서 도는 글이 1500자를 넘음";
	if (!scripts.length && !CONFIG_ONLY.test(rawCmd)) return "ops 는 설정만 바꾸는 명령에만 쓸 수 있음";
	return null;
}

const sameCommit = (a, b) => typeof a === "string" && typeof b === "string" && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function sha256File(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function resolveIn(root, p) {
	if (typeof p !== "string" || !p) throw new Error(`경로 칸이 문자열 경로가 아님: ${JSON.stringify(p)}`.slice(0, 160));
	return path.isAbsolute(p) ? p : path.join(root, p);
}

// ── 인스턴스 확장 설정(config/deploy-gate.json + 선택 플러그인) ──────────────
function probePathError(target) {
	try {
		fs.lstatSync(target);
		return { exists: true, error: null };
	} catch (err) {
		if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return { exists: false, error: null };
		return { exists: false, error: err && (err.code || err.message) ? `${err.code || err.message}` : String(err) };
	}
}

/**
 * 대상 경로를 realpath(심볼릭 링크·.. 해소)로 풀고, 파일이 없으면 글자 정규화 + 존재하는 최하위 상위 realpath 로 정규화한다.
 */
function tryCanonicalTargetPath(rawPath, baseDir = "/") {
	if (typeof rawPath !== "string") return { path: "", error: null };
	const trimmed = rawPath.trim();
	if (!trimmed) return { path: "", error: null };
	if (trimmed.includes("\0")) return { path: "", error: "EINVAL" };
	let expanded = trimmed;
	if (expanded === "~" || expanded.startsWith("~/")) {
		const home = require("os").homedir();
		expanded = expanded === "~" ? home : path.join(home, expanded.slice(2));
	}
	const resolvedBase = path.resolve(baseDir || "/");
	const rawAbs = path.isAbsolute(expanded) ? expanded : path.join(resolvedBase, expanded);
	try {
		return { path: fs.realpathSync(rawAbs), error: null };
	} catch (err) {
		if (err && err.code !== "ENOENT" && err.code !== "ENOTDIR") {
			return { path: path.resolve(resolvedBase, expanded), error: err.code || err.message || String(err) };
		}
	}
	const normAbs = path.resolve(resolvedBase, expanded);
	try {
		return { path: fs.realpathSync(normAbs), error: null };
	} catch (err) {
		if (err && err.code !== "ENOENT" && err.code !== "ENOTDIR") {
			return { path: normAbs, error: err.code || err.message || String(err) };
		}
	}
	let anc = path.dirname(normAbs);
	for (;;) {
		try {
			const realAnc = fs.realpathSync(anc);
			const rel = path.relative(anc, normAbs);
			return { path: rel ? path.join(realAnc, rel) : realAnc, error: null };
		} catch (err) {
			if (err && err.code !== "ENOENT" && err.code !== "ENOTDIR") {
				return { path: normAbs, error: err.code || err.message || String(err) };
			}
		}
		const parent = path.dirname(anc);
		if (parent === anc) break;
		anc = parent;
	}
	return { path: normAbs, error: null };
}

function canonicalTargetPath(rawPath, baseDir = "/") {
	return tryCanonicalTargetPath(rawPath, baseDir).path;
}

function hasDeployPlanMarker(root) {
	if (!root) return { present: false, error: null };
	const agentsDir = path.join(root, ".agents");
	const aProbe = probePathError(agentsDir);
	if (aProbe.error || !aProbe.exists) return { present: false, error: null };
	const progressDir = path.join(agentsDir, "progress");
	const pProbe = probePathError(progressDir);
	if (pProbe.error) return { present: false, error: pProbe.error };
	if (!pProbe.exists) return { present: false, error: null };
	let entries;
	try {
		entries = fs.readdirSync(progressDir, { withFileTypes: true });
	} catch (err) {
		return { present: false, error: err && (err.code || err.message) ? `${err.code || err.message}` : String(err) };
	}
	for (const d of entries) {
		if ((!d.isDirectory() && !d.isSymbolicLink()) || d.name.startsWith("_")) continue;
		const gatesDir = path.join(progressDir, d.name, "gates");
		const gProbe = probePathError(gatesDir);
		if (gProbe.error) return { present: false, error: gProbe.error };
		if (!gProbe.exists) continue;
		const planProbe = probePathError(path.join(gatesDir, "deploy-plan.json"));
		if (planProbe.exists || planProbe.error) return { present: true, error: planProbe.error };
	}
	return { present: false, error: null };
}

/**
 * 실행하려는 대본·파일·작업 폴더의 정규화 경로에서 위로 올라가 해당 저장소의 배포 정책 루트를 찾는다.
 */
function findPolicyRootForPath(targetPath) {
	const resolved = tryCanonicalTargetPath(targetPath, "/");
	if (!resolved.path) return null;
	let cur = resolved.path;
	try {
		if (!fs.statSync(cur).isDirectory()) cur = path.dirname(cur);
	} catch {
		cur = path.dirname(cur);
	}
	for (;;) {
		const dirProbe = probePathError(cur);
		if (dirProbe.exists && !dirProbe.error) {
			const cfgDirProbe = probePathError(path.join(cur, "config"));
			const cfgProbe = cfgDirProbe.exists ? probePathError(path.join(cur, "config", "deploy-gate.json")) : { exists: false, error: null };
			const planMarker = hasDeployPlanMarker(cur);
			const agentsDirProbe = probePathError(path.join(cur, ".agents"));
			const scriptsDirProbe = agentsDirProbe.exists ? probePathError(path.join(cur, ".agents", "scripts")) : { exists: false };
			const scriptProbe = scriptsDirProbe.exists ? probePathError(path.join(cur, ".agents", "scripts", "approval-plan.mjs")) : { exists: false, error: null };
			const claudeDirProbe = probePathError(path.join(cur, ".claude"));
			const claudeDeployProbe = claudeDirProbe.exists ? probePathError(path.join(cur, ".claude", "deploy")) : { exists: false };
			const legacyCfgProbe = claudeDeployProbe.exists ? probePathError(path.join(cur, ".claude", "deploy", "config.json")) : { exists: false, error: null };
			const legacyAppProbe = claudeDeployProbe.exists ? probePathError(path.join(cur, ".claude", "deploy", "approvals.json")) : { exists: false, error: null };
			if (
				cfgProbe.exists || cfgProbe.error ||
				planMarker.present || planMarker.error ||
				scriptProbe.exists || scriptProbe.error ||
				legacyCfgProbe.exists || legacyCfgProbe.error ||
				legacyAppProbe.exists || legacyAppProbe.error
			) {
				return cur;
			}
			const gitProbe = probePathError(path.join(cur, ".git"));
			if (gitProbe.exists) return null;
		}
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return null;
}

function checkJsonObjectFile(filePath, label) {
	const p = probePathError(filePath);
	if (p.error) return `정책 파일(${label}) 접근 실패: ${p.error}`;
	if (!p.exists) return null;
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return `정책 파일(${label}) 형식이 올바른 JSON 객체가 아님`;
		}
		return null;
	} catch (err) {
		return `정책 파일(${label}) 읽기 또는 파싱 실패: ${err && err.message ? err.message : String(err)}`;
	}
}

/**
 * 저장소 루트와 deployDir 에서 찾은 정책 파일이 읽기·파싱 불가인지 검사한다(찾았는데 못 읽으면 차단).
 */
function inspectDeployPolicyErrors(root, opts = {}) {
	const errors = [];
	const pushErr = (msg) => {
		if (msg && !errors.includes(msg)) errors.push(msg);
	};
	if (root) {
		const cfgDirProbe = probePathError(path.join(root, "config"));
		if (cfgDirProbe.error) pushErr(`정책 디렉터리(config) 접근 실패: ${cfgDirProbe.error}`);
		pushErr(checkJsonObjectFile(path.join(root, "config", "deploy-gate.json"), "config/deploy-gate.json"));
		if (opts.checkDeployGateEnv && process.env.DEPLOY_GATE_CONFIG) {
			pushErr(checkJsonObjectFile(path.resolve(process.env.DEPLOY_GATE_CONFIG), "DEPLOY_GATE_CONFIG"));
		}
		const progressDir = path.join(root, ".agents", "progress");
		const pProbe = probePathError(progressDir);
		if (pProbe.error) {
			pushErr(`정책 디렉터리(.agents/progress) 접근 실패: ${pProbe.error}`);
		} else if (pProbe.exists) {
			try {
				const entries = fs.readdirSync(progressDir, { withFileTypes: true });
				for (const d of entries) {
					if ((!d.isDirectory() && !d.isSymbolicLink()) || d.name.startsWith("_")) continue;
					const gatesDir = path.join(progressDir, d.name, "gates");
					const gProbe = probePathError(gatesDir);
					if (gProbe.error) {
						pushErr(`정책 디렉터리(.agents/progress/${d.name}/gates) 접근 실패: ${gProbe.error}`);
						continue;
					}
					if (!gProbe.exists) continue;
					pushErr(checkJsonObjectFile(path.join(gatesDir, "deploy-plan.json"), `.agents/progress/${d.name}/gates/deploy-plan.json`));
				}
			} catch (err) {
				pushErr(`정책 디렉터리(.agents/progress) 읽기 실패: ${err && err.message ? err.message : String(err)}`);
			}
		}
		const localDeployDir = path.join(root, ".claude", "deploy");
		const ldProbe = probePathError(localDeployDir);
		if (ldProbe.error) {
			pushErr(`정책 디렉터리(.claude/deploy) 접근 실패: ${ldProbe.error}`);
		} else if (ldProbe.exists) {
			pushErr(checkJsonObjectFile(path.join(localDeployDir, "config.json"), ".claude/deploy/config.json"));
			pushErr(checkJsonObjectFile(path.join(localDeployDir, "approvals.json"), ".claude/deploy/approvals.json"));
		}
	}
	if (opts.deployDir) {
		const ddProbe = probePathError(opts.deployDir);
		if (ddProbe.error) {
			pushErr(`정책 디렉터리(.claude/deploy) 접근 실패: ${ddProbe.error}`);
		} else if (ddProbe.exists) {
			pushErr(checkJsonObjectFile(path.join(opts.deployDir, "config.json"), ".claude/deploy/config.json"));
			pushErr(checkJsonObjectFile(path.join(opts.deployDir, "approvals.json"), ".claude/deploy/approvals.json"));
		}
	}
	return { errors };
}

function deployGateConfigPath(root) {
	if (process.env.DEPLOY_GATE_CONFIG) return path.resolve(process.env.DEPLOY_GATE_CONFIG);
	const base = root || process.env.DEPLOY_READINESS_ROOT || path.resolve(__dirname, "../../..");
	return path.join(base, "config", "deploy-gate.json");
}

function loadDeployGateConfig(root) {
	const file = deployGateConfigPath(root);
	if (!fs.existsSync(file)) return null;
	return readJson(file);
}

function loadDeployGatePlugin(root, cfg) {
	const config = cfg || loadDeployGateConfig(root);
	if (!config || typeof config.plugin !== "string" || !config.plugin.trim()) return null;
	const base = root || process.env.DEPLOY_READINESS_ROOT || path.resolve(__dirname, "../../..");
	const pluginPath = path.isAbsolute(config.plugin) ? config.plugin : path.resolve(base, config.plugin);
	if (!fs.existsSync(pluginPath)) throw new Error(`config/deploy-gate.json 의 plugin 모듈을 찾지 못함: ${config.plugin}`);
	return require(pluginPath);
}

function globMatch(pattern, value) {
	const pat = String(pattern || "").trim();
	const val = String(value || "").trim();
	if (!pat) return false;
	if (pat === "*" || pat === val) return true;
	const escaped = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i").test(val);
}

function matchServiceRule(service, cfg) {
	if (!cfg || !cfg.services) return null;
	if (Array.isArray(cfg.services)) {
		for (const item of cfg.services) {
			if (typeof item === "string" && globMatch(item, service)) return { registered: true, pattern: item };
			if (item && typeof item === "object" && typeof item.service === "string" && globMatch(item.service, service)) {
				return { registered: true, pattern: item.service, ...item };
			}
		}
		return null;
	}
	if (typeof cfg.services === "object") {
		for (const [pattern, rule] of Object.entries(cfg.services)) {
			if (!rule) continue;
			if (globMatch(pattern, service)) {
				return { registered: true, pattern, ...(typeof rule === "object" ? rule : {}) };
			}
		}
	}
	return null;
}

/** 서비스 전부를 담은, 12시간 안의 가장 새 기록. */
function findReadiness(services, root, now = Date.now()) {
	const base = path.join(root, ".agents", "progress");
	let dirs = [];
	try {
		dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_"));
	} catch {
		return null;
	}
	let best = null;
	for (const d of dirs) {
		const file = path.join(base, d.name, "gates", "deploy.json");
		const rec = readJson(file);
		if (!rec || !Array.isArray(rec.services)) continue;
		if (!services.every((s) => rec.services.includes(s))) continue;
		const at = Date.parse(rec.createdAt || "");
		if (!Number.isFinite(at) || now - at > MAX_AGE_MS || at - now > 5 * 60 * 1000) continue;
		if (!best || at > best.at) best = { at, file, record: rec };
	}
	return best;
}

function defectFile(service, root) {
	return path.join(root, ".agents", "progress", "_service-defects", `${service.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
}

function defectFact(service, root, open) {
	if (!fs.existsSync(defectFile(service, root))) return `${service} 열린 치명 결함: 확인 안 됨(결함 목록 ${path.relative(root, defectFile(service, root))} 없음. 알려진 결함이 기록되지 않았을 수 있음)`;
	return `${service} 열린 치명 결함: ${open.length}건${open.length ? ` (${open.map((d) => d.id).join(", ")})` : ""}`;
}

function openCriticalDefects(service, root) {
	const safe = service.replace(/[^A-Za-z0-9._-]+/g, "_");
	const rec = readJson(path.join(root, ".agents", "progress", "_service-defects", `${safe}.json`));
	const list = rec && Array.isArray(rec.defects) ? rec.defects : [];
	return list.filter((d) => d && d.severity === "critical" && d.status !== "closed");
}

function defectVersions(d) {
	const out = [];
	for (const k of ["candidate", "candidates", "affects", "version", "versions", "image", "commit"]) {
		const v = d[k];
		for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && x.trim()) out.push(x.trim());
	}
	return out;
}

function git(repo, args) {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000, maxBuffer: 8 << 20 });
}

function checkCodeGate(file, candidate, now) {
	const problems = [];
	const g = readJson(file);
	if (!g) return { problems: [`코드 검수 기록을 읽지 못함: ${file}`] };
	if (g.stage !== "code") problems.push("코드 검수 기록의 stage 가 code 가 아님");
	if (g.verdict !== "pass") problems.push("코드 검수 기록의 verdict 가 pass 가 아님");
	const a = g.author || {};
	const r = g.reviewer || {};
	if (!a.session || !r.session || a.session === r.session) problems.push("코드 작성자와 검수자의 세션이 같거나 비어 있음");
	const targets = Array.isArray(g.targets) ? g.targets : [];
	if (!targets.some((t) => t && typeof t.commit === "string" && t.commit.length >= 7 && (candidate.startsWith(t.commit) || t.commit.startsWith(candidate)))) problems.push(`코드 검수 기록의 targets 에 후보 ${candidate} 가 없음`);
	const tools = Array.isArray(g.tools) ? g.tools : [];
	const ui = tools.find((t) => t && t.name === "ui-copy-lint");
	if (!ui) problems.push("코드 검수 기록에 화면 문구 검사(ui-copy-lint) 출력이 없음");
	else {
		const out = resolveIn(path.dirname(file), ui.path || "");
		if (!ui.path || !fs.existsSync(out)) problems.push(`화면 문구 검사 출력 파일이 없음: ${ui.path}`);
		else {
			if (ui.sha256 !== sha256File(out)) problems.push("화면 문구 검사 출력의 sha256 이 기록과 다름");
			if (now - fs.statSync(out).mtimeMs > TOOL_MAX_AGE_MS) problems.push("화면 문구 검사 출력이 24시간보다 오래됨");
			const lint = readJson(out);
			if (!lint || !lint.summary || !sameCommit(lint.summary.commit, candidate)) problems.push(`화면 문구 검사가 후보 ${candidate} 를 검사한 출력이 아님(ui-copy-lint.mjs --ref ${candidate} --json 으로 다시 돌릴 것)`);
		}
	}
	let lintSummary = null;
	if (ui && ui.path) {
		const lint = readJson(resolveIn(path.dirname(file), ui.path));
		if (lint && lint.summary) lintSummary = lint.summary;
	}
	return { problems, reviewer: `${r.model || "?"} ${r.session || "?"}`, lintSummary };
}

function checkTestGate(file, candidate) {
	const problems = [];
	const g = readJson(file);
	if (!g) return [`시험 검수 기록을 읽지 못함: ${file}`];
	if (g.stage !== "test") problems.push("시험 검수 기록의 stage 가 test 가 아님");
	if (g.verdict !== "pass") problems.push("시험 검수 기록의 verdict 가 pass 가 아님");
	const a = g.author || {};
	const r = g.reviewer || {};
	if (!a.session || !r.session || a.session === r.session) problems.push("ET 를 돌린 세션과 시험 검수자 세션이 같거나 비어 있음");
	const targets = Array.isArray(g.targets) ? g.targets : [];
	if (!targets.some((t) => t && sameCommit(String(t.commit || ""), candidate))) problems.push(`시험 검수 기록의 targets 에 후보 ${candidate} 가 없음`);
	return problems;
}

function lastExecutedFor(service, auditPath) {
	let raw = "";
	try {
		raw = fs.readFileSync(auditPath, "utf8");
	} catch {
		return null;
	}
	let last = null;
	for (const line of raw.split("\n")) {
		if (!line.includes(service)) continue;
		try {
			const e = JSON.parse(line);
			if (e.event === "executed" && Array.isArray(e.services) && e.services.includes(service)) last = e;
		} catch {}
	}
	return last;
}

function executedBefore(candidate, auditPath) {
	let raw = "";
	try {
		raw = fs.readFileSync(auditPath, "utf8");
	} catch {
		return false;
	}
	for (const line of raw.split("\n")) {
		if (!line.includes(candidate)) continue;
		try {
			const e = JSON.parse(line);
			if (e.event === "executed" && String(e.command || "").includes(candidate)) return true;
		} catch {}
	}
	return false;
}

/** 기록을 실제로 실행하는 명령에 묶는다. */
function commandBinding(command, candidate, services, cwd) {
	const repos = [];
	for (const s of services) {
		if (s.startsWith("script:")) repos.push(path.dirname(s.slice("script:".length)));
		else if (s.startsWith("package:")) repos.push(s.slice("package:".length).split(":")[0]);
	}
	if (repos.length === 0) return { ok: false, why: "명령에 후보가 포함돼 있어도 계획·이미지·고정 본문의 강한 결합 없이는 허용하지 않음" };
	for (const dir0 of repos) {
		const dir = resolveIn(cwd, dir0 || ".");
		let head = "";
		let dirty = "";
		try {
			head = git(dir, ["rev-parse", "HEAD"]).trim();
			dirty = git(dir, ["status", "--porcelain", "--untracked-files=no"]).trim();
		} catch {
			return { ok: false, why: `배포 스크립트가 든 저장소를 읽지 못함: ${dir}` };
		}
		if (!sameCommit(head, candidate)) return { ok: false, why: `배포 스크립트 저장소 HEAD ${head.slice(0, 12)} 가 후보 ${candidate} 와 다름: ${dir}` };
		if (dirty) return { ok: false, why: `배포 스크립트 저장소에 커밋 안 된 변경이 있음(검수되지 않은 코드가 함께 올라감): ${dir}\n${dirty.split("\n").slice(0, 10).join("\n")}` };
	}
	const hexRuns = [...String(command).matchAll(/[0-9a-f]{7,40}/gi)].map((m) => m[0].toLowerCase());
	const marks = hexRuns.filter((h) => sameCommit(h, candidate.toLowerCase()) || (/[0-9]/.test(h) && /[a-f]/.test(h)));
	const foreign = marks.filter((h) => !sameCommit(h, candidate.toLowerCase()));
	if (foreign.length) return { ok: false, why: `명령에 후보 ${candidate} 와 다른 판 표시가 있음: ${[...new Set(foreign)].join(", ")}. 올릴 판이 후보와 같아야 함(옛 판이면 rollback 으로 신고)` };
	const skipBuild = /\b[A-Z0-9_]*(?:SKIP|NO)_?BUILD[A-Z0-9_]*=(?!0\b|false\b|no\b)\S|--(?:skip|no)-build\b/i.test(String(command));
	if (skipBuild && !marks.length) return { ok: false, why: `빌드를 건너뛰는 배포는 올라갈 이미지를 명령에서 확인할 수 있어야 함. 태그에 후보 커밋 ${candidate.slice(0, 8)} 를 넣거나 빌드를 건너뛰지 말 것` };
	return { ok: true, fact: "배포 스크립트 저장소 HEAD 가 후보와 같고 커밋 안 된 변경이 없음" };
}

// 계획 고정 대본 호출(`[sudo …]bash /<대본> …`). 대본 본문은 분류기가 다 읽을 수 없으므로 ops 로 받지 않는다(적대 리뷰 B1).
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
	const { validateReadOnlyScriptsConfig, verifyRepoFileGitClean } = require("./deploy-plan.js");
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
	let reviewRec;
	try {
		reviewRec = JSON.parse(fs.readFileSync(path.join(gatesDir, "deploy-plan-review.json"), "utf8"));
	} catch {
		return null;
	}
	if (!reviewRec || !Array.isArray(reviewRec.read_only_scripts)) return null;
	for (const s of services) {
		const item = matched.find((m) => m.service === s);
		if (!item) return null;
		const bound = reviewRec.read_only_scripts.some((r) =>
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
function verifiedPlanBinding(planBinding, candidate, kind, services, rootDir) {
	const no = (why) => ({ ok: false, why: `계획 결합 거부: ${why}` });
	const yes = (fact, ops = false, extra = null) => ({ ok: true, fact, ops, ...(extra || {}) });
	if (!Array.isArray(services) || services.length === 0) return no("운영 서비스 집합이 비어 있음");
	if (!planBinding || !planBinding.plan || !planBinding.entry || typeof planBinding.command !== "string") return no("계획·단계·명령 문맥이 없음");
	const { plan, entry, command, cwd = "" } = planBinding;
	const root = rootDir || process.env.DEPLOY_READINESS_ROOT || cwd || path.resolve(__dirname, "../../..");
	const plannedServices = Array.isArray(plan.services) ? plan.services : [];
	if (services.some((s) => !plannedServices.includes(s))) return no("명령이 바꾸는 서비스가 계획서 services 에 없음");
	if (!(entry.commands || []).includes(command)) return no("실행 명령 바이트가 승인된 단계 명령과 다름");

	const files = new Map();
	const fileHashes = new Map();
	const { verifyTargetPreconditions } = require("./deploy-plan.js");
	let targets;
	try { targets = verifyTargetPreconditions(plan, root, entry); }
	catch (e) { return no(`대상 파일 검사 실패: ${e.message}`); }
	for (const [p, want] of Object.entries(entry.files || {})) {
		if (!/^[a-f0-9]{64}$/i.test(String(want))) return no(`고정 파일 sha256 형식이 아님: ${p}`);
		const full = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root || cwd || ".", p);
		let body;
		try {
			if (!fs.statSync(full).isFile()) return no(`고정 파일이 일반 파일이 아님: ${p}`);
			body = fs.readFileSync(full);
		} catch {
			return no(`고정 파일을 읽지 못함: ${p}`);
		}
		const actualSha = crypto.createHash("sha256").update(body).digest("hex");
		if (actualSha !== String(want).toLowerCase()) return no(`고정 파일 sha256 불일치: ${p}`);
		files.set(full, body.toString("utf8"));
		fileHashes.set(full, actualSha);
	}
	const cfg = loadDeployGateConfig(root);
	if (cfg) {
		const { validateReadOnlyScriptsConfig } = require("./deploy-plan.js");
		const roCfg = validateReadOnlyScriptsConfig(cfg);
		if (!roCfg.ok) return no(roCfg.why);
	}
	let plugin = null;
	if (cfg) {
		try {
			plugin = loadDeployGatePlugin(root, cfg);
		} catch (e) {
			return no(e && e.message ? e.message : String(e));
		}
	}

	if (plugin && typeof plugin.verifyPlanBinding === "function") {
		const pluginRes = plugin.verifyPlanBinding({ plan, entry, command, candidate, kind, services, cwd, root, config: cfg, files });
		if (pluginRes && pluginRes.ok === false) {
			return no(pluginRes.why || pluginRes.problem || "인스턴스 플러그인 결합 거부");
		}
		if (pluginRes && pluginRes.ok === true) {
			return { ok: true, fact: pluginRes.fact || "인스턴스 플러그인 결합 확인", ops: !!pluginRes.ops, opsCommand: pluginRes.opsCommand };
		}
	}

	if (!cfg) {
		return no(`알 수 없는 운영 명령은 막음: config/deploy-gate.json 설정 파일이 없습니다 (${services.join(", ")})`);
	}

	const rules = [];
	const unregistered = [];
	const pluginFacts = [];
	for (const s of services) {
		if (plugin && typeof plugin.assessService === "function") {
			const res = plugin.assessService(s, { plan, entry, command, candidate, kind, services, cwd, root, config: cfg, files });
			if (res && res.ok === false) {
				const why = (Array.isArray(res.problems) && res.problems[0]) || res.why || res.problem || `인스턴스 플러그인 결합 거부(${s})`;
				return no(why);
			}
			if (res && res.ok === true) {
				if (Array.isArray(res.facts)) pluginFacts.push(...res.facts);
				else if (res.fact) pluginFacts.push(res.fact);
				rules.push({ service: s, allowCustomCommands: true });
				continue;
			}
		}
		const rule = matchServiceRule(s, cfg);
		if (!rule) unregistered.push(s);
		else rules.push({ service: s, ...rule });
	}
	if (unregistered.length > 0) {
		return no(`알 수 없는 운영 명령은 막음: config/deploy-gate.json 의 services 에 등록되지 않은 운영 서비스(${unregistered.join(", ")})`);
	}
	if (pluginFacts.length > 0 && kind === "plan") {
		return yes(pluginFacts.join("; "));
	}

	for (const rule of rules) {
		if (Array.isArray(rule.allowedCommands) && rule.allowedCommands.length > 0) {
			const matched = rule.allowedCommands.some((pat) => new RegExp(pat).test(command));
			if (!matched) return no(`서비스(${rule.service}) 결합 규칙 allowedCommands 에 맞지 않는 명령`);
		}
		if (Array.isArray(rule.requiredFiles) && rule.requiredFiles.length > 0) {
			for (const reqFile of rule.requiredFiles) {
				const absReq = path.isAbsolute(reqFile) ? path.resolve(reqFile) : path.resolve(root || cwd || ".", reqFile);
				if (!files.has(absReq)) return no(`서비스(${rule.service}) 결합 규칙상 필수 고정 파일 누락: ${reqFile}`);
			}
		}
	}

	const { shellClauses } = require("./git-command-parser.js");
	const clauses = shellClauses(command);
	if (clauses.unbalanced || clauses.length === 0) return no("명령 절 파싱 실패");
	const c = clauses[0];
	const sameServices = (actual) => actual.length === services.length && services.every((s) => actual.includes(s));

	if (kind === "ops" && ![...targets.keys()].some(file => files.has(file))) {
		const ro = matchReadOnlyScriptBinding({ cfg, root, command, clauses, files, fileHashes, services, cwd, planBinding });
		if (ro) return ro.ok ? ro : no(ro.why);
	}

	if (kind === "ops" && clauses.length === 1 && c.length === 2 && c[0] === "bash" && files.size === 1 && files.has(path.resolve(cwd || root || ".", c[1]))) {
		const body = files.get(path.resolve(cwd || root || ".", c[1]));
		const bare = body.replace(/^#![^\n]*\n/, "").trim();
		const inner = shellClauses(bare);
		if (!/[$`\\#<>|&;]/.test(bare) && inner.length === 1 && inner[0][0] === "az" && !opsProblem(bare)) {
			const { classifyProdMutations, isNonProd } = require("./deploy-command-classifier.js");
			const targets = [...new Set(classifyProdMutations(bare, cwd, 0, false, root).filter((h) => !isNonProd(h.service)).map((h) => h.service))];
			if (targets.length && sameServices(targets)) return { ...yes("고정 파일의 단일 설정 절 전체·서비스·안전 동사 대조"), opsCommand: bare };
		}
	}
	if (kind === "ops" && clauses.length === 1 && c.length === 3 && c[0] === "bash" && c[1] === "-c" && !files.size && !/[$`]/.test(c[2])) {
		const inner = shellClauses(c[2]);
		if (inner.length === 1 && inner[0][0] === "az" && !opsProblem(c[2])) return yes("계획 고정 인라인 Azure 명령 — 안쪽 안전 검사 필요");
	}
	if (kind !== "ops" && kind !== "plan" && services.length && services.every((sv) => sv.startsWith("script:") || sv.startsWith("package:"))) {
		return commandBinding(command, candidate, services, cwd);
	}
	if (kind === "ops" && clauses.length === 1 && c[0] === "az" && !files.size && !c.some((x) => /[$`@]/.test(x)) && !opsProblem(command)) {
		return yes("일반 운영 명령 — 안쪽 안전 검사 필요");
	}
	if (kind === "plan") {
		return yes(`config/deploy-gate.json 등록 서비스(${services.join(", ")}) + 단계 명령 바이트·고정 파일 sha256 일치`);
	}
	if (rules.every((r) => r.allowCustomCommands === true)) {
		return yes(`config/deploy-gate.json allowCustomCommands 결합 확인 (${services.join(", ")})`, kind === "ops");
	}
	if (kind === "ops" && PINNED_SCRIPT_HEAD.test(command)) {
		return no("계획 고정 대본은 ops 로 받지 않음: 대본 본문이 판을 바꾸는지 관문이 판정할 수 없음. ops 준비 기록(deploy.json) 없이 계획 승인(PLAN·STEP 승인)으로 실행할 것");
	}
	return no("지원하지 않는 실행 형식: 명령에 후보가 있다는 문자열 포함 검사로 대체하지 않음");
}

/**
 * @returns {{ok:boolean, problems:string[], facts:string[], file?:string, kind?:string}}
 */
function assessReadiness(services, { root, auditPath, command = "", cwd = "", now = Date.now(), planBinding = null } = {}) {
	const baseRoot = root || process.env.DEPLOY_READINESS_ROOT || cwd || path.resolve(__dirname, "../../..");
	if (!Array.isArray(services) || services.length === 0) {
		return { ok: false, problems: ["운영 서비스 집합이 비어 있습니다."], facts: [] };
	}

	const cfg = loadDeployGateConfig(baseRoot);
	if (cfg) {
		const { validateReadOnlyScriptsConfig } = require("./deploy-plan.js");
		const roCfg = validateReadOnlyScriptsConfig(cfg);
		if (!roCfg.ok) return { ok: false, problems: [roCfg.why], facts: [] };
	}
	const found = findReadiness(services, baseRoot, now);

	if (!found) {
		if (!cfg) {
			return {
				ok: false,
				problems: [`알 수 없는 운영 명령은 막음: config/deploy-gate.json 설정 파일이 없습니다 (${services.join(", ")})`],
				facts: [],
			};
		}
		const rules = services.map((s) => matchServiceRule(s, cfg));
		const requiresReadiness = cfg.requireReadiness === true || rules.some((r) => r && r.requireReadiness === true);
		if (requiresReadiness || !planBinding) {
			return {
				ok: false,
				problems: [`배포 준비 기록이 없음: .agents/progress/<작업>/gates/deploy.json (12시간 안에 작성, services 에 다음 키를 그대로 적을 것)\n${services.map((s) => `  ${JSON.stringify(s)}`).join("\n")}`],
				facts: [],
			};
		}
		const planned = verifiedPlanBinding(planBinding, "", "plan", services, baseRoot);
		if (!planned.ok) return { ok: false, problems: [planned.why], facts: [] };
		return { ok: true, problems: [], facts: [planned.fact], kind: "plan" };
	}

	const rec = found.record;
	const problems = [];
	const facts = [];
	const rel = path.relative(baseRoot, found.file);
	if (!KINDS.has(rec.kind)) problems.push(`kind 는 feature, ops, rollback 가운데 하나여야 함(지금: ${rec.kind})`);
	const candidate = typeof rec.candidate === "string" ? rec.candidate.trim() : "";
	const planned = verifiedPlanBinding(planBinding, candidate, rec.kind, services, baseRoot);
	if (planned && !planned.ok) problems.push(planned.why);
	if (rec.kind !== "ops" && candidate.length < 7) problems.push("candidate(올릴 커밋 또는 이미지 태그)가 없음");

	if (rec.kind === "ops") {
		facts.push("시험 증거 없음 — 기능 공개가 아닌 운영 작업으로 신고됨");
		facts.push(`실제로 도는 명령: ${String(command).replace(/\s+/g, " ").slice(0, 1500)}`);
		if (!rec.reason || String(rec.reason).trim().length < 5) problems.push("ops 에는 reason(무엇을 왜 하는지 한 줄)이 필요함");
		else facts.push(`신고 사유: ${String(rec.reason).trim().slice(0, 200)}`);
	}

	if (rec.kind === "rollback" && candidate && !executedBefore(candidate, auditPath)) {
		let evidence = null;
		if (typeof rec.rollbackEvidence === "string" && rec.rollbackEvidence) {
			try {
				evidence = fs.readFileSync(resolveIn(baseRoot, rec.rollbackEvidence), "utf8");
			} catch {}
		}
		if (!evidence || !evidence.includes(candidate)) problems.push(`rollback 후보 ${candidate} 가 전에 운영에 올라간 증거가 없음(감사 기록이나 rollbackEvidence 파일, 예: az containerapp revision list 출력). 새 판이면 feature 로 신고해야 함`);
	}

	if (rec.kind === "ops") {
		if (planned?.ok && planned.readOnlyNoCode) {
			facts.push(planned.fact);
			const bad = opsProblem(command, { readOnlyTarget: planned.readOnlyTarget });
			if (bad) problems.push(bad);
			if (services.some((sv) => sv.startsWith("script:") || sv.startsWith("package:"))) problems.push("배포 스크립트는 코드를 올리므로 ops 로 신고할 수 없음");
		} else if (planned?.ok && planned.ops) {
			facts.push(planned.fact);
		} else {
			const opsCommand = planned?.opsCommand || command;
			const bad = opsProblem(opsCommand);
			if (bad) problems.push(bad);
			else if (innerScripts(opsCommand).length) facts.push("주의: VM·컨테이너 안에서 명령이 돈다. 위 실제 명령이 조회·진단·재시작뿐인지 확인할 것");
			if (services.some((sv) => sv.startsWith("script:") || sv.startsWith("package:"))) problems.push("배포 스크립트는 코드를 올리므로 ops 로 신고할 수 없음");
		}
	}
	if (KINDS.has(rec.kind) && rec.kind !== "ops" && candidate.length >= 7) {
		const bound = planBinding ? planned : commandBinding(command, candidate, services, cwd || baseRoot);
		if (!bound.ok) {
			if (!problems.includes(bound.why)) problems.push(bound.why);
		} else facts.push(bound.fact);
	}

	if (rec.kind === "feature" && candidate) {
		const receipts = Array.isArray(rec.et) ? rec.et : [];
		if (receipts.length === 0) problems.push("feature 에는 ET 영수증 경로(et)가 필요함");
		for (const p of receipts) {
			const f = resolveIn(baseRoot, p);
			let body = null;
			try {
				body = fs.readFileSync(f, "utf8");
			} catch {}
			if (body === null) {
				problems.push(`ET 영수증 파일이 없음: ${p}`);
				continue;
			}
			let et = null;
			try {
				et = JSON.parse(body);
			} catch {}
			const scenarios = et && Array.isArray(et.scenarios) ? et.scenarios : [];
			if (!et || et.kind !== "et") problems.push(`ET 영수증이 {"kind":"et","candidate":…,"scenarios":[{"id","verdict"}]} 모양의 JSON 이 아님: ${p}`);
			else if (!sameCommit(String(et.candidate || ""), candidate) && et.candidate !== candidate) problems.push(`ET 영수증의 candidate 가 후보 ${candidate} 와 다름: ${p}`);
			else if (scenarios.length === 0 || scenarios.some((sc) => !sc || typeof sc.id !== "string" || typeof sc.verdict !== "string")) problems.push(`ET 영수증에 시나리오(id, verdict)가 없거나 모양이 틀림: ${p}`);
			else {
				const failed = scenarios.filter((sc) => sc.verdict !== "pass");
				if (failed.length) problems.push(`ET 영수증에 통과 못 한 시나리오 ${failed.length}건(${failed.slice(0, 5).map((sc) => `${sc.id}=${sc.verdict}`).join(", ")}): ${p}. 결함을 고치거나 되돌리기·숨김을 먼저 할 것`);
				facts.push(`ET 영수증 ${p}: 시나리오 ${scenarios.length}건, 통과 ${scenarios.length - failed.length}건 (${scenarios.slice(0, 20).map((sc) => sc.id).join(", ")}${scenarios.length > 20 ? " …" : ""})`);
			}
		}
		if (!rec.testGate) problems.push("feature 에는 시험 검수 기록(testGate: gates/test.json 경로, ET 를 돌리지 않은 창이 통과시킨 것)이 필요함");
		else problems.push(...checkTestGate(resolveIn(baseRoot, rec.testGate), candidate));
		if (!rec.codeGate) problems.push("feature 에는 코드 검수 기록(codeGate: gates/code.json 경로)이 필요함");
		else {
			const cg = checkCodeGate(resolveIn(baseRoot, rec.codeGate), candidate, now);
			problems.push(...cg.problems);
			if (cg.reviewer) facts.push(`코드 검수자: ${cg.reviewer}`);
			if (cg.lintSummary) {
				const by = cg.lintSummary.byClass && typeof cg.lintSummary.byClass === "object" ? Object.entries(cg.lintSummary.byClass).map(([k, v]) => `${k} ${v}`).join(", ") : "";
				facts.push(`화면 문구 검사: 발견 ${cg.lintSummary.findings ?? "?"}건${by ? ` (${by})` : ""}. 발견마다 코드 검수 기록에 처리가 적혀 있어야 함`);
			}
		}
		if (rec.uiGate) {
			const ug = readJson(resolveIn(baseRoot, rec.uiGate));
			if (!ug || ug.stage !== "ui" || ug.verdict !== "pass") problems.push(`화면 검수 기록(uiGate)이 stage ui, verdict pass 가 아님: ${rec.uiGate}`);
			else facts.push(`화면 검수: 통과 (${rec.uiGate})`);
		} else facts.push("화면 검수 기록(uiGate) 없음 — 사용자 편의·상위기획 의도·내부 문구 판정을 받지 않은 배포");
		for (const s of services) {
			const open = openCriticalDefects(s, baseRoot);
			facts.push(defectFact(s, baseRoot, open));
			if (open.length) problems.push(`${s} 에 열린 치명 결함 ${open.length}건(${open.map((d) => d.id).join(", ")}). 기능 배포 전에 되돌리기(kind rollback)나 메뉴 숨김(kind ops)으로 먼저 막을 것`);
		}
	}

	if (rec.kind !== "feature") {
		for (const s of services) {
			const open = openCriticalDefects(s, baseRoot);
			facts.push(defectFact(s, baseRoot, open));
			if (rec.kind === "rollback" && candidate) {
				const hit = open.filter((d) => defectVersions(d).some((v) => v === candidate || sameCommit(v, candidate) || (v.length >= 7 && (v.includes(candidate) || candidate.includes(v)))));
				if (hit.length) problems.push(`rollback 후보 ${candidate} 에 열린 치명 결함이 있음(${hit.map((d) => d.id).join(", ")}). 결함 없는 판으로 되돌리거나 메뉴 숨김(kind ops)으로 먼저 막을 것`);
			}
		}
	}

	facts.unshift(`배포 종류: ${rec.kind}${candidate ? `, 후보 ${candidate}` : ""}${rec.currentProd ? `, 지금 운영 ${rec.currentProd}` : ""} (기록 ${rel})`);
	if (rec.currentProd) {
		for (const sv of services) {
			const last = lastExecutedFor(sv, auditPath);
			if (!last) facts.push(`${sv}: 지금 운영 ${rec.currentProd} 확인 안 됨(감사 기록에 이 서비스 배포가 없음). 직접 확인할 것`);
			else if (!String(last.command || "").includes(rec.currentProd)) facts.push(`${sv}: 지금 운영 ${rec.currentProd} 확인 안 됨. 감사 기록의 마지막 배포(${last.ts || "?"})는 다른 판: ${String(last.command || "").slice(0, 200)}`);
			else facts.push(`${sv}: 지금 운영 ${rec.currentProd} 는 감사 기록의 마지막 배포와 같음`);
		}
	}
	if (!rec.repo && rec.kind !== "ops") facts.push("변경 목록 없음(repo 가 기록에 없음). 무엇이 함께 올라가는지 계산하지 못했음");
	if (rec.repo && candidate) {
		const repo = resolveIn(baseRoot, rec.repo);
		try {
			const inMain = (() => {
				for (const m of ["origin/main", "main"]) {
					try {
						git(repo, ["merge-base", "--is-ancestor", candidate, m]);
						return m;
					} catch {}
				}
				return null;
			})();
			facts.push(inMain ? `후보는 ${inMain} 에 들어 있음` : "후보가 main 에 없음(가지에서 바로 올림)");
			if (rec.currentProd) {
				const stat = git(repo, ["diff", "--stat=100", `${rec.currentProd}`, candidate]).trim().split("\n");
				facts.push(`지금 운영 → 후보 변경 파일(${stat.length - 1}개):`);
				facts.push(...stat.slice(0, 40).map((l) => `  ${l}`));
				if (stat.length > 40) facts.push(`  … ${stat.length - 40}줄 더`);
			} else facts.push("currentProd 가 없어 변경 목록을 계산하지 못함");
		} catch (e) {
			facts.push(`변경 목록 계산 실패: ${String(e.message || e).split("\n")[0]}`);
		}
	}
	const readOnlyNoCode = problems.length === 0 && rec.kind === "ops" && !!(planned && planned.ok && planned.readOnlyNoCode === true);
	return { ok: problems.length === 0, problems, facts, file: found.file, kind: rec.kind, ...(readOnlyNoCode ? { readOnlyNoCode: true } : {}) };
}

const TEMPLATE = {
	services: ["azure:containerapp:my-app-prod"],
	kind: "feature | ops | rollback",
	candidate: "<올릴 커밋 해시 또는 이미지 태그. 명령 글자에 들어가야 함(배포 스크립트면 그 저장소 HEAD)>",
	currentProd: "<운영 서비스 조회로 확인한 지금 운영 태그>",
	repo: "projects/my-app",
	et: [".agents/progress/<작업>/et/<receipt>.json  (모양: {\"kind\":\"et\",\"candidate\":…,\"scenarios\":[{\"id\":…,\"verdict\":\"pass\"}]})"],
	testGate: ".agents/progress/<작업>/gates/test.json (stage test, ET 를 돌리지 않은 검수자)",
	codeGate: ".agents/progress/<작업>/gates/code.json",
	uiGate: "(권장) .agents/progress/<작업>/gates/ui.json — 없으면 안내에 '화면 검수 없음'이 찍힘",
	reason: "(ops 일 때) 무엇을 왜 하는지 한 줄. ops 는 설정만 바꾸는 명령(환경 변수·복제 수·재시작·리비전 끄기)에만",
	rollbackEvidence: "(rollback 이고 감사 기록에 없을 때) 이전 리비전 목록 출력 파일",
	createdAt: "<ISO 시각>",
};

module.exports = {
	assessReadiness,
	verifiedPlanBinding,
	findReadiness,
	openCriticalDefects,
	executedBefore,
	commandBinding,
	loadDeployGateConfig,
	loadDeployGatePlugin,
	matchServiceRule,
	deployGateConfigPath,
	tryCanonicalTargetPath,
	canonicalTargetPath,
	hasDeployPlanMarker,
	findPolicyRootForPath,
	inspectDeployPolicyErrors,
	VERSION_CHANGE,
	CONFIG_ONLY,
	INNER_OPAQUE,
	innerProblem,
	opsAzProblem,
	opsProblem,
	TEMPLATE,
};
