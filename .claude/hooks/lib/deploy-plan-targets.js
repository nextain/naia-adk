"use strict";
// Plan gate responsibility: targets.
const path = require("path");
const fs = require("fs");
const { ROOT, readTargetFile, sha256 } = require("./deploy-plan-common.js");
const {planCommandEntries}=require("./deploy-plan-commands.js");
const { directCommandScriptPaths } = require("./deploy-plan-readonly-policy.js");

function targetTransitions(pin, plan, base) {
	const transitions = new Map();
	if (pin.transitions === undefined) return transitions;
	if (!pin.transitions || typeof pin.transitions !== "object" || Array.isArray(pin.transitions)) throw new Error(`invalid target transitions: ${pin.path}`);
	const scenario = Array.isArray(plan.scenario) ? plan.scenario : [];
	for (const [id, spec] of Object.entries(pin.transitions)) {
		const step = scenario.find(s => s?.id === id);
		if (!step || !spec || !["before", "after"].includes(spec.to) ||
			(spec.resume !== undefined && typeof spec.resume !== "boolean") ||
			Object.keys(spec).some(k => !["to", "partial_after", "resume"].includes(k))) {
			throw new Error(`invalid target transition: ${pin.path} / ${id}`);
		}
		const from = pin[spec.to === "after" ? "before" : "after"];
		const targetPath = path.resolve(base, pin.path);
		const matching = Object.entries(step.files || {}).filter(([file]) => path.resolve(base, file) === targetPath);
		if (matching.length !== 1 || String(matching[0][1]).toLowerCase() !== from || pin.before === pin.after) throw new Error(`target transition needs its exact preimage in step.files: ${pin.path} / ${id}`);
		if (spec.partial_after !== undefined) {
			const forward = scenario.find(s => s?.id === spec.partial_after);
			if (spec.to !== "before" || step.branch !== "rollback" || !forward || forward.branch === "rollback" ||
				scenario.indexOf(forward) >= scenario.indexOf(step) || pin.transitions[forward.id]?.to !== "after" ||
				!Array.isArray(forward.commands) || !forward.commands.length) {
				throw new Error(`invalid partial rollback source: ${pin.path} / ${id}`);
			}
		}
		transitions.set(id, { to: pin[spec.to] });
	}
	return transitions;
}

function targetDeclarations(plan) {
	const config = plan?.file_pins;
	if (config === undefined) return [];
	let declarations = config;
	if (config && typeof config === "object" && !Array.isArray(config)) {
		if ("role" in config || "path" in config) throw new Error("target file_pins must be an array or targets array");
		declarations = config.targets === undefined ? [] : config.targets;
	}
	if (!Array.isArray(declarations)) throw new Error("file_pins targets must be an array");
	return declarations;
}

function targetPins(plan, root) {
	const base = root ? path.resolve(root) : ROOT;
	const pins = new Map(), liveFiles = new Set(), sources = new Set();
	for (const item of targetDeclarations(plan)) {
		if (!item || item.role !== "target" ||
			![item.path, item.before_source, item.after_source].every(p => typeof p === "string" && p.trim() && !/[\0\r\n]/.test(p)) ||
			![item.before, item.after].every(h => typeof h === "string" && /^[a-f0-9]{64}$/i.test(h))) {
			throw new Error("invalid target file_pins entry");
		}
		const pin = { ...item, before: item.before.toLowerCase(), after: item.after.toLowerCase() };
		const abs = path.resolve(base, pin.path);
		const live = readTargetFile(base, pin.path);
		if (liveFiles.has(live.identity)) throw new Error(`duplicate target pin: ${pin.path}`);
		const before = readTargetFile(base, pin.before_source), after = readTargetFile(base, pin.after_source);
		if (live.digest !== pin.before && live.digest !== pin.after) throw new Error(`target sha256 mismatch: ${pin.path}`);
		if (before.digest !== pin.before || after.digest !== pin.after) throw new Error(`target source sha256 mismatch: ${pin.path}`);
		liveFiles.add(live.identity);
		sources.add(before.identity);
		sources.add(after.identity);
		pins.set(abs, { ...pin, current: live.digest, beforeBody: before.body, afterBody: after.body, transitions: targetTransitions(pin, plan, base) });
	}
	for (const identity of liveFiles) if (sources.has(identity)) throw new Error("target sources must be independent of all live targets");
	return pins;
}

function verifyTargetPreconditions(plan, root, entry) {
	const targets = targetPins(plan, root);
	for (const [file, want] of Object.entries(entry.files || {})) {
		const target = targets.get(path.resolve(root, file));
		const expected = String(want).toLowerCase();
		if (target && target.current !== expected) {
			throw new Error(`${entry.id} 단계의 대상 시작 지문 불일치: ${file} (계획 ${expected}, 현재 ${target.current}). 대상별 현재 상태와 단계 결과를 확인하십시오. 복구하려면 현재 지문과 일치하는 검수된 단계를 사용하십시오. 해당 단계가 없으면 복구 계획을 새로 검수받으십시오.`);
		}
	}
	return targets;
}

function verifyTargetResults(plan, root, stepId) {
	for (const target of targetPins(plan, root).values()) {
		const result = target.transitions.get(stepId);
		if (result && target.current !== result.to) throw new Error(`target postimage mismatch: ${target.path} / ${stepId}`);
	}
}

/** 계획서 소속 저장소 root 기준. 모든 단계와 선조치의 고정 파일을 검사한다. */
function pinnedFileProblems(plan, root) {
	const base = root ? path.resolve(root) : ROOT;
	const problems = [];
	let targets;
	try { targets = targetPins(plan, base); } catch (e) { return [String(e.message)]; }
	for (const {entry} of planCommandEntries(plan)) {
		if (!entry) continue;
		const pinnedAbs = new Map();
		if (entry.files !== undefined) {
			if (!entry.files || typeof entry.files !== "object" || Array.isArray(entry.files)) { problems.push(`${entry.id}: files 는 경로와 sha256 사전이어야 함`); continue; }
			for (const [file, want] of Object.entries(entry.files)) {
				try {
					const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(base, file);
					const target = targets.get(abs);
					const actual = target ? target.current : sha256(fs.readFileSync(abs));
					const expected = String(want).toLowerCase();
					const matches = target ? expected === target.before || expected === target.after : actual === expected;
					if (!/^[a-f0-9]{64}$/.test(expected) || !fs.statSync(abs).isFile() || !matches) problems.push(`${entry.id}: 고정 파일 sha256 불일치: ${file}`);
					else pinnedAbs.set(abs, actual);
				} catch { problems.push(`${entry.id}: 고정 파일을 읽지 못함: ${file}`); }
			}
		}
		for (const cmd of Array.isArray(entry.commands) ? entry.commands : []) {
			for (const scriptAbs of directCommandScriptPaths(cmd, base)) {
				if (!pinnedAbs.has(scriptAbs)) {
					const rel = path.relative(base, scriptAbs).split(path.sep).join("/");
					problems.push(`${entry.id}: 실행 대본이 files 에 고정되지 않음(리뷰어가 본문을 볼 수 있도록 경로·sha256 를 files 에 적어야 함): ${rel}`);
				}
			}
		}
	}
	return problems;
}

/** 단계·선조치의 files 에 고정한 파일(감싼 스크립트 등)의 글. 검수자가 명령 바깥 글만 보고 PASS 하지 않게 한다. */
function pinnedFilesText(plan, root) {
	const base = root ? path.resolve(root) : ROOT;
	let targets;
	try { targets = targetPins(plan, base); } catch (e) { return [`대상 파일 검사 실패: ${e.message}. PASS 하지 마십시오`]; }
	const entries = planCommandEntries(plan).map(row=>row.entry).filter((x) => x && x.files && typeof x.files === "object");
	if (!entries.length && !targets.size) return [];
	const L = ["고정 파일(명령이 읽거나 실행하는 파일, 훅이 sha 로 대조):"];
	for (const target of targets.values()) {
		for (const [label, digest, body] of [["before", target.before, target.beforeBody], ["after", target.after, target.afterBody]]) {
			L.push(`- ${target.path} ${label} (sha ${digest}):`, "```", body.length > 200 * 1024 ? `${body.subarray(0, 200 * 1024).toString("utf8")}\n…(200KB 넘어 잘림: 잘린 파일은 FAIL)` : body.toString("utf8"), "```");
		}
	}
	const shown = new Set();
	for (const x of entries) {
		for (const [p, want] of Object.entries(x.files)) {
			if (targets.has(path.resolve(base, p))) continue;
			const key = `${p}\0${String(want).toLowerCase()}`;
			if (shown.has(key)) {
				L.push(`- ${x.id} ${p} (sha ${want}): 위에 같은 sha 로 이미 실음`);
				continue;
			}
			shown.add(key);
			const abs = path.resolve(base, p);
			let body = null;
			try {
				body = fs.readFileSync(abs);
			} catch {}
			if (!body) L.push(`- ${x.id} ${p}: 파일 없음(이 상태로는 PASS 하지 마십시오)`);
			else if (sha256(body) !== String(want).toLowerCase()) L.push(`- ${x.id} ${p}: sha 다름(계획서 ${want}, 실제 ${sha256(body)}). PASS 하지 마십시오`);
			else L.push(`- ${x.id} ${p} (sha ${want}):`, "```", body.length > 200 * 1024 ? `${body.subarray(0, 200 * 1024).toString("utf8")}\n…(200KB 넘어 잘림: 잘린 파일은 FAIL)` : body.toString("utf8"), "```");
		}
	}
	return L;
}

module.exports = {
	targetTransitions,
	targetDeclarations,
	targetPins,
	verifyTargetPreconditions,
	verifyTargetResults,
	pinnedFileProblems,
	pinnedFilesText,
};
