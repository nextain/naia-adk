// Existing readiness plan-binding responsibility; behavior is owned by the public facade.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { opsProblem } = require("./deploy-readiness-ops.js");
const { loadDeployGateConfig, loadDeployGatePlugin, matchServiceRule } = require("./deploy-readiness-policy.js");
const { commandBinding } = require("./deploy-readiness-evidence.js");
const { PINNED_SCRIPT_HEAD, matchReadOnlyScriptBinding } = require("./deploy-readiness-script-binding.js");

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
		const pluginRes = plugin.verifyPlanBinding({ plan, entry, command, candidate, kind, services, cwd, root, config: cfg, files, gatesDir: planBinding.gatesDir });
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
			const res = plugin.assessService(s, { plan, entry, command, candidate, kind, services, cwd, root, config: cfg, files, gatesDir: planBinding.gatesDir });
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

module.exports = { verifiedPlanBinding };
