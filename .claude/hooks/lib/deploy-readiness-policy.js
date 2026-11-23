// Existing readiness policy responsibility; behavior is owned by the public facade.
const fs = require("fs");
const path = require("path");
const { readJson } = require("./deploy-readiness-io.js");

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
 const pinned = require("./deploy-plan-context.js").policyData(path.join(root || process.env.DEPLOY_READINESS_ROOT || path.resolve(__dirname, "../../.."), "config/deploy-gate.json"));
 if(pinned) return JSON.parse(pinned.toString("utf8"));
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
 const context=require("./deploy-plan-context.js"),registered=context.gateConfigView.getStore()?.registeredSourceRoot;
 if(registered){const relative=path.relative(registered,path.resolve(base)),inside=!relative||relative!==".."&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative);if(inside&&!context.policyData(pluginPath))throw new Error("Unregistered plugin source: "+pluginPath);}
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

module.exports = { probePathError, tryCanonicalTargetPath, canonicalTargetPath, hasDeployPlanMarker, findPolicyRootForPath, checkJsonObjectFile, inspectDeployPolicyErrors, deployGateConfigPath, loadDeployGateConfig, loadDeployGatePlugin, globMatch, matchServiceRule };
