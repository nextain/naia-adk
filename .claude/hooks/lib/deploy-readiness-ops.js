// Existing readiness ops responsibility; behavior is owned by the public facade.
const path = require("path");
const { stripReserved, SHELLS, SHELL_ALT } = require("./effective-argv.js");

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

module.exports = { VERSION_CHANGE, CONFIG_ONLY, INNER_OPAQUE, INNER_READ, READ_WRITE_LONG, READ_WRITE_SHORT, READ_WRITE_FULL, READ_SUBCOMMAND, READ_VALUE_SHORT, READ_VALUE_LONG, READ_VALUE_PREFIX, READ_VALUE_FULL, readCommandWrites, INNER_SYSTEMCTL, INNER_DOCKER, INNER_COMPOSE, CURL_WRITE, innerClauseProblem, opsClauses, remotePayload, innerScripts, innerProblem, OPS_AZ_VERBS, OPS_AZ_VERB_FLAGS, OPS_AZ_FLAGS, opsAzProblem, opsProblem };
